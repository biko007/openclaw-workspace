import { EventEmitter } from "node:events";
import {
  IBApi,
  EventName,
  Contract,
  SecType,
  ErrorCode,
  OrderAction,
  OrderType,
  type TickType,
  type ContractDetails,
  type ScannerSubscription,
  type Order,
  type OrderState,
} from "@stoqey/ib";

export interface Position {
  symbol: string;
  exchange: string;
  currency: string;
  quantity: number;
  avgCost: number;
  marketPrice: number;
  marketValue: number;
  unrealizedPnl: number;
  realizedPnl: number;
}

export interface AccountSummary {
  netLiquidation: number;
  cashBalance: number;
  unrealizedPnl: number;
  realizedPnl: number;
  dailyPnl: number;
  received: boolean;
}

export interface ScannerResult {
  rank: number;
  symbol: string;
  exchange: string;
  currency: string;
  secType: string;
}

export interface OrderResult {
  orderId: number;
  symbol: string;
  action: "BUY" | "SELL";
  quantity: number;
  orderType: string;
  limitPrice?: number;
  stopPrice?: number;
  status: string;
  parentId?: number;
  fillPrice?: number;
}

export interface MarketQuote {
  symbol: string;
  last: number;
  bid: number;
  ask: number;
  volume: number;
  timestamp: string;
}

type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

const BACKOFF_STEPS = [5_000, 10_000, 30_000, 60_000, 120_000];

export class IBKRConnection extends EventEmitter {
  private api: IBApi | null = null;
  private host: string;
  private port: number;
  private clientId: number;
  private _state: ConnectionState = "disconnected";
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _reconnectAttempt = 0;
  private nextReqId = 1000;
  private _nextOrderId = 0;
  private account = "";

  constructor() {
    super();
    this.host = process.env.IBKR_HOST || "127.0.0.1";
    this.port = Number(process.env.IBKR_PAPER_PORT) || 7497;
    this.clientId = Number(process.env.IBKR_CLIENT_ID) || 1;
  }

  get state(): ConnectionState {
    return this._state;
  }

  isConnected(): boolean {
    return this._state === "connected";
  }

  getAccount(): string {
    return this.account;
  }

  get reconnectAttempts(): number {
    return this._reconnectAttempt;
  }

