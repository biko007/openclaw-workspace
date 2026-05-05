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
import {
  fetchOHLCV,
  computeIndicators,
  checkMomentumSignal,
  checkMeanReversionSignal,
  isMarketSafe,
  confirmMultiTimeframe,
  collectDebugStats,
  type IndicatorValues,
  type ScanDebugStats,
} from "./indicators.js";
import { getBlockedSymbols, getPostEarningsSymbols } from "./earnings-calendar.js";

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
  private _lastDebugStats: ScanDebugStats | null = null;
  onMomentumScan: ((results: ScanResult[]) => Promise<void>) | null = null;
  onScanComplete: ((info: { momentum: number; meanReversion: number }) => void) | null = null;

  get lastDebugStats(): ScanDebugStats | null {
    return this._lastDebugStats;
  }

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
    const allIndicators: IndicatorValues[] = []; // collect for debug stats

    // Market safety check
    const safety = await isMarketSafe();
    if (!safety.safe) {
      console.log(`[universe] Momentum scan skipped: ${safety.reason}`);
      return [];
    }

    try {
      // Pre-filter with quotes: price > $5, volume > 50k, positive day
      const quotes = await this.fetchYahooQuotes(universe.symbols);
      const candidates = Array.from(quotes.entries())
        .filter(([, q]) => q.changePct > 0.5 && q.volume > 50_000 && q.price > 5)
        .sort((a, b) => b[1].changePct - a[1].changePct)
        .slice(0, 30); // Limit API calls

      // Filter out earnings-blocked symbols
      const blocked = new Set(getBlockedSymbols());
      const preEarningsCount = candidates.length;
      const filteredCandidates = candidates.filter(([symbol]) => !blocked.has(symbol));
      if (filteredCandidates.length < preEarningsCount) {
        console.log(`[universe] Earnings filter: removed ${preEarningsCount - filteredCandidates.length} symbols with upcoming earnings`);
      }

      console.log(`[universe] Momentum pre-filter: ${filteredCandidates.length} candidates from ${quotes.size} symbols`);

      // Analyze each candidate with technical indicators
      for (const [symbol, q] of filteredCandidates) {
        try {
          const yahooSymbol = this.getYahooTicker(symbol, universe.symbols);
          const ohlcv = await fetchOHLCV(yahooSymbol, "1h", "1mo");
          if (ohlcv.length < 21) continue;

          const indicators = computeIndicators(ohlcv);
          if (!indicators) continue;

          allIndicators.push(indicators);
          const signal = checkMomentumSignal(indicators);

          if (signal.pass) {
            // Multi-timeframe confirmation
            const mtf = await confirmMultiTimeframe(yahooSymbol, "momentum");

            const sr: ScanResult = {
              symbol,
              signal: mtf.confirmed ? "MOMENTUM_CONFIRMED" : "MOMENTUM_UP",
              strength: signal.strength,
              timestamp: new Date().toISOString(),
              indicators: {
                rsi: indicators.rsi ?? undefined,
                ema9: indicators.ema9 ?? undefined,
                ema21: indicators.ema21 ?? undefined,
                bb_upper: indicators.bb_upper ?? undefined,
                bb_lower: indicators.bb_lower ?? undefined,
                vwap: indicators.vwap ?? undefined,
                price: indicators.price,
                volume: indicators.volume,
                volumeRatio: indicators.volumeRatio ?? undefined,
              },
            };

            if (mtf.confirmed) {
              sr.strength += 20; // Bonus for multi-timeframe confirmation
            }

            results.push(sr);
            appendScanResult(sr);
            console.log(`[universe] MOMENTUM ${symbol}: strength=${sr.strength} | ${signal.details}${mtf.confirmed ? " | MTF confirmed" : ""}`);
          }

          // Rate limit: small delay between symbol lookups
          await new Promise((r) => setTimeout(r, 300));
        } catch (e) {
          // Skip individual symbol errors
          continue;
        }
      }
      // Post-Earnings Momentum: symbols with earnings yesterday + >5% move
      try {
        const postEarnings = getPostEarningsSymbols();
        if (postEarnings.length > 0) {
          for (const symbol of postEarnings) {
            const q = quotes.get(symbol);
            if (!q || Math.abs(q.changePct) < 5) continue;
            // Only positive post-earnings moves for momentum
            if (q.changePct <= 0) continue;

            const sr: ScanResult = {
              symbol,
              signal: "POST_EARNINGS_MOMENTUM",
              strength: Math.min(q.changePct * 3, 50) + 15, // Bonus +15
              timestamp: new Date().toISOString(),
              indicators: {
                price: q.price,
                volume: q.volume,
              },
            };
            results.push(sr);
            appendScanResult(sr);
            console.log(`[universe] POST_EARNINGS ${symbol}: +${q.changePct.toFixed(1)}% | strength=${sr.strength}`);
          }
        }
      } catch (e) {
        console.log("[universe] Post-earnings scan error:", e instanceof Error ? e.message : e);
      }
    } catch (e) {
      console.log("[universe] Momentum scan error:", e instanceof Error ? e.message : e);
    }

    // Collect debug stats
    if (allIndicators.length > 0) {
      this._lastDebugStats = collectDebugStats(allIndicators);
      console.log(`[universe] Debug: ${allIndicators.length} analyzed | EMA bullish: ${this._lastDebugStats.momentum.emaBullish} | RSI 50-70: ${this._lastDebugStats.momentum.rsiInZone} | Vol>120%: ${this._lastDebugStats.momentum.volumeAbove120} | Pass: ${this._lastDebugStats.momentum.passed}`);
    }

    console.log(`[universe] Momentum scan: ${results.length} signals with indicators`);
    return results;
  }

  async scanMeanReversion(): Promise<ScanResult[]> {
    const universe = loadUniverse();
    if (universe.symbols.length === 0) return [];
    const results: ScanResult[] = [];

    // Market safety check
    const safety = await isMarketSafe();
    if (!safety.safe) {
      console.log(`[universe] Mean reversion scan skipped: ${safety.reason}`);
      return [];
    }

    try {
      // Pre-filter with quotes: price > $5, volume > 50k, negative day
      const quotes = await this.fetchYahooQuotes(universe.symbols);
      const candidates = Array.from(quotes.entries())
        .filter(([, q]) => q.changePct < -0.5 && q.volume > 50_000 && q.price > 5)
        .sort((a, b) => a[1].changePct - b[1].changePct)
        .slice(0, 30);

      // Filter out earnings-blocked symbols
      const blockedMR = new Set(getBlockedSymbols());
      const preMRCount = candidates.length;
      const filteredCandidatesMR = candidates.filter(([symbol]) => !blockedMR.has(symbol));
      if (filteredCandidatesMR.length < preMRCount) {
        console.log(`[universe] Earnings filter (MR): removed ${preMRCount - filteredCandidatesMR.length} symbols with upcoming earnings`);
      }

      console.log(`[universe] Mean reversion pre-filter: ${filteredCandidatesMR.length} candidates from ${quotes.size} symbols`);

      for (const [symbol, q] of filteredCandidatesMR) {
        try {
          const yahooSymbol = this.getYahooTicker(symbol, universe.symbols);
          const ohlcv = await fetchOHLCV(yahooSymbol, "1h", "1mo");
          if (ohlcv.length < 21) continue;

          const indicators = computeIndicators(ohlcv);
          if (!indicators) continue;

          const signal = checkMeanReversionSignal(indicators);

          if (signal.pass) {
            const mtf = await confirmMultiTimeframe(yahooSymbol, "meanReversion");

            const sr: ScanResult = {
              symbol,
              signal: mtf.confirmed ? "MEAN_REV_CONFIRMED" : "MEAN_REVERSION",
              strength: signal.strength,
              timestamp: new Date().toISOString(),
              indicators: {
                rsi: indicators.rsi ?? undefined,
                ema9: indicators.ema9 ?? undefined,
                ema21: indicators.ema21 ?? undefined,
                bb_upper: indicators.bb_upper ?? undefined,
                bb_lower: indicators.bb_lower ?? undefined,
                vwap: indicators.vwap ?? undefined,
                price: indicators.price,
                volume: indicators.volume,
                volumeRatio: indicators.volumeRatio ?? undefined,
              },
            };

            if (mtf.confirmed) {
              sr.strength += 20;
            }

            results.push(sr);
            appendScanResult(sr);
            console.log(`[universe] MEAN_REV ${symbol}: strength=${sr.strength} | ${signal.details}${mtf.confirmed ? " | MTF confirmed" : ""}`);
          }

          await new Promise((r) => setTimeout(r, 300));
        } catch (e) {
          continue;
        }
      }
    } catch (e) {
      console.log("[universe] Mean reversion scan error:", e instanceof Error ? e.message : e);
    }

    console.log(`[universe] Mean reversion scan: ${results.length} signals with indicators`);
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

  isScheduleRunning(): boolean {
    return this.scheduleTimer !== null;
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

    // Market safety check (risk-off filter + trading hours)
    const safety = await isMarketSafe();
    if (!safety.safe) {
      console.log(`[universe] Tick skipped: ${safety.reason}`);
      return;
    }

    // Momentum scan every 5 minutes
    let momentumCount = 0;
    let meanRevCount = 0;
    const fiveMinSlot = Math.floor(utcMin / 5);
    if (fiveMinSlot !== this.lastMomentumMin) {
      this.lastMomentumMin = fiveMinSlot;
      const momentum = await this.scanMomentum();
      momentumCount = momentum.length;
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
      const meanRev = await this.scanMeanReversion();
      meanRevCount = meanRev.length;
    }

    // Notify scan complete
    if (this.onScanComplete) {
      this.onScanComplete({ momentum: momentumCount, meanReversion: meanRevCount });
    }
  }

  // ── Helpers ──

  private getYahooTicker(symbol: string, symbols: UniverseSymbol[]): string {
    const entry = symbols.find((s) => s.symbol === symbol);
    if (entry?.currency === "EUR") return `${symbol}.DE`;
    return symbol;
  }

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
