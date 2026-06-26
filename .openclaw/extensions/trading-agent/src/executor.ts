import YahooFinance from "yahoo-finance2";
import { IBKRConnection, type OrderResult } from "./ibkr.js";
import {
  loadStrategies,
  loadUniverse,
  type ScanResult,
  type TradingStatus,
} from "./store.js";
import {
  buildTradeIntentId,
  type OrderStateTracker,
} from "./order-state-tracker.js";
import { evaluateTrade, shouldExecuteTrade, type TradeDecision } from "./ai-decision.js";
import type { AlertManager } from "./alert-manager.js";
import { hasEarningsSoon, getEarningsInfo } from "./earnings-calendar.js";

const yahooFinance = new YahooFinance({
  validation: { logErrors: false },
  suppressNotices: ["yahooSurvey"],
});

export interface ExecutedTrade {
  symbol: string;
  quantity: number;
  actualFilledQty: number;
  fillPrice: number;
  limitPrice: number;
  stopPrice: number;
  takeProfitPrice: number;
  entryOrderId: number;
  stopOrderId?: number;
  tpOrderId?: number;
  conId: number;
  tradeIntentId: string;
  positionSizeUsd: number;
  signal: string;
  strength: number;
  aiConfidence?: number;
  aiReasoning?: string;
}

export type NotifyFn = (message: string) => void;

export class OrderExecutor {
  private ibkr: IBKRConnection;
  private getStatus: () => TradingStatus;
  private onNotify: NotifyFn;
  private tracker: OrderStateTracker;
  private alertManager: AlertManager;

  constructor(ibkr: IBKRConnection, getStatus: () => TradingStatus, onNotify: NotifyFn, tracker: OrderStateTracker, alertManager: AlertManager) {
    this.ibkr = ibkr;
    this.getStatus = getStatus;
    this.onNotify = onNotify;
    this.tracker = tracker;
    this.alertManager = alertManager;
  }

  /**
   * Execute top momentum candidates after a scan.
   * Only runs in mode 3 (Full-Auto) with IBKR connected.
   */
  async executeAfterScan(momentumResults: ScanResult[]): Promise<ExecutedTrade[]> {
    const status = this.getStatus();

    // Only execute in Full-Auto mode
    if (status.mode !== 3) {
      console.log(`[executor] Mode ${status.mode}, skipping auto-execution`);
      return [];
    }

    if (!this.ibkr.isConnected()) {
      console.log("[executor] IBKR not connected, skipping execution");
      return [];
    }

    if (momentumResults.length === 0) {
      console.log("[executor] No momentum candidates, skipping");
      return [];
    }

    const strategies = loadStrategies();

    if (!strategies.momentum.enabled) {
      console.log("[executor] Momentum strategy disabled, skipping");
      return [];
    }

    // Check max open positions
    const currentPositions = status.positions.length;
    const maxOpen = strategies.maxOpenPositions;
    const slotsAvailable = maxOpen - currentPositions;

    if (slotsAvailable <= 0) {
      console.log(`[executor] Max positions reached (${currentPositions}/${maxOpen}), skipping`);
      return [];
    }

    // Get symbols we already hold
    const heldSymbols = new Set(status.positions.map((p) => p.symbol));

    // Filter candidates: not already held, sorted by strength
    const candidates = momentumResults
      .filter((c) => !heldSymbols.has(c.symbol) && c.strength > 1.5)
      .sort((a, b) => b.strength - a.strength)
      .slice(0, Math.min(3, slotsAvailable));

    if (candidates.length === 0) {
      console.log("[executor] No eligible candidates after filtering");
      return [];
    }

    // Position size: 20% of cash / number of orders
    const cashAvailable = status.cashBalance;
    const positionSizePercent = strategies.momentum.maxPositionSizePercent;
    const totalAllocation = cashAvailable * (positionSizePercent / 100);
    const perOrderBudget = totalAllocation / candidates.length;
    const stopLossPercent = strategies.momentum.stopLossPercent;

    console.log(`[executor] Executing ${candidates.length} orders | Budget: $${perOrderBudget.toFixed(0)}/order | Cash: $${cashAvailable.toFixed(0)}`);

    const executed: ExecutedTrade[] = [];
    const evalTracking = { totalEvaluated: 0, errors: [] as { symbol: string; detail: string }[] };

    for (const candidate of candidates) {
      try {
        const trade = await this.executeSingleOrder(candidate, perOrderBudget, stopLossPercent, evalTracking);
        if (trade) executed.push(trade);
      } catch (e) {
        console.error(`[executor] Order failed for ${candidate.symbol}:`, e instanceof Error ? e.message : e);
      }
    }

    // R1: Fail-loud — alert if AI eval errors exceed threshold
    const { totalEvaluated, errors: evalErrors } = evalTracking;
    if (totalEvaluated > 0 && (evalErrors.length >= 3 || evalErrors.length / totalEvaluated >= 0.5)) {
      const sample = evalErrors[0]?.detail || "unknown";
      await this.alertManager.sendAlert("ai_eval_failing", "WARN", [
        `⚠️ *KI-Eval Fehler*`,
        ``,
        `${evalErrors.length}/${totalEvaluated} Bewertungen fehlgeschlagen`,
        `Beispiel: ${sample}`,
      ].join("\n"));
    } else if (totalEvaluated > 0 && evalErrors.length === 0) {
      if (this.alertManager.isActive("ai_eval_failing")) {
        await this.alertManager.resolve("ai_eval_failing");
      }
    }

    // Send Telegram notification
    if (executed.length > 0) {
      this.notifyTrades(executed);
    }

    return executed;
  }

