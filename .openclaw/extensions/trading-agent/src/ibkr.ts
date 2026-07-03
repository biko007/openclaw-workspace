import { EventEmitter } from "node:events";
import {
  IBApi,
  EventName,
  Contract,
  SecType,
  ErrorCode,
  OrderAction,
  OrderType,
  TimeInForce,
  type TickType,
  type ContractDetails,
  type ScannerSubscription,
  type Order,
  type OrderState,
} from "@stoqey/ib";
import {
  OrderIdSequencer,
  OrderStateTracker,
  isOwnOrderRef,
  parseOrderRef,
  buildOrderRef,
  buildOcaGroup,
  type OrderEvent,
} from "./order-state-tracker.js";

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

export interface ExitFillInfo {
  orderRef: string;
  symbol: string;
  leg: "stop" | "tp";
  fillPrice: number;
  quantity: number;
  entryPrice?: number;
}

// ── Sync Barrier Types (E3a) ──

export interface SyncPosition {
  symbol: string;
  conId: number;
  exchange: string;
  currency: string;
  quantity: number;
  avgCost: number;
}

export interface SyncOpenOrder {
  orderId: number;
  permId?: number;
  clientId?: number;
  symbol: string;
  conId: number;
  action: string;
  orderType: string;
  totalQuantity: number;
  lmtPrice?: number;
  auxPrice?: number;
  tif: string;
  ocaGroup: string;
  ocaType?: number;
  status: string;
  parentId: number;
  orderRef: string;
}

export interface SyncExecution {
  orderId: number;
  symbol: string;
  conId: number;
  side: string;
  shares: number;
  price: number;
  cumQty: number;
  avgPrice: number;
  execId: string;
  time: string;
  orderRef: string;
}

export interface SyncCompletedOrder {
  symbol: string;
  conId: number;
  action: string;
  totalQuantity: number;
  status: string;
  orderRef: string;
  permId?: number;
}

export interface SyncSnapshot {
  readonly timestamp: string;
  readonly ownOrders: readonly SyncOpenOrder[];
  readonly foreignOrders: readonly SyncOpenOrder[];
  readonly positions: readonly SyncPosition[];
  readonly backfilledExecutions: readonly SyncExecution[];
  readonly completedOrders: readonly SyncCompletedOrder[];
  readonly isReconnect: boolean;
  readonly timedOutPhases: readonly string[];
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
  private _sequencer = new OrderIdSequencer();
  private account = "";
  private _tracker: OrderStateTracker | null = null;
  private _orderIdToRef = new Map<number, string>();
  private _syncInProgress = false;
  private _guardianLocked = false;
  private _reconnectCooldownUntil = 0;
  private _lastExecSyncTime: string | null = null;

  constructor() {
    super();
    this.host = process.env.IBKR_HOST || "127.0.0.1";
    this.port = Number(process.env.IBKR_PAPER_PORT) || 7497;
    this.clientId = Number(process.env.IBKR_CLIENT_ID) || 1;
  }

  /**
   * Set the tracker instance. Called from index.ts after rebuild().
   */
  setTracker(tracker: OrderStateTracker): void {
    this._tracker = tracker;
  }

  /**
   * Register an orderId→orderRef mapping. Called from executor (E5).
   */
  registerOrderRef(orderId: number, orderRef: string): void {
    this._orderIdToRef.set(orderId, orderRef);
  }

  // ── Stable bound handlers — re-registered on each new IBApi instance in connect() ──

  private _handleOrderStatus = (
    orderId: number,
    status: string,
    filled: number,
    remaining: number,
    avgFillPrice: number,
    permId?: number,
    parentId?: number,
    lastFillPrice?: number,
  ): void => {
    this._sequencer.trackSeenId(orderId);
    // Re-emit on IBKRConnection level
    this.emit("orderStatus", orderId, status, filled, remaining, avgFillPrice, permId, lastFillPrice);
    // Tracker integration: only if orderRef known
    const orderRef = this._orderIdToRef.get(orderId);
    if (orderRef && this._tracker) {
      this._tracker.applyEvent({
        type: "order_status_changed",
        timestamp: new Date().toISOString(),
        orderRef,
        orderId,
        permId: permId ?? undefined,
        status,
        filled,
        remaining,
        avgFillPrice,
        lastFillPrice,
      });
      // Exit-fill detection
      if (status === "Filled") {
        this._checkExitFill(orderRef, avgFillPrice);
      }
    }
  };

  private _handleOpenOrder = (
    orderId: number,
    contract: Contract,
    order: Order,
    orderState: OrderState,
  ): void => {
    this._sequencer.trackSeenId(orderId);
    // Populate orderIdToRef from order.orderRef (for all own orders)
    if (order.orderRef && isOwnOrderRef(order.orderRef)) {
      this._orderIdToRef.set(orderId, order.orderRef);
    }
    this.emit("openOrder", orderId, contract, order, orderState);
  };