  async connect(): Promise<void> {
    if (this._state === "connected" || this._state === "connecting") return;
    this.setState("connecting");

    try {
      this.api = new IBApi({ host: this.host, port: this.port, clientId: this.clientId });

      this.api.on(EventName.connected, () => {
        const wasReconnect = this._reconnectAttempt > 0;
        this._reconnectAttempt = 0;
        this.setState("connected");
        this.api!.reqManagedAccts();
        if (wasReconnect) {
          this.emit("reconnected");
        }
      });

      this.api.on(EventName.disconnected, () => {
        this.setState("disconnected");
        this.scheduleReconnect();
      });

      this.api.on(EventName.error, (_err: Error, code: ErrorCode, _id: number) => {
        // Code -1 = connection lost
        if ((code as number) === -1) {
          this.setState("error");
          this.scheduleReconnect();
        }
      });

      // Catch-all for untyped error events from underlying socket
      (this.api as any).on("error", (err: unknown) => {
        console.log("[ibkr] Socket error (caught):", String(err));
        if (this._state !== "connected") {
          this.setState("error");
          this.scheduleReconnect();
        }
      });

      this.api.on(EventName.managedAccounts, (accountsList: string) => {
        this.account = accountsList.split(",")[0] || "";
        this.emit("account", this.account);
      });

      this.api.on(EventName.nextValidId, (orderId: number) => {
        this._nextOrderId = orderId;
      });

      this.api.connect();
    } catch (e) {
      this.setState("error");
      this.scheduleReconnect();
    }
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      this.api?.disconnect();
    } catch {
      // ignore
    }
    this.setState("disconnected");
  }

  reqPositions(): Promise<Position[]> {
    return new Promise((resolve) => {
      if (!this.api || !this.isConnected()) {
        resolve([]);
        return;
      }

      const positions: Position[] = [];
      const timeout = setTimeout(() => {
        cleanup();
        resolve(positions);
      }, 10_000);

      const onPosition = (
        account: string,
        contract: Contract,
        pos: number,
        avgCost?: number,
      ) => {
        if (pos !== 0) {
          positions.push({
            symbol: contract.symbol || "",
            exchange: contract.primaryExch || contract.exchange || "",
            currency: contract.currency || "USD",
            quantity: pos,
            avgCost: avgCost ?? 0,
            marketPrice: 0,
            marketValue: 0,
            unrealizedPnl: 0,
            realizedPnl: 0,
          });
        }
      };

      const onPositionEnd = () => {
        clearTimeout(timeout);
        cleanup();
        resolve(positions);
      };

      const cleanup = () => {
        (this.api as any)?.removeListener(EventName.position, onPosition);
        (this.api as any)?.removeListener(EventName.positionEnd, onPositionEnd);
      };

      this.api.on(EventName.position, onPosition);
      this.api.on(EventName.positionEnd, onPositionEnd);
      this.api.reqPositions();
    });
  }

  reqAccountSummary(): Promise<AccountSummary> {
    return new Promise((resolve) => {
      if (!this.api || !this.isConnected()) {
        resolve({
          netLiquidation: 0,
          cashBalance: 0,
          unrealizedPnl: 0,
          realizedPnl: 0,
          dailyPnl: 0,
          received: false,
        });
        return;
      }

      const reqId = this.nextReqId++;
      const summary: AccountSummary = {
        netLiquidation: 0,
        cashBalance: 0,
        unrealizedPnl: 0,
        realizedPnl: 0,
        dailyPnl: 0,
        received: false,
      };

      const timeout = setTimeout(() => {
        cleanup();
        resolve(summary);
      }, 10_000);

      const onSummary = (
        id: number,
        account: string,
        tag: string,
        value: string,
        currency: string,
      ) => {
        if (id !== reqId) return;
        const v = parseFloat(value) || 0;
        summary.received = true;
        switch (tag) {
          case "NetLiquidation":
            summary.netLiquidation = v;
            break;
          case "TotalCashValue":
            summary.cashBalance = v;
            break;
          case "UnrealizedPnL":
            summary.unrealizedPnl = v;
            break;
          case "RealizedPnL":
            summary.realizedPnl = v;
            break;
        }
      };

      const onEnd = (id: number) => {
        if (id !== reqId) return;
        clearTimeout(timeout);
        cleanup();
        this.api!.cancelAccountSummary(reqId);
        resolve(summary);
      };

      const cleanup = () => {
        (this.api as any)?.removeListener(EventName.accountSummary, onSummary);
        (this.api as any)?.removeListener(EventName.accountSummaryEnd, onEnd);
      };

      this.api.on(EventName.accountSummary, onSummary);
      this.api.on(EventName.accountSummaryEnd, onEnd);
      this.api.reqAccountSummary(
        reqId,
        this.account || "All",
        "NetLiquidation,TotalCashValue,UnrealizedPnL,RealizedPnL",
      );
    });
  }

  reqMarketData(symbol: string, exchange: string, currency = "USD"): number {
    if (!this.api || !this.isConnected()) return -1;

    const reqId = this.nextReqId++;
    const contract: Contract = {
      symbol,
      secType: SecType.STK,
      exchange: exchange || "SMART",
      currency,
    };

    this.api.on(EventName.tickPrice, (id: number, tickType: TickType, price: number) => {
      if (id !== reqId) return;
      // tickType 4 = last, 1 = bid, 2 = ask
      const field =
        tickType === 4 ? "last" : tickType === 1 ? "bid" : tickType === 2 ? "ask" : null;
      if (field) {
        this.emit("quote", {
          symbol,
          reqId,
          field,
          price,
          timestamp: new Date().toISOString(),
        });
      }
    });

    this.api.reqMktData(reqId, contract, "", false, false);
    return reqId;
  }

  cancelMarketData(reqId: number): void {
    if (this.api && this.isConnected() && reqId > 0) {
      this.api.cancelMktData(reqId);
    }
  }

  reqScannerSubscription(params: {
    instrument: string;
    locationCode: string;
    scanCode: string;
    numberOfRows: number;
    marketCapAbove?: number;
    aboveVolume?: number;
    abovePrice?: number;
  }): Promise<ScannerResult[]> {
    return new Promise((resolve) => {
      if (!this.api || !this.isConnected()) {
        resolve([]);
        return;
      }

      const reqId = this.nextReqId++;
      const results: ScannerResult[] = [];

      const timeout = setTimeout(() => {
        cleanup();
        try { this.api?.cancelScannerSubscription(reqId); } catch { /* ignore */ }
        resolve(results);
      }, 30_000);

      const onData = (
        id: number,
        rank: number,
        contractDetails: ContractDetails,
        _distance: string,
        _benchmark: string,
        _projection: string,
      ) => {
        if (id !== reqId) return;
        const c = contractDetails.contract;
        results.push({
          rank,
          symbol: c.symbol || "",
          exchange: c.primaryExch || c.exchange || "",
          currency: c.currency || "",
          secType: (c.secType as string) || "",
        });
      };

      const onEnd = (id: number) => {
        if (id !== reqId) return;
        clearTimeout(timeout);
        cleanup();
        try { this.api?.cancelScannerSubscription(reqId); } catch { /* ignore */ }
        resolve(results);
      };

      const cleanup = () => {
        (this.api as any)?.removeListener(EventName.scannerData, onData);
        (this.api as any)?.removeListener(EventName.scannerDataEnd, onEnd);
      };

      this.api.on(EventName.scannerData, onData);
      this.api.on(EventName.scannerDataEnd, onEnd);

      const subscription: ScannerSubscription = {
        instrument: params.instrument as any,
        locationCode: params.locationCode as any,
        scanCode: params.scanCode as any,
        numberOfRows: params.numberOfRows,
        marketCapAbove: params.marketCapAbove,
        aboveVolume: params.aboveVolume,
        abovePrice: params.abovePrice,
      };

      this.api.reqScannerSubscription(reqId, subscription);
    });
  }

  // ── Order Placement ──

  private getNextOrderId(): number {
    return this._nextOrderId++;
  }

  /**
   * Place BUY order, wait for fill, then place Stop-Loss + Take-Profit.
   * Sequential execution ensures stops are only active after entry fills.
   */
  async placeBracketOrder(params: {
    symbol: string;
    exchange: string;
    currency: string;
    quantity: number;
    limitPrice: number;
    stopPrice: number;
    takeProfitPrice?: number;
  }): Promise<{ entry: OrderResult; stopLoss?: OrderResult; takeProfit?: OrderResult }> {
    if (!this.api || !this.isConnected()) {
      throw new Error("IBKR not connected");
    }

    const contract: Contract = {
      symbol: params.symbol,
      secType: SecType.STK,
      exchange: params.exchange || "SMART",
      currency: params.currency || "USD",
    };

    // Step 1: Place BUY LIMIT order and wait for fill
    const entryId = this.getNextOrderId();
    const entryOrder: Order = {
      orderId: entryId,
      action: OrderAction.BUY,
      orderType: OrderType.LMT,
      totalQuantity: params.quantity,
      lmtPrice: params.limitPrice,
      transmit: true,
    };

    console.log(`[ibkr] Step 1/2: BUY ${params.quantity} ${params.symbol} LMT@${params.limitPrice}`);
    const fillResult = await this.placeAndWaitForFill(entryId, contract, entryOrder, 30_000);

    if (!fillResult.filled) {
      console.log(`[ibkr] BUY ${params.symbol} not filled in 30s — cancelling`);
      try { this.api!.cancelOrder(entryId); } catch { /* ignore */ }
      return {
        entry: {
          orderId: entryId,
          symbol: params.symbol,
          action: "BUY",
          quantity: params.quantity,
          orderType: "LMT",
          limitPrice: params.limitPrice,
          status: "Cancelled",
        },
      };
    }

    console.log(`[ibkr] BUY ${params.symbol} filled @ ${fillResult.avgFillPrice}`);

    // Step 2: Place Stop-Loss + Take-Profit (OCA group — one cancels the other)
    const ocaGroup = `OCA_${params.symbol}_${Date.now()}`;
    const stopId = this.getNextOrderId();

    const stopOrder: Order = {
      orderId: stopId,
      action: OrderAction.SELL,
      orderType: OrderType.STP,
      totalQuantity: params.quantity,
      auxPrice: params.stopPrice,
      ocaGroup,
      transmit: params.takeProfitPrice ? false : true,
    };

    this.api!.placeOrder(stopId, contract, stopOrder);

    let tpResult: OrderResult | undefined;

    if (params.takeProfitPrice) {
      const tpId = this.getNextOrderId();
      const tpOrder: Order = {
        orderId: tpId,
        action: OrderAction.SELL,
        orderType: OrderType.LMT,
        totalQuantity: params.quantity,
        lmtPrice: params.takeProfitPrice,
        ocaGroup,
        transmit: true, // transmit both exit orders
      };
      this.api!.placeOrder(tpId, contract, tpOrder);

      tpResult = {
        orderId: tpId,
        symbol: params.symbol,
        action: "SELL",
        quantity: params.quantity,
        orderType: "LMT",
        limitPrice: params.takeProfitPrice,
        status: "Submitted",
      };
      console.log(`[ibkr] Step 2/2: STP@${params.stopPrice} + TP@${params.takeProfitPrice} (OCA: ${ocaGroup})`);
    } else {
      console.log(`[ibkr] Step 2/2: STP@${params.stopPrice}`);
    }

    return {
      entry: {
        orderId: entryId,
        symbol: params.symbol,
        action: "BUY",
        quantity: params.quantity,
        orderType: "LMT",
        limitPrice: params.limitPrice,
        fillPrice: fillResult.avgFillPrice,
        status: "Filled",
      },
      stopLoss: {
        orderId: stopId,
        symbol: params.symbol,
        action: "SELL",
        quantity: params.quantity,
        orderType: "STP",
        stopPrice: params.stopPrice,
        status: "Submitted",
      },
      takeProfit: tpResult,
    };
  }

  /**
   * Place an order and wait for fill confirmation from IBKR.
   */
  private placeAndWaitForFill(
    orderId: number,
    contract: Contract,
    order: Order,
    timeoutMs: number,
  ): Promise<{ filled: boolean; avgFillPrice: number }> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        cleanup();
        resolve({ filled: false, avgFillPrice: 0 });
      }, timeoutMs);

      const onStatus = (
        id: number,
        status: string,
        _filled: number,
        _remaining: number,
        avgFillPrice: number,
      ) => {
        if (id !== orderId) return;
        if (status === "Filled") {
          clearTimeout(timeout);
          cleanup();
          resolve({ filled: true, avgFillPrice });
        } else if (status === "Cancelled" || status === "Inactive") {
          clearTimeout(timeout);
          cleanup();
          resolve({ filled: false, avgFillPrice: 0 });
        }
      };

      const onError = (err: Error, code: ErrorCode, id: number) => {
        if (id !== orderId) return;
        clearTimeout(timeout);
        cleanup();
        console.error(`[ibkr] Order ${id} error (${code}): ${err.message}`);
        resolve({ filled: false, avgFillPrice: 0 });
      };

      const cleanup = () => {
        (this.api as any)?.removeListener(EventName.orderStatus, onStatus);
        (this.api as any)?.removeListener(EventName.error, onError);
      };

      this.api!.on(EventName.orderStatus, onStatus);
      this.api!.on(EventName.error, onError);
      this.api!.placeOrder(orderId, contract, order);
    });
  }

  private setState(state: ConnectionState): void {
    if (this._state === state) return;
    this._state = state;
    this.emit("state", state);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = BACKOFF_STEPS[Math.min(this._reconnectAttempt, BACKOFF_STEPS.length - 1)];
    this._reconnectAttempt++;
    if (this._reconnectAttempt > BACKOFF_STEPS.length) {
      this.emit("reconnectFailed", this._reconnectAttempt);
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
