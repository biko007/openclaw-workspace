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

  // 1. EMA9 crosses EMA21 from below (Golden Cross)
  const emaCross =
    indicators.ema9 !== null &&
    indicators.ema21 !== null &&
    indicators.prevEma9 !== null &&
    indicators.prevEma21 !== null &&
    indicators.prevEma9 <= indicators.prevEma21 &&
    indicators.ema9 > indicators.ema21;

  // Also accept EMA9 > EMA21 (already crossed, trend in progress)
  const emaBullish =
    indicators.ema9 !== null &&
    indicators.ema21 !== null &&
    indicators.ema9 > indicators.ema21;

  if (emaCross) {
    score += 40;
    reasons.push("EMA9/21 golden cross");
  } else if (emaBullish) {
    score += 20;
    reasons.push("EMA9 > EMA21 (bullish trend)");
  } else {
    reasons.push("EMA bearish");
  }

  // 2. RSI between 50-70 (momentum but not overbought)
  if (indicators.rsi !== null) {
    if (indicators.rsi >= 50 && indicators.rsi <= 70) {
      score += 30;
      reasons.push(`RSI ${indicators.rsi.toFixed(1)} (momentum zone)`);
    } else if (indicators.rsi > 70) {
      reasons.push(`RSI ${indicators.rsi.toFixed(1)} (overbought)`);
    } else {
      reasons.push(`RSI ${indicators.rsi.toFixed(1)} (weak)`);
    }
  }

  // 3. Volume > 150% of 20-bar average
  if (indicators.volumeRatio !== null) {
    if (indicators.volumeRatio >= 1.5) {
      score += 30;
      reasons.push(`Vol ${(indicators.volumeRatio * 100).toFixed(0)}% of avg (strong)`);
    } else if (indicators.volumeRatio >= 1.0) {
      score += 10;
      reasons.push(`Vol ${(indicators.volumeRatio * 100).toFixed(0)}% of avg (normal)`);
    } else {
      reasons.push(`Vol ${(indicators.volumeRatio * 100).toFixed(0)}% of avg (low)`);
    }
  }

  // Pass requires: EMA cross/bullish + RSI in range + volume confirmation
  const pass = emaCross
    ? (indicators.rsi !== null && indicators.rsi >= 50 && indicators.rsi <= 70) &&
      (indicators.volumeRatio !== null && indicators.volumeRatio >= 1.5)
    : false;

  return {
    pass,
    strength: score,
    details: reasons.join(" | "),
  };
}

export function checkMeanReversionSignal(indicators: IndicatorValues): SignalResult {
  const reasons: string[] = [];
  let score = 0;

  // 1. RSI < 30 (oversold)
  let rsiOversold = false;
  if (indicators.rsi !== null) {
    if (indicators.rsi < 30) {
      rsiOversold = true;
      score += 35;
      reasons.push(`RSI ${indicators.rsi.toFixed(1)} (oversold)`);
    } else {
      reasons.push(`RSI ${indicators.rsi.toFixed(1)} (not oversold)`);
    }
  }

  // 2. Price below lower Bollinger Band
  let belowBB = false;
  if (indicators.bb_lower !== null) {
    if (indicators.price < indicators.bb_lower) {
      belowBB = true;
      score += 35;
      reasons.push(`Price ${indicators.price.toFixed(2)} < BB lower ${indicators.bb_lower.toFixed(2)}`);
    } else {
      reasons.push(`Price above BB lower`);
    }
  }

  // 3. Price > VWAP (institutional support)
  let aboveVWAP = false;
  if (indicators.vwap !== null) {
    if (indicators.price > indicators.vwap) {
      aboveVWAP = true;
      score += 30;
      reasons.push(`Price > VWAP ${indicators.vwap.toFixed(2)} (institutional support)`);
    } else {
      reasons.push(`Price < VWAP (no institutional support)`);
    }
  }

  const pass = rsiOversold && belowBB && aboveVWAP;

  return {
    pass,
    strength: score,
    details: reasons.join(" | "),
  };
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