  private _handleExecDetails = (
    reqId: number,
    contract: Contract,
    execution: { orderId?: number; orderRef?: string; execId?: string; side?: string; shares?: number; price?: number; cumQty?: number; avgPrice?: number },
  ): void => {
    if (execution.orderId) {
      this._sequencer.trackSeenId(execution.orderId);
    }
    // Populate orderIdToRef from execution.orderRef
    if (execution.orderId && execution.orderRef && isOwnOrderRef(execution.orderRef)) {
      this._orderIdToRef.set(execution.orderId, execution.orderRef);
    }
    // Tracker integration: create order_filled event
    const orderRef = execution.orderId ? this._orderIdToRef.get(execution.orderId) : undefined;
    if (orderRef && this._tracker && execution.execId) {
      const execId = execution.execId;
      const lastDot = execId.lastIndexOf(".");
      const execBase = lastDot > 0 ? execId.substring(0, lastDot) : execId;
      this._tracker.applyEvent({
        type: "order_filled",
        timestamp: new Date().toISOString(),
        orderRef,
        orderId: execution.orderId,
        execId,
        execIdBase: execBase,
        side: execution.side ?? "",
        shares: execution.shares ?? 0,
        price: execution.price ?? 0,
        cumQty: execution.cumQty ?? 0,
        avgPrice: execution.avgPrice ?? 0,
      });
    }
    this.emit("execDetails", reqId, contract, execution);
  };

  private _handleOrderError = (
    err: Error,
    code: number,
    id: number,
  ): void => {
    // Only handle order-related errors (id > 0). Connection errors (code=-1)
    // are handled by the existing connection error handler.
    if (id > 0) {
      this._sequencer.trackSeenId(id);
      const orderRef = this._orderIdToRef.get(id);
      if (orderRef && this._tracker) {
        this._tracker.applyEvent({
          type: "order_error",
          timestamp: new Date().toISOString(),
          orderRef,
          orderId: id,
          errorCode: code,
          errorMessage: err.message,
        });
      }
      this.emit("orderError", id, code, err.message);
    }
  };

  /**
   * Check if a filled order is an exit (stop/tp) and emit exitFill.
   * Inactive until E5 — live orders carry orderRef tags only from E5 onwards.
   * This path fires only when placeBracketOrder/executor use the new orderRef schemas.
   */
  private _checkExitFill(orderRef: string, fillPrice: number): void {
    const parsed = parseOrderRef(orderRef);
    if (!parsed || (parsed.leg !== "stop" && parsed.leg !== "tp")) return;

    // Try to extract symbol and quantity from tracker's order_submitted event
    let symbol = "";
    let quantity = 0;
    let entryPrice: number | undefined;
    if (this._tracker) {
      const events = this._tracker.getEventsForOrder(orderRef);
      for (const ev of events) {
        if (ev.type === "order_submitted") {
          symbol = (ev as any).symbol ?? "";
          quantity = (ev as any).quantity ?? 0;
        }
      }
      // Look for entry price from the entry leg of the same tradeIntentId
      const entryRef = orderRef.replace(`|${parsed.leg}|`, "|entry|");
      const entryEvents = this._tracker.getEventsForOrder(entryRef);
      for (const ev of entryEvents) {
        if (ev.type === "order_filled") {
          entryPrice = (ev as any).avgPrice;
        }
      }
    }

    this.emit("exitFill", {
      orderRef,
      symbol,
      leg: parsed.leg,
      fillPrice,
      quantity,
      entryPrice,
    } satisfies ExitFillInfo);
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

  get guardianLocked(): boolean {
    return this._guardianLocked;
  }

  get syncInProgress(): boolean {
    return this._syncInProgress;
  }

  isReconnectCooldownActive(): boolean {
    return Date.now() < this._reconnectCooldownUntil;
  }

  async connect(): Promise<void> {
    if (this._state === "connected" || this._state === "connecting") return;
    this.setState("connecting");

    try {
      this.api = new IBApi({ host: this.host, port: this.port, clientId: this.clientId });

      // Permanent listeners — re-registered on each new IBApi instance.
      // Old IBApi is GC'd, so no listener accumulation.
      this.api.on(EventName.orderStatus, this._handleOrderStatus);
      this.api.on(EventName.openOrder, this._handleOpenOrder);
      this.api.on(EventName.execDetails, this._handleExecDetails);
      this.api.on(EventName.error, this._handleOrderError);

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
        this._sequencer.setNextValidId(orderId);
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
          case "DailyPnL":
            summary.dailyPnl = v;
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
      // Group must be "All" — account IDs are not valid group names and cause
      // "Unified group name is invalid" errors (~2k/day)
      this.api.reqAccountSummary(
        reqId,
        "All",
        "NetLiquidation,TotalCashValue,UnrealizedPnL,RealizedPnL,DailyPnL",
      );
    });
  }

  // ── Sync Barrier (E3a) ──

