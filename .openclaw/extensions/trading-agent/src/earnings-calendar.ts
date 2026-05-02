import YahooFinance from "yahoo-finance2";
import {
  loadUniverse,
  loadEarningsCache,
  saveEarningsCache,
  type EarningsEntry,
  type EarningsCache,
} from "./store.js";

const yahooFinance = new YahooFinance({
  validation: { logErrors: false },
  suppressNotices: ["yahooSurvey"],
});

// ── Cache Refresh ──

export async function refreshEarningsCache(): Promise<EarningsCache> {
  const universe = loadUniverse();
  if (universe.symbols.length === 0) {
    console.log("[earnings] No universe symbols, skipping refresh");
    return loadEarningsCache();
  }

  console.log(`[earnings] Refreshing earnings cache for ${universe.symbols.length} symbols...`);
  const entries: EarningsEntry[] = [];

  // Build yahoo tickers
  const tickerMap = new Map<string, string>(); // yahoo ticker → original symbol
  for (const s of universe.symbols) {
    const ticker = s.currency === "EUR" ? `${s.symbol}.DE` : s.symbol;
    tickerMap.set(ticker, s.symbol);
  }

  const tickers = Array.from(tickerMap.keys());
  const CHUNK = 40;

  for (let i = 0; i < tickers.length; i += CHUNK) {
    const chunk = tickers.slice(i, i + CHUNK);
    try {
      const results: any = await yahooFinance.quote(chunk);
      const arr: any[] = Array.isArray(results) ? results : [results];
      for (const q of arr) {
        if (!q || !q.symbol) continue;
        const origSymbol = tickerMap.get(q.symbol) || q.symbol.replace(/\.DE$/, "");

        // earningsDate is an array of 1-2 Date objects from yahoo-finance2
        const earningsDates: Date[] = q.earningsTimestamp
          ? [new Date(q.earningsTimestamp * 1000)]
          : q.earningsDate
            ? (Array.isArray(q.earningsDate) ? q.earningsDate : [q.earningsDate])
            : [];

        for (const ed of earningsDates) {
          if (!(ed instanceof Date) || isNaN(ed.getTime())) continue;
          const dateStr = ed.toISOString().slice(0, 10);
          entries.push({
            symbol: origSymbol,
            earningsDate: dateStr,
            epsEstimate: q.epsCurrentYear ?? undefined,
          });
        }
      }
    } catch (e) {
      console.log(`[earnings] Quote batch error (chunk ${i}):`, e instanceof Error ? e.message : e);
    }

    // Rate limit between chunks
    if (i + CHUNK < tickers.length) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  const cache: EarningsCache = {
    entries,
    lastUpdate: new Date().toISOString(),
  };
  saveEarningsCache(cache);
  console.log(`[earnings] Cache refreshed: ${entries.length} earnings entries from ${universe.symbols.length} symbols`);
  return cache;
}

// ── Query Functions ──

function daysBetween(dateStr: string): number {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(dateStr + "T00:00:00");
  return Math.round((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function yesterdayStr(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Check if a symbol has earnings within the next N days.
 */
export function hasEarningsSoon(symbol: string, days = 3): boolean {
  const cache = loadEarningsCache();
  return cache.entries.some(
    (e) => e.symbol === symbol && daysBetween(e.earningsDate) >= 0 && daysBetween(e.earningsDate) < days,
  );
}

/**
 * Get the number of days until next earnings for a symbol, or null if unknown.
 */
export function daysUntilEarnings(symbol: string): number | null {
  const cache = loadEarningsCache();
  const entry = cache.entries
    .filter((e) => e.symbol === symbol && daysBetween(e.earningsDate) >= 0)
    .sort((a, b) => daysBetween(a.earningsDate) - daysBetween(b.earningsDate))[0];
  return entry ? daysBetween(entry.earningsDate) : null;
}

/**
 * Get all earnings entries for today.
 */
export function getEarningsToday(): EarningsEntry[] {
  const cache = loadEarningsCache();
  const today = todayStr();
  return cache.entries.filter((e) => e.earningsDate === today);
}

/**
 * Get all symbols blocked from trading (earnings in < 3 days).
 */
export function getBlockedSymbols(): string[] {
  const cache = loadEarningsCache();
  return cache.entries
    .filter((e) => {
      const days = daysBetween(e.earningsDate);
      return days >= 0 && days < 3;
    })
    .map((e) => e.symbol);
}

/**
 * Get symbols that had earnings yesterday (for post-earnings momentum).
 */
export function getPostEarningsSymbols(): string[] {
  const cache = loadEarningsCache();
  const yesterday = yesterdayStr();
  return [...new Set(cache.entries.filter((e) => e.earningsDate === yesterday).map((e) => e.symbol))];
}

/**
 * Get earnings info string for AI prompt (for symbols with earnings in 4-7 days).
 */
export function getEarningsInfo(symbol: string): string | undefined {
  const days = daysUntilEarnings(symbol);
  if (days === null) return undefined;
  if (days < 3) return `WARNUNG: Earnings in ${days} Tag(en) — Trade gesperrt`;
  if (days <= 7) return `Earnings in ${days} Tagen — erhöhtes Gap-Risiko`;
  return undefined;
}
