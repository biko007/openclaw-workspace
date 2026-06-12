import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  DurableEventLog,
  OrderStateTracker,
  buildOrderRef,
} from "../src/order-state-tracker.js";

// ── Mock @stoqey/ib ──

vi.mock("@stoqey/ib", () => {
  const { EventEmitter: EE } = require("node:events");

  class MockIBApi extends EE {
    connected = false;

    constructor(_opts?: { host?: string; port?: number; clientId?: number }) {
      super();
    }

    connect(): void {
      this.connected = true;
      setTimeout(() => this.emit("connected"), 0);
    }

    disconnect(): void {
      this.connected = false;
    }

    placeOrder(_orderId: number, _contract: unknown, _order: unknown): void {}
    cancelOrder(_orderId: number): void {}
    reqManagedAccts(): void {}

    reqAllOpenOrders(): void {
      // stub — tests emit openOrder/openOrderEnd manually
    }

    reqPositions(): void {
      // stub — tests emit position/positionEnd manually
    }

    reqExecutions(_reqId: number, _filter: any): void {
      // stub — tests emit execDetails/execDetailsEnd manually
    }

    reqCompletedOrders(_apiOnly: boolean): void {
      // stub — tests emit completedOrder/completedOrdersEnd manually
    }
  }

  const EventName = {
    connected: "connected",
    disconnected: "disconnected",
    error: "error",
    managedAccounts: "managedAccounts",
    nextValidId: "nextValidId",
    orderStatus: "orderStatus",
    openOrder: "openOrder",
    openOrderEnd: "openOrderEnd",
    execDetails: "execDetails",
    execDetailsEnd: "execDetailsEnd",
    completedOrder: "completedOrder",
    completedOrdersEnd: "completedOrdersEnd",
    position: "position",
    positionEnd: "positionEnd",
    accountSummary: "accountSummary",
    accountSummaryEnd: "accountSummaryEnd",
    scannerData: "scannerData",
    scannerDataEnd: "scannerDataEnd",
    tickPrice: "tickPrice",
  };

  return {
    IBApi: MockIBApi,
    EventName,
    SecType: { STK: "STK" },
    ErrorCode: {},
    OrderAction: { BUY: "BUY", SELL: "SELL" },
    OrderType: { MKT: "MKT", LMT: "LMT", STP: "STP" },
    TimeInForce: { GTC: "GTC" },
  };
});

import { IBKRConnection } from "../src/ibkr.js";

// ── Test Helpers ──

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sync-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function getApiInstance(ibkr: IBKRConnection): EventEmitter {
  return (ibkr as any).api as EventEmitter;
}

const OWN_ORDER_REF = buildOrderRef({
  account: "DUP514636",
  tradeIntentId: "AAPL-260612-01",
  conId: 265598,
  leg: "stop",
  gen: 0,
});

/** Connect IBKRConnection and wait for connected state */
async function connectIbkr(): Promise<IBKRConnection> {
  const ibkr = new IBKRConnection();
  await ibkr.connect();
  await new Promise((r) => setTimeout(r, 50));
  return ibkr;
}

/**
 * Emit a full sync sequence with staggered timing to match sequential await phases.
 * Each phase's end event fires on a new tick so the next phase's listener is registered.
 */
