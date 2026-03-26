import YahooFinance from "yahoo-finance2";
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

const yahooFinance = new YahooFinance({
  validation: { logErrors: false },
  suppressNotices: ["yahooSurvey"],
});

export class UniverseManager {
  private ibkr: IBKRConnection;
  private scheduleTimer: ReturnType<typeof setInterval> | null = null;
  private lastBuildHour = -1;
  private lastMomentumMin = -1;
  private lastMeanRevMin = -1;
  onMomentumScan: ((results: ScanResult[]) => Promise<void>) | null = null;

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

  async loadIndexComponents(indexName: string, _config: UniverseConfig): Promise<UniverseSymbol[]> {
    // IBKR scanner is disabled on paper accounts - use static constituent lists directly
    return this.fallbackComponents(indexName);
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

  // ── Yahoo Finance Quote Fetching ──

  private async fetchYahooQuotes(symbols: UniverseSymbol[]): Promise<Map<string, { changePct: number; volume: number; price: number }>> {
    const quotes = new Map<string, { changePct: number; volume: number; price: number }>();
    // Yahoo tickers: EU stocks need exchange suffix
    const tickerMap = new Map<string, string>(); // yahoo ticker → original symbol
    for (const s of symbols) {
      let ticker = s.symbol;
      if (s.currency === "EUR") {
        // XETRA stocks: append .DE
        ticker = `${s.symbol}.DE`;
      }
      tickerMap.set(ticker, s.symbol);
    }

    const tickers = Array.from(tickerMap.keys());
    // Batch in chunks of 40 to avoid rate limits
    const CHUNK = 40;
    for (let i = 0; i < tickers.length; i += CHUNK) {
      const chunk = tickers.slice(i, i + CHUNK);
      try {
        const results: any = await yahooFinance.quote(chunk);
        const arr: any[] = Array.isArray(results) ? results : [results];
        for (const q of arr) {
          if (!q || !q.symbol) continue;
          const origSymbol = tickerMap.get(q.symbol) || q.symbol.replace(/\.DE$/, "");
          const changePct: number = q.regularMarketChangePercent ?? 0;
          const volume: number = q.regularMarketVolume ?? 0;
          const price: number = q.regularMarketPrice ?? 0;
          quotes.set(origSymbol, { changePct, volume, price });
        }
      } catch (e) {
        console.log(`[universe] Yahoo quote batch error (chunk ${i}):`, e instanceof Error ? e.message : e);
      }
      // Small delay between chunks
      if (i + CHUNK < tickers.length) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    return quotes;
  }

  // ── Intraday Scanners ──

  async scanMomentum(): Promise<ScanResult[]> {
    const universe = loadUniverse();
    if (universe.symbols.length === 0) return [];
    const results: ScanResult[] = [];

    try {
      const quotes = await this.fetchYahooQuotes(universe.symbols);
      // Sort by % change descending → top gainers = momentum
      const sorted = Array.from(quotes.entries())
        .filter(([, q]) => q.changePct > 1.0 && q.volume > 50_000 && q.price > 5)
        .sort((a, b) => b[1].changePct - a[1].changePct)
        .slice(0, 20);

      for (const [symbol, q] of sorted) {
        const sr: ScanResult = {
          symbol,
          signal: "MOMENTUM_UP",
          strength: Math.round(q.changePct * 10) / 10,
          timestamp: new Date().toISOString(),
        };
        results.push(sr);
        appendScanResult(sr);
      }
    } catch (e) {
      console.log("[universe] Yahoo momentum scan error:", e instanceof Error ? e.message : e);
    }

    console.log(`[universe] Momentum scan: ${results.length} signals (Yahoo Finance)`);
    return results;
  }

  async scanMeanReversion(): Promise<ScanResult[]> {
    const universe = loadUniverse();
    if (universe.symbols.length === 0) return [];
    const results: ScanResult[] = [];

    try {
      const quotes = await this.fetchYahooQuotes(universe.symbols);
      // Sort by % change ascending → top losers = mean reversion candidates
      const sorted = Array.from(quotes.entries())
        .filter(([, q]) => q.changePct < -1.0 && q.volume > 50_000 && q.price > 5)
        .sort((a, b) => a[1].changePct - b[1].changePct)
        .slice(0, 20);

      for (const [symbol, q] of sorted) {
        const sr: ScanResult = {
          symbol,
          signal: "MEAN_REVERSION",
          strength: Math.round(Math.abs(q.changePct) * 10) / 10,
          timestamp: new Date().toISOString(),
        };
        results.push(sr);
        appendScanResult(sr);
      }
    } catch (e) {
      console.log("[universe] Yahoo mean reversion scan error:", e instanceof Error ? e.message : e);
    }

    console.log(`[universe] Mean reversion scan: ${results.length} signals (Yahoo Finance)`);
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

    // Intraday scans during market hours (Yahoo Finance doesn't need IBKR connection)
    const euOpen = utcHour >= 7 && (utcHour < 15 || (utcHour === 15 && utcMin <= 30));
    const usOpen = utcHour >= 14 && (utcHour < 21 || (utcHour === 20 && utcMin <= 59));
    const marketOpen = euOpen || usOpen;
    if (!marketOpen) return;

    // Momentum scan every 5 minutes
    const fiveMinSlot = Math.floor(utcMin / 5);
    if (fiveMinSlot !== this.lastMomentumMin) {
      this.lastMomentumMin = fiveMinSlot;
      const momentum = await this.scanMomentum();
      if (momentum.length > 0 && this.onMomentumScan) {
        await this.onMomentumScan(momentum).catch((e) =>
          console.error("[universe] Post-scan execution error:", e),
        );
      }
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
