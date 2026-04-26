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

    // Calculate quantity
    const quantity = Math.floor(budgetUsd / currentPrice);
    if (quantity <= 0) {
      console.log(`[executor] Budget too small for ${candidate.symbol} @ $${currentPrice.toFixed(2)}`);
      return null;
    }

    // Round to valid tick size (0.01 for most stocks)
    const roundTick = (p: number) => Math.round(p * 100) / 100;
    // Limit price: 0.1% above current to ensure fill
    const limitPrice = roundTick(currentPrice * 1.001);
    // Stop-loss: stopLossPercent below entry
    const stopPrice = roundTick(currentPrice * (1 - stopLossPercent / 100));
    // Take-profit: 2x the stop-loss distance (risk:reward = 1:2)
    const takeProfitPrice = roundTick(currentPrice * (1 + (stopLossPercent * 2) / 100));

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
    };

    console.log(`[executor] ${candidate.symbol}: FILLED @ $${fillPrice} | STP $${stopPrice} | TP $${takeProfitPrice}`);
    return trade;
  }

  private notifyTrades(trades: ExecutedTrade[]): void {
    const lines = trades.map(
      (t) =>
        `  ${t.symbol}: ${t.quantity} Stk @ $${t.fillPrice.toFixed(2)} ($${t.positionSizeUsd.toFixed(0)})\n` +
        `  Stop: $${t.stopPrice.toFixed(2)} | Target: $${t.takeProfitPrice.toFixed(2)} | Signal: ${t.strength.toFixed(1)}%`,
    );

    const msg = [
      `🤖 *Auto-Trade ausgeführt*`,
      ``,
      `${trades.length} Position${trades.length > 1 ? "en" : ""} eröffnet:`,
      ``,
      ...lines,
      ``,
      `Strategie: Momentum | R:R 1:2 | Modus: Full-Auto`,
    ].join("\n");

    this.onNotify(msg);
  }
}