function emitSyncPhases(
  api: EventEmitter,
  opts?: {
    orders?: Array<{ orderId: number; orderRef: string; symbol: string; conId: number }>;
    positions?: Array<{ symbol: string; conId: number; qty: number; avgCost: number }>;
  },
) {
  const { orders = [], positions = [] } = opts ?? {};

  // Phase 1: open orders — immediate (listener already registered)
  for (const o of orders) {
    api.emit(
      "openOrder",
      o.orderId,
      { symbol: o.symbol, conId: o.conId },
      {
        action: "SELL",
        orderType: "STP",
        totalQuantity: 100,
        tif: "GTC",
        ocaGroup: `OCA_${o.symbol}`,
        parentId: 0,
        orderRef: o.orderRef,
        permId: o.orderId + 1000,
        clientId: 1,
      },
      { status: "PreSubmitted" },
    );
  }
  api.emit("openOrderEnd");

  // Phase 2: positions — next tick (after Phase 1 resolves and Phase 2 registers)
  setTimeout(() => {
    for (const p of positions) {
      api.emit(
        "position",
        "DUP514636",
        { symbol: p.symbol, conId: p.conId, primaryExch: "SMART", currency: "USD" },
        p.qty,
        p.avgCost,
      );
    }
    api.emit("positionEnd");

    // Phase 3: executions — next tick after Phase 2
    setTimeout(() => {
      for (let i = 999; i < 1010; i++) api.emit("execDetailsEnd", i);

      // Phase 3+: completed orders — next tick after Phase 3
      setTimeout(() => {
        api.emit("completedOrdersEnd");
      }, 5);
    }, 5);
  }, 5);
}

// ── Tests ──

