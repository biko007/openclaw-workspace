import YahooFinance from "yahoo-finance2";
import { IBKRConnection, type OrderResult } from "./ibkr.js";
import {
  loadStrategies,
  loadUniverse,
  appendOrder,
  type OrderRecord,
  type ScanResult,
  type TradingStatus,
} from "./store.js";
import { evaluateTrade, shouldExecuteTrade, type TradeDecision } from "./ai-decision.js";
import { hasEarningsSoon, getEarningsInfo } from "./earnings-calendar.js";

const yahooFinance = new YahooFinance({
  validation: { logErrors: false },
  suppressNotices: ["yahooSurvey"],
});

export interface ExecutedTrade {
  symbol: string;
  quantity: number;
  fillPrice: number;
  limitPrice: number;
  stopPrice: number;
  takeProfitPrice: number;
  entryOrderId: number;
  stopOrderId?: number;
  tpOrderId?: number;
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

  constructor(ibkr: IBKRConnection, getStatus: () => TradingStatus, onNotify: NotifyFn) {
    this.ibkr = ibkr;
    this.getStatus = getStatus;
    this.onNotify = onNotify;
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

    for (const candidate of candidates) {
      try {
        const trade = await this.executeSingleOrder(candidate, perOrderBudget, stopLossPercent);
        if (trade) executed.push(trade);
      } catch (e) {
        console.error(`[executor] Order failed for ${candidate.symbol}:`, e instanceof Error ? e.message : e);
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
  ): Promise<ExecutedTrade | null> {
    // Get current price from Yahoo Finance
    const universe = loadUniverse();
    const symbolInfo = universe.symbols.find((s) => s.symbol === candidate.symbol);
    const isEU = symbolInfo?.currency === "EUR";
    const yahooTicker = isEU ? `${candidate.symbol}.DE` : candidate.symbol;

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
      aiDecision = await evaluateTrade(candidate, currentPrice, undefined, earningsInfo);
      if (!shouldExecuteTrade(aiDecision)) {
        console.log(`[executor] AI SKIP ${candidate.symbol}: confidence=${aiDecision.confidence.toFixed(2)} — ${aiDecision.reasoning}`);
        return null;
      }
      console.log(`[executor] AI APPROVED ${candidate.symbol}: confidence=${aiDecision.confidence.toFixed(2)} — ${aiDecision.reasoning}`);
    } catch (e) {
      console.log(`[executor] AI evaluation failed for ${candidate.symbol}, skipping:`, e instanceof Error ? e.message : e);
      return null;
    }

    // Calculate quantity
    const quantity = Math.floor(budgetUsd / currentPrice);
    if (quantity <= 0) {
      console.log(`[executor] Budget too small for ${candidate.symbol} @ $${currentPrice.toFixed(2)}`);
      return null;
    }

    // Round to valid tick size (0.01 for most stocks)
    const roundTick = (p: number) => Math.round(p * 100) / 100;

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

    // Step 1: Record BUY order as submitted
    const now = new Date().toISOString();
    const entryRecord: OrderRecord = {
      id: `ORD-${Date.now()}`,
      symbol: candidate.symbol,
      side: "BUY",
      quantity,
      price: limitPrice,
      status: "Submitted",
      orderType: "LMT",
      timestamp: now,
    };
    appendOrder(entryRecord);

    // Step 2: Place bracket order (BUY → wait fill → STP + TP)
    const result = await this.ibkr.placeBracketOrder({
      symbol: candidate.symbol,
      exchange,
      currency,
      quantity,
      limitPrice,
      stopPrice,
      takeProfitPrice,
    });

    // Step 3: Record results based on what happened
    if (result.entry.status === "Cancelled") {
      // BUY didn't fill — update record
      appendOrder({
        ...entryRecord,
        id: entryRecord.id + "-cancelled",
        status: "Cancelled",
        timestamp: new Date().toISOString(),
      });
      console.log(`[executor] ${candidate.symbol} BUY not filled, cancelled`);
      return null;
    }

    // BUY filled — update entry record and record exit orders
    const fillPrice = result.entry.fillPrice || limitPrice;
    appendOrder({
      id: `ORD-${result.entry.orderId}`,
      symbol: candidate.symbol,
      side: "BUY",
      quantity,
      price: fillPrice,
      status: "Filled",
      orderType: "LMT",
      fillPrice,
      fillTimestamp: new Date().toISOString(),
      timestamp: now,
    });

    // Record stop-loss (now active, waiting to trigger)
    if (result.stopLoss) {
      appendOrder({
        id: `ORD-${result.stopLoss.orderId}`,
        symbol: candidate.symbol,
        side: "SELL",
        quantity,
        price: stopPrice,
        status: "Submitted",
        orderType: "STP",
        parentOrderId: `ORD-${result.entry.orderId}`,
        ocaGroup: `OCA_${candidate.symbol}`,
        timestamp: new Date().toISOString(),
      });
    }

    // Record take-profit (now active, waiting to trigger)
    if (result.takeProfit) {
      appendOrder({
        id: `ORD-${result.takeProfit.orderId}`,
        symbol: candidate.symbol,
        side: "SELL",
        quantity,
        price: takeProfitPrice,
        status: "Submitted",
        orderType: "LMT",
        parentOrderId: `ORD-${result.entry.orderId}`,
        ocaGroup: `OCA_${candidate.symbol}`,
        timestamp: new Date().toISOString(),
      });
    }

    const trade: ExecutedTrade = {
      symbol: candidate.symbol,
      quantity,
      fillPrice,
      limitPrice,
      stopPrice,
      takeProfitPrice,
      entryOrderId: result.entry.orderId,
      stopOrderId: result.stopLoss?.orderId,
      tpOrderId: result.takeProfit?.orderId,
      positionSizeUsd: quantity * fillPrice,
      signal: candidate.signal,
      strength: candidate.strength,
      aiConfidence: aiDecision.confidence,
      aiReasoning: aiDecision.reasoning,
    };

    console.log(`[executor] ${candidate.symbol}: FILLED @ $${fillPrice} | STP $${stopPrice} | TP $${takeProfitPrice}`);
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