  private async executeSingleOrder(
    candidate: ScanResult,
    budgetUsd: number,
    stopLossPercent: number,
    evalTracking: { totalEvaluated: number; errors: { symbol: string; detail: string }[] },
  ): Promise<ExecutedTrade | null> {
    // Get current price from Yahoo Finance
    const universe = loadUniverse();
    const symbolInfo = universe.symbols.find((s) => s.symbol === candidate.symbol);
    const isEU = symbolInfo?.currency === "EUR";
    const yahooTicker = isEU ? `${candidate.symbol}.DE` : candidate.symbol;

    // Exchange hours gate: only place orders when the target exchange is open
    const orderTime = new Date();
    const utcH = orderTime.getUTCHours();
    const utcM = orderTime.getUTCMinutes();
    const utcTime = utcH * 60 + utcM;
    if (isEU) {
      // XETRA: 09:00–17:30 CET → ~07:00–15:30 UTC (summer), ~08:00–16:30 UTC (winter)
      // Use conservative window: 07:00–15:30 UTC
      if (utcTime < 7 * 60 || utcTime >= 15 * 60 + 30) {
        console.log(`[executor] ${candidate.symbol}: XETRA closed (UTC ${utcH}:${String(utcM).padStart(2, "0")}), skipping`);
        return null;
      }
    } else {
      // NYSE/NASDAQ: 09:30–16:00 ET → 13:30–20:00 UTC (summer), 14:30–21:00 UTC (winter)
      // Use conservative window: 13:30–20:00 UTC
      if (utcTime < 13 * 60 + 30 || utcTime >= 20 * 60) {
        console.log(`[executor] ${candidate.symbol}: NYSE/NASDAQ closed (UTC ${utcH}:${String(utcM).padStart(2, "0")}), skipping`);
        return null;
      }
    }

    let currentPrice: number;
    try {
      const quote: any = await yahooFinance.quote(yahooTicker);
      currentPrice = quote?.regularMarketPrice;
      if (!currentPrice || currentPrice <= 0) {
        console.log(`[executor] No price for ${candidate.symbol}, skipping`);
        return null;
      }
    } catch (e) {
      console.log(`[executor] Quote error for ${candidate.symbol}:`, e instanceof Error ? e.message : e);
      return null;
    }

    // Earnings-Check: kein Kauf wenn Earnings in < 3 Tagen
    if (hasEarningsSoon(candidate.symbol)) {
      console.log(`[executor] ${candidate.symbol}: Earnings < 3 Tage, gesperrt`);
      return null;
    }

    // Earnings-Info für AI (4-7 Tage)
    const earningsInfo = getEarningsInfo(candidate.symbol);

    // AI Decision Gate: Claude Sonnet evaluates before every order
    let aiDecision: TradeDecision;
    try {
      aiDecision = await evaluateTrade(candidate, currentPrice, undefined, earningsInfo, this.tracker);
      evalTracking.totalEvaluated++;
      if (aiDecision.evalError) {
        evalTracking.errors.push({ symbol: candidate.symbol, detail: aiDecision.errorDetail || "unknown" });
      }
      if (!shouldExecuteTrade(aiDecision)) {
        console.log(`[executor] AI SKIP ${candidate.symbol}: confidence=${aiDecision.confidence.toFixed(2)} — ${aiDecision.reasoning}`);
        return null;
      }
      console.log(`[executor] AI APPROVED ${candidate.symbol}: confidence=${aiDecision.confidence.toFixed(2)} — ${aiDecision.reasoning}`);
    } catch (e) {
      evalTracking.totalEvaluated++;
      evalTracking.errors.push({ symbol: candidate.symbol, detail: e instanceof Error ? e.message : String(e) });
      console.log(`[executor] AI evaluation failed for ${candidate.symbol}, skipping:`, e instanceof Error ? e.message : e);
      return null;
    }

    // Calculate quantity
    const quantity = Math.floor(budgetUsd / currentPrice);
    if (quantity <= 0) {
      console.log(`[executor] Budget too small for ${candidate.symbol} @ $${currentPrice.toFixed(2)}`);
      return null;
    }

    // Round to valid tick size per exchange rules
    // XETRA: IBKR rejects sub-cent ticks (DTE errorCode 110 at 27.325 with tick 0.005,
    // empirisch bestätigt 2026-06-12 Nachrüstung). Minimum 0.01 for all prices <100€.
    // US stocks: 0.01 for all
    const getTickSize = (price: number): number => {
      if (!isEU) return 0.01;
      if (price < 100) return 0.01;
      if (price < 500) return 0.05;
      return 0.1;
    };
    const roundTick = (p: number) => {
      const tick = getTickSize(p);
      return Math.round(p / tick) * tick;
    };

    // Use AI-suggested levels if valid, otherwise calculate defaults
    let limitPrice = roundTick(currentPrice * 1.001);
    let stopPrice = roundTick(currentPrice * (1 - stopLossPercent / 100));
    let takeProfitPrice = roundTick(currentPrice * (1 + (stopLossPercent * 2) / 100));

    if (aiDecision.suggestedEntry && aiDecision.suggestedStop && aiDecision.suggestedTarget) {
      const aiEntry = roundTick(aiDecision.suggestedEntry);
      const aiStop = roundTick(aiDecision.suggestedStop);
      const aiTarget = roundTick(aiDecision.suggestedTarget);
      // Only use AI levels if they make sense (stop < entry < target)
      if (aiStop < aiEntry && aiTarget > aiEntry) {
        limitPrice = aiEntry;
        stopPrice = aiStop;
        takeProfitPrice = aiTarget;
        console.log(`[executor] Using AI-suggested levels for ${candidate.symbol}`);
      }
    }

    const exchange = symbolInfo?.exchange === "IBIS" ? "IBIS" : "SMART";
    const currency = symbolInfo?.currency || "USD";

    console.log(`[executor] Placing: BUY ${quantity} ${candidate.symbol} LMT@${limitPrice} | STP@${stopPrice} | TP@${takeProfitPrice}`);

    // Resolve conId before placing (separate reqId, not order sequencer)
    let conId: number;
    try {
      conId = await this.ibkr.resolveContractId(candidate.symbol, exchange, currency);
    } catch (e) {
      console.warn(`[executor] resolveContractId failed for ${candidate.symbol}:`, e instanceof Error ? e.message : e);
      return null;
    }

    // Build tradeIntentId: SYMBOL-YYMMDD-nn
    const now = new Date();
    const seq = this.tracker.getMaxTradeIntentSeq(candidate.symbol, now) + 1;
    const tradeIntentId = buildTradeIntentId(candidate.symbol, now, seq);

    // Place bracket order (E5: entry + fill-monitoring + auto-exits)
    const result = await this.ibkr.placeBracketOrder({
      symbol: candidate.symbol,
      exchange,
      currency,
      quantity,
      limitPrice,
      stopPrice,
      takeProfitPrice,
      tradeIntentId,
      conId,
    });

    // No fill at all → return null
    if (result.actualFilledQty === 0) {
      console.log(`[executor] ${candidate.symbol} BUY not filled, cancelled`);
      return null;
    }

    const fillPrice = result.entry.fillPrice || limitPrice;

    const trade: ExecutedTrade = {
      symbol: candidate.symbol,
      quantity,
      actualFilledQty: result.actualFilledQty,
      fillPrice,
      limitPrice,
      stopPrice,
      takeProfitPrice,
      entryOrderId: result.entry.orderId,
      stopOrderId: result.stopLoss?.orderId,
      tpOrderId: result.takeProfit?.orderId,
      conId,
      tradeIntentId,
      positionSizeUsd: result.actualFilledQty * fillPrice,
      signal: candidate.signal,
      strength: candidate.strength,
      aiConfidence: aiDecision.confidence,
      aiReasoning: aiDecision.reasoning,
    };

    console.log(
      `[executor] ${candidate.symbol}: FILLED ${result.actualFilledQty}/${quantity} @ $${fillPrice} | ` +
      `STP $${stopPrice} | TP $${takeProfitPrice} | intent=${tradeIntentId}`,
    );
    return trade;
  }

  private notifyTrades(trades: ExecutedTrade[]): void {
    for (const t of trades) {
      const rr = t.stopPrice > 0
        ? ((t.takeProfitPrice - t.fillPrice) / (t.fillPrice - t.stopPrice)).toFixed(1)
        : "?";

      const msg = [
        `📈 *Trade eröffnet*`,
        ``,
        `*${t.symbol}* — ${t.signal}`,
        `Kurs: $${t.fillPrice.toFixed(2)} (${t.quantity} Stk, $${t.positionSizeUsd.toFixed(0)})`,
        `Stop: $${t.stopPrice.toFixed(2)} | Target: $${t.takeProfitPrice.toFixed(2)} | R:R 1:${rr}`,
        ``,
        `*KI-Bewertung:* ${((t.aiConfidence ?? 0) * 100).toFixed(0)}%`,
        t.aiReasoning ? `_${t.aiReasoning}_` : "",
        ``,
        `Modus: Full-Auto`,
      ].filter(Boolean).join("\n");

      this.onNotify(msg);
    }
  }
}
