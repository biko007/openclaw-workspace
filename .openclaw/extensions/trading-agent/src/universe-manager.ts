import { IBKRConnection, type ScannerResult } from "./ibkr.js";
import { CONSTITUENT_MAP } from "./constituents.js";
import {
  loadUniverse,
  saveUniverse,
  loadUniverseConfig,
  appendScanResult,
  loadRecentScanResults,
  type UniverseSymbol,
  type UniverseConfig,
  type ScanResult,
  type UniverseData,
} from "./store.js";

const INDEX_SCANNER_CONFIG: Record<string, { locationCode: string; currency: string }> = {
  DAX40: { locationCode: "STK.EU.IBIS-XETRA", currency: "EUR" },
  MDAX: { locationCode: "STK.EU.IBIS-XETRA", currency: "EUR" },
  SP500: { locationCode: "STK.US.MAJOR", currency: "USD" },
  NASDAQ100: { locationCode: "STK.US.MAJOR", currency: "USD" },
};

export class UniverseManager {
  private ibkr: IBKRConnection;
  private scheduleTimer: ReturnType<typeof setInterval> | null = null;
  private lastBuildHour = -1;
  private lastMomentumMin = -1;
  private lastMeanRevMin = -1;

  constructor(ibkr: IBKRConnection) {
    this.ibkr = ibkr;
  }

  // ── Build Active Universe ──