  async runSyncBarrier(options?: { isReconnect?: boolean }): Promise<SyncSnapshot> {
    const isReconnect = options?.isReconnect ?? false;
    const PHASE_TIMEOUT = 30_000;

    if (this._syncInProgress) {
      throw new Error("Sync barrier already in progress");
    }
    if (!this.api || !this.isConnected()) {
      throw new Error("IBKR not connected");
    }

    this._syncInProgress = true;
    this._guardianLocked = true;
    const timedOutPhases: string[] = [];
    const isInitialOrReconnect = isReconnect || this._lastExecSyncTime === null;

    try {
      if (isReconnect) {
        this._reconnectCooldownUntil = Date.now() + 60_000;
        console.log("[sync-barrier] Reconnect cooldown set for 60s");
      }

      // Phase 1: All open orders
      const allOrders = await this._collectOpenOrders(PHASE_TIMEOUT, timedOutPhases);

      // Phase 2: Positions
      const positions = await this._collectPositions(PHASE_TIMEOUT, timedOutPhases);

      // Phase 3: Executions backfill + completed orders (only at start/reconnect)
      let executions: SyncExecution[] = [];
      let completedOrders: SyncCompletedOrder[] = [];
      if (isInitialOrReconnect) {
        executions = await this._collectExecutions(PHASE_TIMEOUT, timedOutPhases);
        completedOrders = await this._collectCompletedOrders(PHASE_TIMEOUT, timedOutPhases);
        this._lastExecSyncTime = this._formatExecTime(new Date());
      }

      // Phase 4: Sequencer re-arm from all seen orderIds
      for (const order of allOrders) {
        this._sequencer.trackSeenId(order.orderId);
      }
      for (const exec of executions) {
        if (exec.orderId > 0) {
          this._sequencer.trackSeenId(exec.orderId);
        }
      }

      // Phase 5: Foreign-order filter (I2)
      const ownOrders: SyncOpenOrder[] = [];
      const foreignOrders: SyncOpenOrder[] = [];
      for (const order of allOrders) {
        if (order.orderRef && isOwnOrderRef(order.orderRef)) {
          ownOrders.push(order);
        } else {
          foreignOrders.push(order);
        }
      }

      // Phase 6: Freeze snapshot
      const snapshot: SyncSnapshot = Object.freeze({
        timestamp: new Date().toISOString(),
        ownOrders: Object.freeze(ownOrders),
        foreignOrders: Object.freeze(foreignOrders),
        positions: Object.freeze([...positions]),
        backfilledExecutions: Object.freeze(executions),
        completedOrders: Object.freeze(completedOrders),
        isReconnect,
        timedOutPhases: Object.freeze([...timedOutPhases]),
      });

      if (timedOutPhases.length > 0) {
        console.warn(`[sync-barrier] Completed with timeouts: ${timedOutPhases.join(", ")}`);
      } else {
        console.log(
          `[sync-barrier] Complete: ${ownOrders.length} own, ${foreignOrders.length} foreign, ` +
          `${positions.length} pos, ${executions.length} exec, ${completedOrders.length} completed`,
        );
      }

      this.emit("syncComplete", snapshot);
      return snapshot;
    } finally {
      this._syncInProgress = false;
      this._guardianLocked = false;
    }
  }

  private _collectOpenOrders(
    timeoutMs: number,
    timedOutPhases: string[],
  ): Promise<SyncOpenOrder[]> {
    return new Promise((resolve) => {
      const orders: SyncOpenOrder[] = [];
      const timeout = setTimeout(() => {
        console.warn("[sync-barrier] WARN: reqAllOpenOrders timed out");
        timedOutPhases.push("openOrders");
        cleanup();
        resolve(orders);
      }, timeoutMs);

      const onOpenOrder = (
        orderId: number,
        contract: Contract,
        order: Order,
        orderState: OrderState,
      ) => {
        orders.push({
          orderId,
          permId: order.permId,
          clientId: order.clientId,
          symbol: contract.symbol ?? "",
          conId: contract.conId ?? 0,
          action: order.action ?? "",
          orderType: order.orderType ?? "",
          totalQuantity: order.totalQuantity ?? 0,
          lmtPrice: order.lmtPrice,
          auxPrice: order.auxPrice,
          tif: order.tif ?? "",
          ocaGroup: order.ocaGroup ?? "",
          ocaType: order.ocaType,
          status: String(orderState.status ?? ""),
          parentId: order.parentId ?? 0,
          orderRef: order.orderRef ?? "",
        });
      };

      const onEnd = () => {
        clearTimeout(timeout);
        cleanup();
        resolve(orders);
      };

      const cleanup = () => {
        (this.api as any)?.removeListener(EventName.openOrder, onOpenOrder);
        (this.api as any)?.removeListener(EventName.openOrderEnd, onEnd);
      };

      this.api!.on(EventName.openOrder, onOpenOrder);
      this.api!.on(EventName.openOrderEnd, onEnd);
      this.api!.reqAllOpenOrders();
    });
  }

