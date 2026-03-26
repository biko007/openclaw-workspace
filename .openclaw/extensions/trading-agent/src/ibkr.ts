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

const BACKOFF_STEPS = [5_000, 10_000, 30_000];

export class IBKRConnection extends EventEmitter {
  private api: IBApi | null = null;
  private host: string;
  private port: number;
  private clientId: number;
  private _state: ConnectionState = "disconnected";
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
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

  async connect(): Promise<void> {
    if (this._state === "connected" || this._state === "connecting") return;
    this.setState("connecting");

    try {
      this.api = new IBApi({ host: this.host, port: this.port, clientId: this.clientId });

      this.api.on(EventName.connected, () => {
        this.reconnectAttempt = 0;
        this.setState("connected");
        this.api!.reqManagedAccts();
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
        "All",
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
   * Place a bracket order: LIMIT BUY + STOP SELL (stop-loss).
   * Returns both order results.
   */
  async placeBracketOrder(params: {
    symbol: string;
    exchange: string;
    currency: string;
    quantity: number;
    limitPrice: number;
    stopPrice: number;
  }): Promise<{ entry: OrderResult; stopLoss: OrderResult }> {
    if (!this.api || !this.isConnected()) {
      throw new Error("IBKR not connected");
    }

    const contract: Contract = {
      symbol: params.symbol,
      secType: SecType.STK,
      exchange: params.exchange || "SMART",
      currency: params.currency || "USD",
    };

    const parentId = this.getNextOrderId();
    const childId = this.getNextOrderId();

    // Parent: LIMIT BUY
    const parentOrder: Order = {
      orderId: parentId,
      action: OrderAction.BUY,
      orderType: OrderType.LMT,
      totalQuantity: params.quantity,
      lmtPrice: params.limitPrice,
      transmit: false, // don't transmit until child is attached
    };

    // Child: STOP SELL (stop-loss)
    const childOrder: Order = {
      orderId: childId,
      action: OrderAction.SELL,
      orderType: OrderType.STP,
      totalQuantity: params.quantity,
      auxPrice: params.stopPrice,
      parentId,
      transmit: true, // transmit both orders together
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        resolve({
          entry: {
            orderId: parentId,
            symbol: params.symbol,
            action: "BUY",
            quantity: params.quantity,
            orderType: "LMT",
            limitPrice: params.limitPrice,
            status: "Submitted",
          },
          stopLoss: {
            orderId: childId,
            symbol: params.symbol,
            action: "SELL",
            quantity: params.quantity,
            orderType: "STP",
            stopPrice: params.stopPrice,
            status: "PreSubmitted",
            parentId,
          },
        });
      }, 5_000);

      const results = new Map<number, string>();

      const onOrderStatus = (
        orderId: number,
        status: string,
      ) => {
        if (orderId === parentId || orderId === childId) {
          results.set(orderId, status);
          if (results.size >= 2) {
            clearTimeout(timeout);
            cleanup();
            resolve({
              entry: {
                orderId: parentId,
                symbol: params.symbol,
                action: "BUY",
                quantity: params.quantity,
                orderType: "LMT",
                limitPrice: params.limitPrice,
                status: results.get(parentId) || "Submitted",
              },
              stopLoss: {
                orderId: childId,
                symbol: params.symbol,
                action: "SELL",
                quantity: params.quantity,
                orderType: "STP",
                stopPrice: params.stopPrice,
                status: results.get(childId) || "PreSubmitted",
                parentId,
              },
            });
          }
        }
      };

      const onError = (err: Error, code: ErrorCode, id: number) => {
        if (id === parentId || id === childId) {
          clearTimeout(timeout);
          cleanup();
          reject(new Error(`Order ${id} error (${code}): ${err.message}`));
        }
      };

      const cleanup = () => {
        (this.api as any)?.removeListener(EventName.orderStatus, onOrderStatus);
        (this.api as any)?.removeListener(EventName.error, onError);
      };

      this.api!.on(EventName.orderStatus, onOrderStatus);
      this.api!.on(EventName.error, onError);

      // Place both orders
      this.api!.placeOrder(parentId, contract, parentOrder);
      this.api!.placeOrder(childId, contract, childOrder);

      console.log(`[ibkr] Bracket order placed: BUY ${params.quantity} ${params.symbol} @ ${params.limitPrice} | STP @ ${params.stopPrice}`);
    });
  }

  private setState(state: ConnectionState): void {
    if (this._state === state) return;
    this._state = state;
    this.emit("state", state);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = BACKOFF_STEPS[Math.min(this.reconnectAttempt, BACKOFF_STEPS.length - 1)];
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
