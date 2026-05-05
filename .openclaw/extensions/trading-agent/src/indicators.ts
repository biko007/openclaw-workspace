import { RSI, EMA, BollingerBands } from "technicalindicators";
import YahooFinance from "yahoo-finance2";

const yahooFinance = new YahooFinance({
  validation: { logErrors: false },
  suppressNotices: ["yahooSurvey"],
});

// ── Types ──

export interface OHLCV {
  date: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface IndicatorValues {
  rsi: number | null;
  ema9: number | null;
  ema21: number | null;
  bb_upper: number | null;
  bb_lower: number | null;
  bb_middle: number | null;
  vwap: number | null;
  price: number;
  volume: number;
  volumeRatio: number | null; // current volume vs 20-day avg
  prevEma9: number | null;
  prevEma21: number | null;
}

export interface SignalResult {
  pass: boolean;
  strength: number;
  details: string;
}

export interface MarketSafetyResult {
  safe: boolean;
  reason?: string;
}

// ── Fetch OHLCV from Yahoo Finance ──

export async function fetchOHLCV(
  symbol: string,
  interval: "1h" | "15m" | "1d",
  range: "5d" | "1mo" | "3mo",
): Promise<OHLCV[]> {
  // Yahoo ticker: EU stocks need .DE suffix
  const ticker = symbol.includes(".") ? symbol : symbol;

  try {
    const result = await yahooFinance.chart(ticker, {
      period1: getRangeStart(range),
      interval,
    });

    if (!result?.quotes?.length) return [];

    return result.quotes
      .filter((q: any) => q.close != null && q.volume != null)
      .map((q: any) => ({
        date: new Date(q.date),
        open: q.open ?? q.close,
        high: q.high ?? q.close,
        low: q.low ?? q.close,
        close: q.close,
        volume: q.volume ?? 0,
      }));
  } catch (e) {
    console.log(`[indicators] fetchOHLCV error for ${symbol}:`, e instanceof Error ? e.message : e);
    return [];
  }
}

function getRangeStart(range: "5d" | "1mo" | "3mo"): Date {
  const now = new Date();
  switch (range) {
    case "5d": return new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
    case "1mo": return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    case "3mo": return new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  }
}

// ── Compute Indicators ──

export function computeIndicators(ohlcv: OHLCV[]): IndicatorValues | null {
  if (ohlcv.length < 21) return null; // Need at least 21 bars for EMA21

  const closes = ohlcv.map((b) => b.close);
  const lastBar = ohlcv[ohlcv.length - 1];

  // RSI(14)
  const rsiValues = RSI.calculate({ values: closes, period: 14 });
  const rsi = rsiValues.length > 0 ? rsiValues[rsiValues.length - 1] : null;

  // EMA(9) and EMA(21)
  const ema9Values = EMA.calculate({ values: closes, period: 9 });
  const ema21Values = EMA.calculate({ values: closes, period: 21 });
  const ema9 = ema9Values.length > 0 ? ema9Values[ema9Values.length - 1] : null;
  const ema21 = ema21Values.length > 0 ? ema21Values[ema21Values.length - 1] : null;
  const prevEma9 = ema9Values.length > 1 ? ema9Values[ema9Values.length - 2] : null;
  const prevEma21 = ema21Values.length > 1 ? ema21Values[ema21Values.length - 2] : null;

  // Bollinger Bands(20, 2)
  const bbValues = BollingerBands.calculate({ values: closes, period: 20, stdDev: 2 });
  const bb = bbValues.length > 0 ? bbValues[bbValues.length - 1] : null;

  // VWAP (intraday cumulative)
  const vwap = computeVWAP(ohlcv);

  // Volume ratio: current volume vs 20-bar average
  let volumeRatio: number | null = null;
  if (ohlcv.length >= 20) {
    const recentVols = ohlcv.slice(-20).map((b) => b.volume);
    const avgVol = recentVols.reduce((s, v) => s + v, 0) / recentVols.length;
    if (avgVol > 0) {
      volumeRatio = lastBar.volume / avgVol;
    }
  }

  return {
    rsi,
    ema9,
    ema21,
    bb_upper: bb?.upper ?? null,
    bb_lower: bb?.lower ?? null,
    bb_middle: bb?.middle ?? null,
    vwap,
    price: lastBar.close,
    volume: lastBar.volume,
    volumeRatio,
    prevEma9,
    prevEma21,
  };
}

function computeVWAP(ohlcv: OHLCV[]): number | null {
  if (ohlcv.length === 0) return null;

  // Use today's bars for intraday VWAP
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const todayBars = ohlcv.filter((b) => b.date >= today);
  const bars = todayBars.length > 0 ? todayBars : ohlcv;

  let cumTPV = 0; // cumulative TP * Volume
  let cumVol = 0;

  for (const bar of bars) {
    const tp = (bar.high + bar.low + bar.close) / 3;
    cumTPV += tp * bar.volume;
    cumVol += bar.volume;
  }

  return cumVol > 0 ? cumTPV / cumVol : null;
}

// ── Signal Checks ──

export function checkMomentumSignal(indicators: IndicatorValues): SignalResult {
  const reasons: string[] = [];
  let score = 0;
  let conditionsMet = 0;

  // Condition 1: EMA bullish (EMA9 > EMA21, bonus for fresh cross)
  const emaCross =
    indicators.ema9 !== null &&
    indicators.ema21 !== null &&
    indicators.prevEma9 !== null &&
    indicators.prevEma21 !== null &&
    indicators.prevEma9 <= indicators.prevEma21 &&
    indicators.ema9 > indicators.ema21;

  const emaBullish =
    indicators.ema9 !== null &&
    indicators.ema21 !== null &&
    indicators.ema9 > indicators.ema21;

  if (emaCross) {
    score += 40;
    conditionsMet++;
    reasons.push("EMA9/21 golden cross");
  } else if (emaBullish) {
    score += 20;
    conditionsMet++;
    reasons.push("EMA9 > EMA21 (bullish trend)");
  } else {
    reasons.push("EMA bearish");
  }

  // Condition 2: RSI in momentum zone (50-70)
  const rsiInZone = indicators.rsi !== null && indicators.rsi >= 50 && indicators.rsi <= 70;
  if (indicators.rsi !== null) {
    if (rsiInZone) {
      score += 30;
      conditionsMet++;
      reasons.push(`RSI ${indicators.rsi.toFixed(1)} (momentum zone)`);
    } else if (indicators.rsi > 70) {
      reasons.push(`RSI ${indicators.rsi.toFixed(1)} (overbought)`);
    } else {
      reasons.push(`RSI ${indicators.rsi.toFixed(1)} (weak)`);
    }
  }

  // Condition 3: Volume > 120% of 20-bar average
  const volumeStrong = indicators.volumeRatio !== null && indicators.volumeRatio >= 1.2;
  if (indicators.volumeRatio !== null) {
    if (indicators.volumeRatio >= 1.5) {
      score += 30;
      conditionsMet++;
      reasons.push(`Vol ${(indicators.volumeRatio * 100).toFixed(0)}% of avg (strong)`);
    } else if (volumeStrong) {
      score += 20;
      conditionsMet++;
      reasons.push(`Vol ${(indicators.volumeRatio * 100).toFixed(0)}% of avg (elevated)`);
    } else if (indicators.volumeRatio >= 1.0) {
      score += 10;
      reasons.push(`Vol ${(indicators.volumeRatio * 100).toFixed(0)}% of avg (normal)`);
    } else {
      reasons.push(`Vol ${(indicators.volumeRatio * 100).toFixed(0)}% of avg (low)`);
    }
  }

  // Pass requires: at least 2 of 3 conditions met, with EMA bullish or cross required
  const pass = conditionsMet >= 2 && (emaCross || emaBullish);

  return {
    pass,
    strength: score,
    details: reasons.join(" | "),
  };
}

export function checkMeanReversionSignal(indicators: IndicatorValues): SignalResult {
  const reasons: string[] = [];
  let score = 0;
  let conditionsMet = 0;

  // 1. RSI < 35 (oversold zone)
  const rsiOversold = indicators.rsi !== null && indicators.rsi < 35;
  if (indicators.rsi !== null) {
    if (indicators.rsi < 30) {
      conditionsMet++;
      score += 40;
      reasons.push(`RSI ${indicators.rsi.toFixed(1)} (deeply oversold)`);
    } else if (indicators.rsi < 35) {
      conditionsMet++;
      score += 30;
      reasons.push(`RSI ${indicators.rsi.toFixed(1)} (oversold zone)`);
    } else {
      reasons.push(`RSI ${indicators.rsi.toFixed(1)} (not oversold)`);
    }
  }

  // 2. Price below BB lower OR in lower third of BB range
  let bbOversold = false;
  if (indicators.bb_lower !== null && indicators.bb_upper !== null) {
    const bbRange = indicators.bb_upper - indicators.bb_lower;
    const lowerThird = indicators.bb_lower + bbRange / 3;
    if (indicators.price < indicators.bb_lower) {
      bbOversold = true;
      conditionsMet++;
      score += 35;
      reasons.push(`Price ${indicators.price.toFixed(2)} < BB lower ${indicators.bb_lower.toFixed(2)}`);
    } else if (indicators.price < lowerThird) {
      bbOversold = true;
      conditionsMet++;
      score += 25;
      reasons.push(`Price in lower BB third (${indicators.price.toFixed(2)} < ${lowerThird.toFixed(2)})`);
    } else {
      reasons.push(`Price above BB lower third`);
    }
  }

  // 3. Volume confirmation (selling pressure validated)
  if (indicators.volumeRatio !== null) {
    if (indicators.volumeRatio >= 1.2) {
      conditionsMet++;
      score += 25;
      reasons.push(`Vol ${(indicators.volumeRatio * 100).toFixed(0)}% (selling exhaustion likely)`);
    } else {
      reasons.push(`Vol ${(indicators.volumeRatio * 100).toFixed(0)}% (low conviction)`);
    }
  }

  // Pass requires: RSI oversold + at least one other condition
  const pass = rsiOversold && conditionsMet >= 2;

  return {
    pass,
    strength: score,
    details: reasons.join(" | "),
  };
}

// ── Debug Statistics ──

export interface ScanDebugStats {
  totalAnalyzed: number;
  momentum: {
    emaBullish: number;
    emaCross: number;
    rsiInZone: number;
    volumeAbove120: number;
    passed: number;
  };
  meanReversion: {
    rsiBelow35: number;
    rsiBelow30: number;
    belowBBLower: number;
    inLowerThird: number;
    volumeAbove120: number;
    passed: number;
  };
  timestamp: string;
}

let lastDebugStats: ScanDebugStats | null = null;

export function getLastDebugStats(): ScanDebugStats | null {
  return lastDebugStats;
}

export function collectDebugStats(candidates: IndicatorValues[]): ScanDebugStats {
  const stats: ScanDebugStats = {
    totalAnalyzed: candidates.length,
    momentum: { emaBullish: 0, emaCross: 0, rsiInZone: 0, volumeAbove120: 0, passed: 0 },
    meanReversion: { rsiBelow35: 0, rsiBelow30: 0, belowBBLower: 0, inLowerThird: 0, volumeAbove120: 0, passed: 0 },
    timestamp: new Date().toISOString(),
  };

  for (const ind of candidates) {
    // Momentum conditions
    const emaBullish = ind.ema9 !== null && ind.ema21 !== null && ind.ema9 > ind.ema21;
    const emaCross = ind.ema9 !== null && ind.ema21 !== null && ind.prevEma9 !== null && ind.prevEma21 !== null &&
      ind.prevEma9 <= ind.prevEma21 && ind.ema9 > ind.ema21;
    const rsiInZone = ind.rsi !== null && ind.rsi >= 50 && ind.rsi <= 70;
    const volAbove120 = ind.volumeRatio !== null && ind.volumeRatio >= 1.2;

    if (emaBullish) stats.momentum.emaBullish++;
    if (emaCross) stats.momentum.emaCross++;
    if (rsiInZone) stats.momentum.rsiInZone++;
    if (volAbove120) stats.momentum.volumeAbove120++;

    const momConditions = (emaBullish ? 1 : 0) + (rsiInZone ? 1 : 0) + (volAbove120 ? 1 : 0);
    if (momConditions >= 2 && emaBullish) stats.momentum.passed++;

    // Mean reversion conditions
    const rsiBelow35 = ind.rsi !== null && ind.rsi < 35;
    const rsiBelow30 = ind.rsi !== null && ind.rsi < 30;
    const belowBB = ind.bb_lower !== null && ind.price < ind.bb_lower;
    const inLowerThird = ind.bb_lower !== null && ind.bb_upper !== null &&
      ind.price < (ind.bb_lower + (ind.bb_upper - ind.bb_lower) / 3);

    if (rsiBelow35) stats.meanReversion.rsiBelow35++;
    if (rsiBelow30) stats.meanReversion.rsiBelow30++;
    if (belowBB) stats.meanReversion.belowBBLower++;
    if (inLowerThird) stats.meanReversion.inLowerThird++;
    if (volAbove120) stats.meanReversion.volumeAbove120++;

    const mrConditions = (rsiBelow35 ? 1 : 0) + ((belowBB || inLowerThird) ? 1 : 0) + (volAbove120 ? 1 : 0);
    if (rsiBelow35 && mrConditions >= 2) stats.meanReversion.passed++;
  }

  lastDebugStats = stats;
  return stats;
}

// ── Market Safety Check ──

export async function isMarketSafe(): Promise<MarketSafetyResult> {
  // 1. Check market hours (avoid first 15min after open, last 30min before close)
  const now = new Date();
  const utcHour = now.getUTCHours();
  const utcMin = now.getUTCMinutes();

  // US market: 13:30-20:00 UTC (safe window: 13:45-19:30 UTC)
  const usOpen = utcHour === 13 && utcMin >= 30;
  const usTrading = utcHour >= 14 && utcHour < 20;
  const usMarketOpen = usOpen || usTrading;

  if (usMarketOpen) {
    // First 15 minutes after open (13:30-13:45 UTC)
    if (utcHour === 13 && utcMin < 45) {
      return { safe: false, reason: "First 15min after US open - high volatility" };
    }
    // Last 30 minutes before close (19:30-20:00 UTC)
    if (utcHour === 19 && utcMin >= 30) {
      return { safe: false, reason: "Last 30min before US close - high volatility" };
    }
  }

  // EU market: 07:00-15:30 UTC (safe window: 07:15-15:00 UTC)
  const euMarketOpen = utcHour >= 7 && (utcHour < 15 || (utcHour === 15 && utcMin <= 30));
  if (euMarketOpen) {
    if (utcHour === 7 && utcMin < 15) {
      return { safe: false, reason: "First 15min after EU open - high volatility" };
    }
    if (utcHour === 15 && utcMin > 0) {
      return { safe: false, reason: "Last 30min before EU close - high volatility" };
    }
  }

  // 2. Check S&P 500 daily performance (risk-off filter)
  try {
    const spyQuote: any = await yahooFinance.quote("SPY");
    const spyChange = spyQuote?.regularMarketChangePercent ?? 0;

    if (spyChange < -1.5) {
      return {
        safe: false,
        reason: `S&P 500 down ${spyChange.toFixed(1)}% - risk-off environment`,
      };
    }
  } catch (e) {
    console.log("[indicators] SPY quote error:", e instanceof Error ? e.message : e);
    // Don't block trading on quote errors
  }

  return { safe: true };
}

// ── Multi-timeframe Confirmation ──

export async function confirmMultiTimeframe(
  symbol: string,
  signal: "momentum" | "meanReversion",
): Promise<{ confirmed: boolean; details: string }> {
  // Fetch 1h for trend, 15m for entry timing
  const [ohlcv1h, ohlcv15m] = await Promise.all([
    fetchOHLCV(symbol, "1h", "1mo"),
    fetchOHLCV(symbol, "15m", "5d"),
  ]);

  const ind1h = computeIndicators(ohlcv1h);
  const ind15m = computeIndicators(ohlcv15m);

  if (!ind1h || !ind15m) {
    return { confirmed: false, details: "Insufficient data for multi-timeframe analysis" };
  }

  if (signal === "momentum") {
    const trend1h = checkMomentumSignal(ind1h);
    const entry15m = checkMomentumSignal(ind15m);

    // 1h must show bullish trend, 15m confirms entry
    const trendOk = ind1h.ema9 !== null && ind1h.ema21 !== null && ind1h.ema9 > ind1h.ema21;
    const entryOk = ind15m.rsi !== null && ind15m.rsi >= 50 && ind15m.rsi <= 70;

    return {
      confirmed: trendOk && entryOk,
      details: `1h: ${trend1h.details} | 15m: ${entry15m.details}`,
    };
  } else {
    const trend1h = checkMeanReversionSignal(ind1h);
    const entry15m = checkMeanReversionSignal(ind15m);

    // Both timeframes should show oversold conditions
    const trendOk = ind1h.rsi !== null && ind1h.rsi < 35;
    const entryOk = ind15m.rsi !== null && ind15m.rsi < 30;

    return {
      confirmed: trendOk && entryOk,
      details: `1h: ${trend1h.details} | 15m: ${entry15m.details}`,
    };
  }
}