  private _collectPositions(
    timeoutMs: number,
    timedOutPhases: string[],
  ): Promise<SyncPosition[]> {
    return new Promise((resolve) => {
      const positions: SyncPosition[] = [];
      const timeout = setTimeout(() => {
        console.warn("[sync-barrier] WARN: reqPositions timed out");
        timedOutPhases.push("positions");
        cleanup();
        resolve(positions);
      }, timeoutMs);

      const onPosition = (
        _account: string,
        contract: Contract,
        pos: number,
        avgCost?: number,
      ) => {
        if (pos !== 0) {
          positions.push({
            symbol: contract.symbol || "",
            conId: contract.conId ?? 0,
            exchange: contract.primaryExch || contract.exchange || "",
            currency: contract.currency || "USD",
            quantity: pos,
            avgCost: avgCost ?? 0,
          });
        }
      };

      const onEnd = () => {
        clearTimeout(timeout);
        cleanup();
        resolve(positions);
      };

      const cleanup = () => {
        (this.api as any)?.removeListener(EventName.position, onPosition);
        (this.api as any)?.removeListener(EventName.positionEnd, onEnd);
      };

      this.api!.on(EventName.position, onPosition);
      this.api!.on(EventName.positionEnd, onEnd);
      this.api!.reqPositions();
    });
  }

  private _collectExecutions(
    timeoutMs: number,
    timedOutPhases: string[],
  ): Promise<SyncExecution[]> {
    return new Promise((resolve) => {
      const reqId = this.nextReqId++;
      const executions: SyncExecution[] = [];
      const timeout = setTimeout(() => {
        console.warn("[sync-barrier] WARN: reqExecutions timed out");
        timedOutPhases.push("executions");
        cleanup();
        resolve(executions);
      }, timeoutMs);

      const onExecDetails = (id: number, contract: Contract, execution: any) => {
        if (id !== reqId) return;
        executions.push({
          orderId: execution.orderId ?? 0,
          symbol: contract.symbol ?? "",
          conId: contract.conId ?? 0,
          side: execution.side ?? "",
          shares: execution.shares ?? 0,
          price: execution.price ?? 0,
          cumQty: execution.cumQty ?? 0,
          avgPrice: execution.avgPrice ?? 0,
          execId: execution.execId ?? "",
          time: execution.time ?? "",
          orderRef: execution.orderRef ?? "",
        });
      };

      const onEnd = (id: number) => {
        if (id !== reqId) return;
        clearTimeout(timeout);
        cleanup();
        resolve(executions);
      };

      const cleanup = () => {
        (this.api as any)?.removeListener(EventName.execDetails, onExecDetails);
        (this.api as any)?.removeListener(EventName.execDetailsEnd, onEnd);
      };

      this.api!.on(EventName.execDetails, onExecDetails);
      this.api!.on(EventName.execDetailsEnd, onEnd);

      const filter: { time?: string } = {};
      if (this._lastExecSyncTime) {
        filter.time = this._lastExecSyncTime;
      } else {
        filter.time = this._formatExecTime(new Date(), true);
      }
      this.api!.reqExecutions(reqId, filter);
    });
  }

  private _collectCompletedOrders(
    timeoutMs: number,
    timedOutPhases: string[],
  ): Promise<SyncCompletedOrder[]> {
    return new Promise((resolve) => {
      if (typeof (this.api as any)?.reqCompletedOrders !== "function") {
        console.warn("[sync-barrier] reqCompletedOrders not available, skipping");
        resolve([]);
        return;
      }

      const orders: SyncCompletedOrder[] = [];
      const timeout = setTimeout(() => {
        console.warn("[sync-barrier] WARN: reqCompletedOrders timed out");
        timedOutPhases.push("completedOrders");
        cleanup();
        resolve(orders);
      }, timeoutMs);

      const onCompleted = (contract: Contract, order: Order, orderState: OrderState) => {
        orders.push({
          symbol: contract.symbol ?? "",
          conId: contract.conId ?? 0,
          action: order.action ?? "",
          totalQuantity: order.totalQuantity ?? 0,
          status: String(orderState.status ?? ""),
          orderRef: order.orderRef ?? "",
          permId: order.permId,
        });
      };

      const onEnd = () => {
        clearTimeout(timeout);
        cleanup();
        resolve(orders);
      };

      const cleanup = () => {
        (this.api as any)?.removeListener(EventName.completedOrder, onCompleted);
        (this.api as any)?.removeListener(EventName.completedOrdersEnd, onEnd);
      };

      this.api!.on(EventName.completedOrder, onCompleted);
      this.api!.on(EventName.completedOrdersEnd, onEnd);
      (this.api as any).reqCompletedOrders(true);
    });
  }