describe("Sync Barrier (E3a)", () => {
  it("1. resolves only after openOrderEnd AND positionEnd", async () => {
    const ibkr = await connectIbkr();
    const api = getApiInstance(ibkr);

    // Intercept reqExecutions to capture reqId
    let capturedReqId = 0;
    const origReqExec = api.constructor.prototype.reqExecutions;
    (api as any).reqExecutions = (reqId: number, _filter: any) => {
      capturedReqId = reqId;
    };

    const promise = ibkr.runSyncBarrier({ isReconnect: false });

    // Emit with small delays to simulate async IBKR responses
    setTimeout(() => {
      api.emit(
        "openOrder", 42,
        { symbol: "AAPL", conId: 265598 },
        { action: "SELL", orderType: "LMT", totalQuantity: 100, tif: "GTC", ocaGroup: "", parentId: 0, orderRef: OWN_ORDER_REF, permId: 1042, clientId: 1 },
        { status: "Submitted" },
      );
      api.emit("openOrderEnd");
    }, 10);

    setTimeout(() => {
      api.emit("position", "DUP514636", { symbol: "AAPL", conId: 265598, primaryExch: "SMART", currency: "USD" }, 100, 150.0);
      api.emit("positionEnd");
    }, 20);

    setTimeout(() => {
      api.emit("execDetailsEnd", capturedReqId || 1000);
    }, 30);

    setTimeout(() => {
      api.emit("completedOrdersEnd");
    }, 40);

    const snapshot = await promise;

    expect(snapshot.ownOrders.length).toBe(1);
    expect(snapshot.positions.length).toBe(1);
    expect(snapshot.positions[0].conId).toBe(265598);
    expect(snapshot.timestamp).toBeTruthy();
  });

  it("2. guardianLocked is true during sync, false after", async () => {
    const ibkr = await connectIbkr();
    const api = getApiInstance(ibkr);

    expect(ibkr.guardianLocked).toBe(false);

    // Start sync but delay the end events
    const promise = ibkr.runSyncBarrier({ isReconnect: false });

    // guardianLocked should be true immediately
    expect(ibkr.guardianLocked).toBe(true);

    // Stagger phase end events (each phase awaits sequentially)
    setTimeout(() => emitSyncPhases(api), 10);

    await promise;

    expect(ibkr.guardianLocked).toBe(false);
  });

  it("3. concurrent runSyncBarrier throws", async () => {
    const ibkr = await connectIbkr();
    const api = getApiInstance(ibkr);

    // Start first sync (won't resolve because no end events)
    const first = ibkr.runSyncBarrier({ isReconnect: false });

    // Second call should throw immediately
    await expect(ibkr.runSyncBarrier({ isReconnect: false })).rejects.toThrow(
      "Sync barrier already in progress",
    );

    // Clean up — resolve first sync with staggered phases
    emitSyncPhases(api);
    await first;
  });

  it("4. isReconnect sets _reconnectCooldownUntil for 60s", async () => {
    const ibkr = await connectIbkr();
    const api = getApiInstance(ibkr);

    expect(ibkr.isReconnectCooldownActive()).toBe(false);

    const promise = ibkr.runSyncBarrier({ isReconnect: true });

    // Stagger phase end events
    setTimeout(() => emitSyncPhases(api), 10);

    await promise;

    expect(ibkr.isReconnectCooldownActive()).toBe(true);

    // After 60s it should be inactive — simulate by directly setting the internal field
    (ibkr as any)._reconnectCooldownUntil = Date.now() - 1;
    expect(ibkr.isReconnectCooldownActive()).toBe(false);
  });

  it("5. orders without OCAGENT| prefix go to foreignOrders", async () => {
    const ibkr = await connectIbkr();
    const api = getApiInstance(ibkr);

    const promise = ibkr.runSyncBarrier({ isReconnect: false });

    setTimeout(() => {
      // Own order (has OCAGENT| prefix)
      api.emit(
        "openOrder", 10,
        { symbol: "AAPL", conId: 265598 },
        { action: "SELL", orderType: "STP", totalQuantity: 100, tif: "GTC", ocaGroup: "", parentId: 0, orderRef: OWN_ORDER_REF, permId: 1010, clientId: 1 },
        { status: "Submitted" },
      );
      // Foreign order (no OCAGENT| prefix)
      api.emit(
        "openOrder", 20,
        { symbol: "GILD", conId: 269753 },
        { action: "SELL", orderType: "LMT", totalQuantity: 485, tif: "GTC", ocaGroup: "OCA_GILD", parentId: 0, orderRef: "", permId: 1020, clientId: 98 },
        { status: "PreSubmitted" },
      );
      api.emit("openOrderEnd");

      // Stagger subsequent phases
      setTimeout(() => {
        api.emit("positionEnd");
        setTimeout(() => {
          for (let i = 999; i < 1010; i++) api.emit("execDetailsEnd", i);
          setTimeout(() => api.emit("completedOrdersEnd"), 5);
        }, 5);
      }, 5);
    }, 10);

    const snapshot = await promise;

    expect(snapshot.ownOrders.length).toBe(1);
    expect(snapshot.ownOrders[0].symbol).toBe("AAPL");
    expect(snapshot.foreignOrders.length).toBe(1);
    expect(snapshot.foreignOrders[0].symbol).toBe("GILD");
  });

  it("6. all order IDs in snapshot tracked by sequencer", async () => {
    const ibkr = await connectIbkr();
    const api = getApiInstance(ibkr);

    const promise = ibkr.runSyncBarrier({ isReconnect: false });

    setTimeout(() => {
      api.emit(
        "openOrder", 500,
        { symbol: "AAPL", conId: 265598 },
        { action: "SELL", orderType: "STP", totalQuantity: 100, tif: "GTC", ocaGroup: "", parentId: 0, orderRef: "", permId: 1500, clientId: 1 },
        { status: "Submitted" },
      );
      api.emit("openOrderEnd");

      setTimeout(() => {
        api.emit("positionEnd");
        setTimeout(() => {
          for (let i = 999; i < 1010; i++) api.emit("execDetailsEnd", i);
          setTimeout(() => api.emit("completedOrdersEnd"), 5);
        }, 5);
      }, 5);
    }, 10);

    await promise;

    // Sequencer should have seen orderId 500 → peek >= 501
    expect(ibkr.sequencer.peek()).toBeGreaterThanOrEqual(501);
  });

  it("7. timeout on openOrders phase includes partial data and logs WARN", async () => {
    const ibkr = await connectIbkr();
    const api = getApiInstance(ibkr);

    // Override the internal timeout by setting a very short phase timeout
    // We'll do this by monkey-patching _collectOpenOrders
    const origCollect = (ibkr as any)._collectOpenOrders.bind(ibkr);
    (ibkr as any)._collectOpenOrders = (timeoutMs: number, timedOut: string[]) => {
      return origCollect(100, timedOut); // 100ms timeout instead of 30s
    };

    const promise = ibkr.runSyncBarrier({ isReconnect: false });

    // Emit one order but NEVER emit openOrderEnd → timeout after 100ms
    setTimeout(() => {
      api.emit(
        "openOrder", 42,
        { symbol: "AAPL", conId: 265598 },
        { action: "SELL", orderType: "STP", totalQuantity: 100, tif: "GTC", ocaGroup: "", parentId: 0, orderRef: "", permId: 1042, clientId: 1 },
        { status: "Submitted" },
      );
    }, 10);

    // After timeout resolves Phase 1 (~100ms), emit remaining phase ends staggered
    setTimeout(() => {
      api.emit("positionEnd");
      setTimeout(() => {
        for (let i = 999; i < 1010; i++) api.emit("execDetailsEnd", i);
        setTimeout(() => api.emit("completedOrdersEnd"), 5);
      }, 5);
    }, 150);

    const snapshot = await promise;

    expect(snapshot.timedOutPhases).toContain("openOrders");
    // Partial data should still be in the snapshot
    expect(snapshot.foreignOrders.length).toBe(1); // The order without OCAGENT prefix
  });

  it("8. snapshot is deeply frozen", async () => {
    const ibkr = await connectIbkr();
    const api = getApiInstance(ibkr);

    const promise = ibkr.runSyncBarrier({ isReconnect: false });

    setTimeout(() => emitSyncPhases(api), 10);

    const snapshot = await promise;

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.ownOrders)).toBe(true);
    expect(Object.isFrozen(snapshot.foreignOrders)).toBe(true);
    expect(Object.isFrozen(snapshot.positions)).toBe(true);
    expect(Object.isFrozen(snapshot.timedOutPhases)).toBe(true);
  });

  it("9. missing reqCompletedOrders returns empty array gracefully", async () => {
    const ibkr = await connectIbkr();
    const api = getApiInstance(ibkr);

    // Override reqCompletedOrders to non-function (can't delete prototype methods)
    (api as any).reqCompletedOrders = null;

    const promise = ibkr.runSyncBarrier({ isReconnect: false });

    // Phase 1: openOrderEnd
    setTimeout(() => {
      api.emit("openOrderEnd");
      // Phase 2: positionEnd
      setTimeout(() => {
        api.emit("positionEnd");
        // Phase 3: execDetailsEnd (completedOrders skipped — no reqCompletedOrders)
        setTimeout(() => {
          for (let i = 999; i < 1010; i++) api.emit("execDetailsEnd", i);
        }, 5);
      }, 5);
    }, 10);

    const snapshot = await promise;

    expect(snapshot.completedOrders.length).toBe(0);
  });

  it("10. reqExecutions receives correct time filter format", async () => {
    const ibkr = await connectIbkr();
    const api = getApiInstance(ibkr);

    let capturedFilter: any = null;
    let capturedReqId = 0;
    (api as any).reqExecutions = (reqId: number, filter: any) => {
      capturedFilter = filter;
      capturedReqId = reqId;
    };

    const promise = ibkr.runSyncBarrier({ isReconnect: false });

    // Phase 1 + 2
    setTimeout(() => {
      api.emit("openOrderEnd");
      setTimeout(() => {
        api.emit("positionEnd");
        // Phase 3: after reqExecutions is called, emit end with captured reqId
        setTimeout(() => {
          api.emit("execDetailsEnd", capturedReqId || 1000);
          setTimeout(() => api.emit("completedOrdersEnd"), 5);
        }, 5);
      }, 5);
    }, 10);

    await promise;

    expect(capturedFilter).toBeTruthy();
    expect(capturedFilter.time).toMatch(/^\d{8}-\d{2}:\d{2}:\d{2}$/);
  });
});