  async buildActiveUniverse(): Promise<UniverseData> {
    console.log("[universe] Building active universe...");
    const config = loadUniverseConfig();
    const allSymbols: UniverseSymbol[] = [];

    for (const [indexName, indexCfg] of Object.entries(config.indices)) {
      if (!indexCfg.enabled) continue;
      const components = await this.loadIndexComponents(indexName, config);
      allSymbols.push(...components);
    }

    // Deduplicate by symbol
    const seen = new Set<string>();
    const unique = allSymbols.filter((s) => {
      const key = `${s.symbol}:${s.exchange}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Apply liquidity filter
    const filtered = unique.filter((s) => {
      if (s.avgVolume > 0 && s.avgVolume < config.liquidityFilter.minAvgVolume) return false;
      if (s.marketCap > 0 && s.marketCap < config.liquidityFilter.minMarketCap) return false;
      return true;
    });

    // Limit to max universe size
    const limited = filtered.slice(0, config.maxUniverseSize);

    const data: UniverseData = {
      symbols: limited,
      lastBuild: new Date().toISOString(),
      totalScanned: allSymbols.length,
    };

    saveUniverse(data);
    console.log(`[universe] Built universe: ${limited.length} symbols (scanned ${allSymbols.length}, filtered ${unique.length - limited.length})`);
    return data;
  }

  async loadIndexComponents(indexName: string, config: UniverseConfig): Promise<UniverseSymbol[]> {
    const scannerCfg = INDEX_SCANNER_CONFIG[indexName];
    if (!scannerCfg) return this.fallbackComponents(indexName);

    const indexCfg = config.indices[indexName];
    if (!this.ibkr.isConnected()) {
      console.log(`[universe] IBKR not connected, using fallback for ${indexName}`);
      return this.fallbackComponents(indexName);
    }

    try {
      const results = await this.ibkr.reqScannerSubscription({
        instrument: "STK",
        locationCode: scannerCfg.locationCode,
        scanCode: "MARKET_CAP_USD_DESC",
        numberOfRows: indexName === "DAX40" || indexName === "MDAX" ? 50 : 100,
        abovePrice: 5,
      });

      if (results.length === 0) {
        console.log(`[universe] Scanner returned 0 results for ${indexName}, using fallback`);
        return this.fallbackComponents(indexName);
      }

      return results.map((r) => ({
        symbol: r.symbol,
        exchange: r.exchange || indexCfg?.exchange || scannerCfg.locationCode,
        currency: r.currency || indexCfg?.currency || scannerCfg.currency,
        marketCap: 0,
        avgVolume: 0,
        index: indexName,
      }));
    } catch (e) {
      console.log(`[universe] Scanner error for ${indexName}:`, e);
      return this.fallbackComponents(indexName);
    }
  }

  private fallbackComponents(indexName: string): UniverseSymbol[] {
    const symbols = CONSTITUENT_MAP[indexName];
    if (!symbols) return [];
    const scannerCfg = INDEX_SCANNER_CONFIG[indexName];
    return symbols.map((symbol) => ({
      symbol,
      exchange: scannerCfg?.locationCode.includes("IBIS") ? "IBIS" : "SMART",
      currency: scannerCfg?.currency || "USD",
      marketCap: 0,
      avgVolume: 0,
      index: indexName,
    }));
  }

  // ── Intraday Scanners ──

  async scanMomentum(): Promise<ScanResult[]> {
    const universe = loadUniverse();
    if (universe.symbols.length === 0) return [];
    const universeSet = new Set(universe.symbols.map((s) => s.symbol));
    const results: ScanResult[] = [];

    for (const location of ["STK.US.MAJOR", "STK.EU.IBIS-XETRA"]) {
      if (!this.ibkr.isConnected()) break;
      try {
        const gainers = await this.ibkr.reqScannerSubscription({
          instrument: "STK",
          locationCode: location,
          scanCode: "TOP_PERC_GAIN",
          numberOfRows: 30,
          abovePrice: 5,
          aboveVolume: 100_000,
        });

        for (const r of gainers) {
          if (universeSet.has(r.symbol)) {
            const sr: ScanResult = {
              symbol: r.symbol,
              signal: "MOMENTUM_UP",
              strength: 30 - r.rank,
              timestamp: new Date().toISOString(),
            };
            results.push(sr);
            appendScanResult(sr);
          }
        }
      } catch (e) {
        console.log(`[universe] Momentum scan error (${location}):`, e);
      }
    }

    if (results.length > 0) {
      console.log(`[universe] Momentum scan: ${results.length} signals`);
    }
    return results;
  }

  async scanMeanReversion(): Promise<ScanResult[]> {
    const universe = loadUniverse();
    if (universe.symbols.length === 0) return [];
    const universeSet = new Set(universe.symbols.map((s) => s.symbol));
    const results: ScanResult[] = [];

    for (const location of ["STK.US.MAJOR", "STK.EU.IBIS-XETRA"]) {
      if (!this.ibkr.isConnected()) break;
      try {
        const losers = await this.ibkr.reqScannerSubscription({
          instrument: "STK",
          locationCode: location,
          scanCode: "TOP_PERC_LOSE",
          numberOfRows: 30,
          abovePrice: 5,
          aboveVolume: 100_000,
        });

        for (const r of losers) {
          if (universeSet.has(r.symbol)) {
            const sr: ScanResult = {
              symbol: r.symbol,
              signal: "MEAN_REVERSION",
              strength: 30 - r.rank,
              timestamp: new Date().toISOString(),
            };
            results.push(sr);
            appendScanResult(sr);
          }
        }
      } catch (e) {
        console.log(`[universe] Mean reversion scan error (${location}):`, e);
      }
    }

    if (results.length > 0) {
      console.log(`[universe] Mean reversion scan: ${results.length} signals`);
    }
    return results;
  }

  // ── Scheduling ──

  startSchedule(): void {
    if (this.scheduleTimer) return;
    console.log("[universe] Schedule started");

    this.scheduleTimer = setInterval(() => {
      this.tick().catch((e) => console.error("[universe] Tick error:", e));
    }, 60_000);
  }

  stopSchedule(): void {
    if (this.scheduleTimer) {
      clearInterval(this.scheduleTimer);
      this.scheduleTimer = null;
      console.log("[universe] Schedule stopped");
    }
  }

  private async tick(): Promise<void> {
    const now = new Date();
    const utcHour = now.getUTCHours();
    const utcMin = now.getUTCMinutes();

    // Daily universe build at 07:00 UTC
    if (utcHour === 7 && this.lastBuildHour !== utcHour) {
      this.lastBuildHour = utcHour;
      await this.buildActiveUniverse();
    }

    // Reset at midnight
    if (utcHour === 0) {
      this.lastBuildHour = -1;
    }

    // Intraday scans only during market hours and if connected
    if (!this.ibkr.isConnected()) return;

    const euOpen = utcHour >= 7 && (utcHour < 15 || (utcHour === 15 && utcMin <= 30));
    const usOpen = utcHour >= 14 && (utcHour < 21 || (utcHour === 20 && utcMin <= 59));
    const marketOpen = euOpen || usOpen;
    if (!marketOpen) return;

    // Momentum scan every 5 minutes
    const fiveMinSlot = Math.floor(utcMin / 5);
    if (fiveMinSlot !== this.lastMomentumMin) {
      this.lastMomentumMin = fiveMinSlot;
      await this.scanMomentum();
    }

    // Mean reversion scan every 15 minutes
    const fifteenMinSlot = Math.floor(utcMin / 15);
    if (fifteenMinSlot !== this.lastMeanRevMin) {
      this.lastMeanRevMin = fifteenMinSlot;
      await this.scanMeanReversion();
    }
  }

  // ── Helpers ──

  isMarketOpen(market: "EU" | "US"): boolean {
    const now = new Date();
    const utcHour = now.getUTCHours();
    const utcMin = now.getUTCMinutes();
    if (market === "EU") return utcHour >= 7 && (utcHour < 15 || (utcHour === 15 && utcMin <= 30));
    return utcHour >= 14 && utcHour < 21;
  }

  getTopCandidates(limit = 10): ScanResult[] {
    const results = loadRecentScanResults(200);
    // Deduplicate, keep latest per symbol
    const latest = new Map<string, ScanResult>();
    for (const r of results) {
      const existing = latest.get(r.symbol);
      if (!existing || r.timestamp > existing.timestamp) {
        latest.set(r.symbol, r);
      }
    }
    // Only results from last 2 hours
    const cutoff = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    return Array.from(latest.values())
      .filter((r) => r.timestamp >= cutoff)
      .sort((a, b) => b.strength - a.strength)
      .slice(0, limit);
  }
}