  private _formatExecTime(d: Date, startOfDay = false): string {
    const yyyy = String(d.getUTCFullYear());
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    if (startOfDay) return `${yyyy}${mm}${dd}-00:00:00`;
    const hh = String(d.getUTCHours()).padStart(2, "0");
    const min = String(d.getUTCMinutes()).padStart(2, "0");
    const ss = String(d.getUTCSeconds()).padStart(2, "0");
    return `${yyyy}${mm}${dd}-${hh}:${min}:${ss}`;
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

  /**
   * Place a market SELL order and wait for fill.
   */
  async placeMarketSell(params: {
    symbol: string;
    exchange: string;
    currency: string;
    quantity: number;
  }): Promise<OrderResult> {
    if (!this.api || !this.isConnected()) {
      throw new Error("IBKR not connected");
    }

    const contract: Contract = {
      symbol: params.symbol,
      secType: SecType.STK,
      exchange: params.exchange || "SMART",
      currency: params.currency || "USD",
    };

    const orderId = this.getNextOrderId();
    const order: Order = {
      orderId,
      action: OrderAction.SELL,
      orderType: OrderType.MKT,
      totalQuantity: params.quantity,
      transmit: true,
    };

    console.log(`[ibkr] MKT SELL ${params.quantity} ${params.symbol}`);
    const result = await this.placeAndWaitForFill(orderId, contract, order, 30_000);

    if (!result.filled) {
      throw new Error(`MKT SELL ${params.symbol} not filled in 30s`);
    }

    console.log(`[ibkr] SELL ${params.symbol} filled @ ${result.avgFillPrice}`);

    return {
      orderId,
      symbol: params.symbol,
      action: "SELL",
      quantity: params.quantity,
      orderType: "MKT",
      fillPrice: result.avgFillPrice,
      status: "Filled",
    };
  }

  get sequencer(): OrderIdSequencer {
    return this._sequencer;
  }

  private getNextOrderId(): number {
    return this._sequencer.next();
  }

  /**
   * Resolve conId for a stock symbol via reqContractDetails.
   * Uses internal reqId counter (not the order sequencer). Timeout 10s.
   */
  async resolveContractId(
    symbol: string,
    exchange: string,
    currency: string,
  ): Promise<number> {
    if (!this.api || !this.isConnected()) {
      throw new Error("IBKR not connected");
    }
    const reqId = this.nextReqId++;
    const contract: Contract = {
      symbol,
      secType: SecType.STK,
      exchange: exchange || "SMART",
      currency: currency || "USD",
    };

    return new Promise<number>((resolve, reject) => {
      let done = false;
      const timeout = setTimeout(() => {
        if (done) return;
        done = true;
        cleanup();
        reject(new Error(`resolveContractId timeout for ${symbol}`));
      }, 10_000);

      const onDetails = (_id: number, details: ContractDetails) => {
        if (_id !== reqId || done) return;
        done = true;
        clearTimeout(timeout);
        cleanup();
        const conId = details.contract.conId;
        if (conId == null) {
          reject(new Error(`resolveContractId: no conId for ${symbol}`));
        } else {
          resolve(conId);
        }
      };

      const onError = (_err: Error, code: number, id: number) => {
        if (id !== reqId || done) return;
        done = true;
        clearTimeout(timeout);
        cleanup();
        reject(new Error(`resolveContractId error for ${symbol}: code=${code} ${_err.message}`));
      };

      const cleanup = () => {
        (this.api as any)?.removeListener("contractDetails", onDetails);
        (this.api as any)?.removeListener("error", onError);
      };

      (this.api as any).on("contractDetails", onDetails);
      (this.api as any).on("error", onError);
      this.api!.reqContractDetails(reqId, contract);
    });
  }

  /**
   * E5: Place BUY entry with fill-monitoring + automatic exit placement.
   * Handles partial fills (exit qty = cumQty from execDetails), timeout,
   * and gen-increment for subsequent partial fills.
   */
  async placeBracketOrder(params: {
    symbol: string;
    exchange: string;
    currency: string;
    quantity: number;
    limitPrice: number;
    stopPrice: number;
    takeProfitPrice: number;
    tradeIntentId: string;
    conId: number;
  }): Promise<{
    entry: OrderResult;
    stopLoss?: OrderResult;
    takeProfit?: OrderResult;
    actualFilledQty: number;
    exitGen: number;
  }> {
    if (!this.api || !this.isConnected()) {
      throw new Error("IBKR not connected");
    }

    const account = this.account;
    const {
      symbol, exchange, currency, quantity, limitPrice,
      stopPrice, takeProfitPrice, tradeIntentId, conId,
    } = params;

    const contract: Contract = {
      symbol,
      secType: SecType.STK,
      exchange: exchange || "SMART",
      currency: currency || "USD",
      conId,
    };

    // ── Entry Phase ──
    const entryId = this.getNextOrderId();
    const entryRef = buildOrderRef({
      account, tradeIntentId, conId, leg: "entry", gen: 0,
    });

    // Log order_submitted for entry BEFORE placement
    if (this._tracker) {
      this._tracker.applyEvent({
        type: "order_submitted",
        timestamp: new Date().toISOString(),
        orderRef: entryRef,
        orderId: entryId,
        symbol,
        conId,
        action: "BUY",
        orderType: "LMT",
        quantity,
        limitPrice,
        tif: "DAY",
        exchange,
        currency,
      });
    }

    this.registerOrderRef(entryId, entryRef);

    const entryOrder: Order = {
      orderId: entryId,
      action: OrderAction.BUY,
      orderType: OrderType.LMT,
      totalQuantity: quantity,
      lmtPrice: limitPrice,
      transmit: true,
      orderRef: entryRef,
    };

    console.log(
      `[ibkr] E5: BUY ${quantity} ${symbol} LMT@${limitPrice} (ref=${entryRef})`,
    );
    this.api!.placeOrder(entryId, contract, entryOrder);

    // ── Fill Monitoring (Promise-based) ──
    return new Promise((resolve) => {
      let lastExitCumQty = 0;
      let exitGen = -1;
      let currentStopId = 0;
      let currentTpId = 0;
      let exitOpsRunning = false;
      let pendingQty = 0;
      let entryDone = false;
      let entryFillPrice = 0;
      let stopResult: OrderResult | undefined;
      let tpResult: OrderResult | undefined;

      const tryResolve = () => {
        if (entryDone && !exitOpsRunning) {
          cleanup();
          resolve({
            entry: {
              orderId: entryId,
              symbol,
              action: "BUY",
              quantity,
              orderType: "LMT",
              limitPrice,
              fillPrice: entryFillPrice || undefined,
              status: lastExitCumQty > 0 ? "Filled" : "Cancelled",
            },
            stopLoss: stopResult,
            takeProfit: tpResult,
            actualFilledQty: lastExitCumQty,
            exitGen: Math.max(exitGen, 0),
          });
        }
      };

      /** Place STP+TP pair for a given generation. Synchronous (no await). */
      const placeExits = (cumQty: number, gen: number): void => {
        const sId = this.getNextOrderId();
        const tId = this.getNextOrderId();
        const stopRef = buildOrderRef({
          account, tradeIntentId, conId, leg: "stop", gen,
        });
        const tpRef = buildOrderRef({
          account, tradeIntentId, conId, leg: "tp", gen,
        });
        const ocaGroup = buildOcaGroup(tradeIntentId, gen);

        if (this._tracker) {
          this._tracker.applyEvent({
            type: "order_submitted",
            timestamp: new Date().toISOString(),
            orderRef: stopRef,
            orderId: sId,
            symbol,
            conId,
            action: "SELL",
            orderType: "STP",
            quantity: cumQty,
            auxPrice: stopPrice,
            tif: "GTC",
            ocaGroup,
            exchange,
            currency,
          });
          this._tracker.applyEvent({
            type: "order_submitted",
            timestamp: new Date().toISOString(),
            orderRef: tpRef,
            orderId: tId,
            symbol,
            conId,
            action: "SELL",
            orderType: "LMT",
            quantity: cumQty,
            limitPrice: takeProfitPrice,
            tif: "GTC",
            ocaGroup,
            exchange,
            currency,
          });
        }

        this.registerOrderRef(sId, stopRef);
        this.registerOrderRef(tId, tpRef);

        const sOrder: Order = {
          orderId: sId,
          action: OrderAction.SELL,
          orderType: OrderType.STP,
          totalQuantity: cumQty,
          auxPrice: stopPrice,
          tif: TimeInForce.GTC,
          ocaGroup,
          ocaType: 2,
          transmit: true,
          outsideRth: false,
          orderRef: stopRef,
        };

        const tOrder: Order = {
          orderId: tId,
          action: OrderAction.SELL,
          orderType: OrderType.LMT,
          totalQuantity: cumQty,
          lmtPrice: takeProfitPrice,
          tif: TimeInForce.GTC,
          ocaGroup,
          ocaType: 2,
          transmit: true,
          outsideRth: false,
          orderRef: tpRef,
        };

        this.api!.placeOrder(sId, contract, sOrder);
        this.api!.placeOrder(tId, contract, tOrder);

        console.log(
          `[ibkr] E5: Exits gen=${gen} qty=${cumQty} ` +
          `STP@${stopPrice} TP@${takeProfitPrice} (OCA: ${ocaGroup})`,
        );

        stopResult = {
          orderId: sId, symbol, action: "SELL", quantity: cumQty,
          orderType: "STP", stopPrice, status: "Submitted",
        };
        tpResult = {
          orderId: tId, symbol, action: "SELL", quantity: cumQty,
          orderType: "LMT", limitPrice: takeProfitPrice, status: "Submitted",
        };
        currentStopId = sId;
        currentTpId = tId;
      };

      /** Cancel+Replace exits for partial-fill adjustment (I4 two-phase). */
      const replaceExits = async (cumQty: number): Promise<void> => {
        exitOpsRunning = true;
        const newGen = exitGen + 1;
        const oldStopId = currentStopId;
        const oldTpId = currentTpId;

        const intentRef = buildOrderRef({
          account, tradeIntentId, conId, leg: "stop", gen: exitGen,
        });
        if (this._tracker) {
          this._tracker.applyEvent({
            type: "replacement_intent_started",
            timestamp: new Date().toISOString(),
            orderRef: intentRef,
            targetOrderRef: intentRef,
            reason: `partial_fill_adjust cumQty=${cumQty}`,
            newGen: newGen,
          });
        }

        // Phase 1: Place new exits gen+1
        placeExits(cumQty, newGen);

        // Wait for ack on new orders before cancelling old ones
        await this.waitForOrderAck(currentStopId, 10_000);
        await this.waitForOrderAck(currentTpId, 10_000);

        // Phase 2: Cancel old gen
        await this.cancelGuardianOrder(oldStopId, 10_000);
        await this.cancelGuardianOrder(oldTpId, 10_000);

        exitGen = newGen;

        if (this._tracker) {
          this._tracker.applyEvent({
            type: "replacement_intent_confirmed",
            timestamp: new Date().toISOString(),
            orderRef: intentRef,
            targetOrderRef: intentRef,
            reason: `gen ${exitGen} active`,
            newGen: exitGen,
          });
        }

        exitOpsRunning = false;

        // Process pending fills that arrived during the replacement
        if (pendingQty > lastExitCumQty) {
          const pq = pendingQty;
          pendingQty = 0;
          lastExitCumQty = pq;
          await replaceExits(pq);
        }

        tryResolve();
      };

      // ── Listeners on IBKRConnection (stable, not raw api) ──

      const onExecDetails = (
        _reqId: number,
        _c: unknown,
        execution: { orderId?: number; cumQty?: number; avgPrice?: number },
      ) => {
        if (execution.orderId !== entryId) return;
        const cumQty = execution.cumQty ?? 0;
        if (cumQty <= lastExitCumQty) return;

        entryFillPrice = execution.avgPrice ?? entryFillPrice;

        if (exitGen < 0) {
          // First fill — place exits synchronously
          lastExitCumQty = cumQty;
          exitGen = 0;
          placeExits(cumQty, 0);
          tryResolve();
        } else {
          // Further fill — adjust exits (async)
          if (exitOpsRunning) {
            pendingQty = cumQty;
            return;
          }
          lastExitCumQty = cumQty;
          replaceExits(cumQty).catch((err) => {
            console.error("[ibkr] E5: replaceExits error:", err);
            exitOpsRunning = false;
            tryResolve();
          });
        }
      };

      const onOrderStatus = (
        id: number,
        status: string,
        filled: number,
        _remaining: number,
        avgFillPrice: number,
      ) => {
        if (id !== entryId) return;
        if (status === "Filled") {
          entryFillPrice = avgFillPrice || entryFillPrice;
          entryDone = true;
          // Safety: if execDetails didn't arrive first, place exits now
          if (exitGen < 0 && filled > 0) {
            lastExitCumQty = filled;
            exitGen = 0;
            placeExits(filled, 0);
          }
          tryResolve();
        } else if (status === "Cancelled" || status === "Inactive") {
          entryDone = true;
          tryResolve();
        }
      };

      const entryTimeout = setTimeout(() => {
        if (!entryDone) {
          console.log(`[ibkr] E5: Timeout — cancelling entry ${entryId}`);
          try { this.api?.cancelOrder(entryId); } catch { /* ignore */ }
          entryDone = true;
          tryResolve();
        }
      }, 30_000);

      const cleanup = () => {
        clearTimeout(entryTimeout);
        this.removeListener("execDetails", onExecDetails);
        this.removeListener("orderStatus", onOrderStatus);
      };

      this.on("execDetails", onExecDetails);
      this.on("orderStatus", onOrderStatus);
    });
  }

  // ── Guardian Methods (E4) ──

  /**
   * Place STP+TP pair for guardian replacement.
   * ocaType=2, transmit=true (no parentId), GTC, outsideRth=false.
   */
  async placeGuardianOrders(params: {
    stopOrderId: number;
    tpOrderId: number;
    stopRef: string;
    tpRef: string;
    symbol: string;
    exchange: string;
    currency: string;
    quantity: number;
    stopPrice: number;
    tpPrice: number;
    ocaGroup: string;
  }): Promise<void> {
    if (!this.api || !this.isConnected()) {
      throw new Error("IBKR not connected");
    }
    const contract: Contract = {
      symbol: params.symbol,
      secType: SecType.STK,
      exchange: params.exchange || "SMART",
      currency: params.currency || "USD",
    };

    const stopOrder: Order = {
      orderId: params.stopOrderId,
      action: OrderAction.SELL,
      orderType: OrderType.STP,
      totalQuantity: params.quantity,
      auxPrice: params.stopPrice,
      tif: TimeInForce.GTC,
      ocaGroup: params.ocaGroup,
      ocaType: 2,
      transmit: true,
      outsideRth: false,
      orderRef: params.stopRef,
    };

    const tpOrder: Order = {
      orderId: params.tpOrderId,
      action: OrderAction.SELL,
      orderType: OrderType.LMT,
      totalQuantity: params.quantity,
      lmtPrice: params.tpPrice,
      tif: TimeInForce.GTC,
      ocaGroup: params.ocaGroup,
      ocaType: 2,
      transmit: true,
      outsideRth: false,
      orderRef: params.tpRef,
    };

    this.registerOrderRef(params.stopOrderId, params.stopRef);
    this.registerOrderRef(params.tpOrderId, params.tpRef);

    this.api.placeOrder(params.stopOrderId, contract, stopOrder);
    this.api.placeOrder(params.tpOrderId, contract, tpOrder);

    console.log(
      `[ibkr] Guardian STP@${params.stopPrice} + TP@${params.tpPrice} ` +
      `qty=${params.quantity} ${params.symbol} (OCA: ${params.ocaGroup})`,
    );
  }

  /**
   * Cancel a guardian order and wait for Cancelled/ApiCancelled status.
   */
  async cancelGuardianOrder(orderId: number, timeoutMs = 10_000): Promise<boolean> {
    if (!this.api || !this.isConnected()) return false;
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        cleanup();
        resolve(false);
      }, timeoutMs);

      const onStatus = (id: number, status: string) => {
        if (id !== orderId) return;
        if (status === "Cancelled" || status === "ApiCancelled") {
          clearTimeout(timeout);
          cleanup();
          resolve(true);
        }
      };

      const onError = (id: number) => {
        if (id !== orderId) return;
        clearTimeout(timeout);
        cleanup();
        resolve(false);
      };

      const cleanup = () => {
        this.removeListener("orderStatus", onStatus);
        this.removeListener("orderError", onError);
      };

      this.on("orderStatus", onStatus);
      this.on("orderError", onError);
      this.api!.cancelOrder(orderId);
    });
  }

  /**
   * Wait for first non-Error orderStatus (Submitted/PreSubmitted/Inactive).
   * For I4 confirmation before cancelling old orders.
   */
  async waitForOrderAck(orderId: number, timeoutMs = 10_000): Promise<boolean> {
    if (!this.api || !this.isConnected()) return false;
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        cleanup();
        resolve(false);
      }, timeoutMs);

      const onStatus = (id: number, status: string) => {
        if (id !== orderId) return;
        if (status === "Submitted" || status === "PreSubmitted" || status === "Inactive") {
          clearTimeout(timeout);
          cleanup();
          resolve(true);
        }
        if (status === "Cancelled" || status === "ApiCancelled") {
          clearTimeout(timeout);
          cleanup();
          resolve(false);
        }
      };

      const onError = (id: number) => {
        if (id !== orderId) return;
        clearTimeout(timeout);
        cleanup();
        resolve(false);
      };

      const cleanup = () => {
        this.removeListener("orderStatus", onStatus);
        this.removeListener("orderError", onError);
      };

      this.on("orderStatus", onStatus);
      this.on("orderError", onError);
    });
  }

  /**
   * Place a guardian fallback-close market sell with orderRef tracking.
   */
  async placeGuardianMarketSell(params: {
    orderId: number;
    orderRef: string;
    symbol: string;
    exchange: string;
    currency: string;
    quantity: number;
  }): Promise<{ filled: boolean; avgFillPrice: number }> {
    if (!this.api || !this.isConnected()) {
      throw new Error("IBKR not connected");
    }
    const contract: Contract = {
      symbol: params.symbol,
      secType: SecType.STK,
      exchange: params.exchange || "SMART",
      currency: params.currency || "USD",
    };
    const order: Order = {
      orderId: params.orderId,
      action: OrderAction.SELL,
      orderType: OrderType.MKT,
      totalQuantity: params.quantity,
      transmit: true,
      orderRef: params.orderRef,
    };
    this.registerOrderRef(params.orderId, params.orderRef);
    console.log(`[ibkr] Guardian MKT SELL ${params.quantity} ${params.symbol} (ref=${params.orderRef})`);
    return this.placeAndWaitForFill(params.orderId, contract, order, 30_000);
  }

  /**
   * One-shot reqMktData snapshot for fallback-close gate.
   * Returns {bid, ask, last, timestamp} or null if unavailable.
   */
  async getQuoteSnapshot(
    symbol: string,
    conId: number,
    exchange: string,
    currency: string,
    timeoutMs = 5_000,
  ): Promise<{ bid: number; ask: number; last: number; timestamp: number } | null> {
    if (!this.api || !this.isConnected()) return null;
    const reqId = this.nextReqId++;
    const contract: Contract = {
      symbol,
      secType: SecType.STK,
      exchange: exchange || "SMART",
      currency: currency || "USD",
    };

    return new Promise((resolve) => {
      let bid = 0;
      let ask = 0;
      let last = 0;
      let received = false;

      const timeout = setTimeout(() => {
        cleanup();
        resolve(received ? { bid, ask, last, timestamp: Date.now() } : null);
      }, timeoutMs);

      const onTick = (id: number, tickType: TickType, price: number) => {
        if (id !== reqId || price <= 0) return;
        received = true;
        if (tickType === 1) bid = price;
        else if (tickType === 2) ask = price;
        else if (tickType === 4) last = price;
        if (bid > 0 && ask > 0 && last > 0) {
          clearTimeout(timeout);
          cleanup();
          resolve({ bid, ask, last, timestamp: Date.now() });
        }
      };

      const cleanup = () => {
        (this.api as any)?.removeListener(EventName.tickPrice, onTick);
        try { this.api?.cancelMktData(reqId); } catch { /* ignore */ }
      };

      this.api!.on(EventName.tickPrice, onTick);
      this.api!.reqMktData(reqId, contract, "", true, false);
    });
  }

  /**
   * Place an order and wait for fill confirmation from IBKR.
   * Listens on IBKRConnection (stable), not this.api (transient).
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

      const onError = (id: number, code: number, message: string) => {
        if (id !== orderId) return;
        clearTimeout(timeout);
        cleanup();
        console.error(`[ibkr] Order ${id} error (${code}): ${message}`);
        resolve({ filled: false, avgFillPrice: 0 });
      };

      const cleanup = () => {
        this.removeListener("orderStatus", onStatus);
        this.removeListener("orderError", onError);
      };

      // Listen on IBKRConnection (stable), not this.api (transient)
      this.on("orderStatus", onStatus);
      this.on("orderError", onError);
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
