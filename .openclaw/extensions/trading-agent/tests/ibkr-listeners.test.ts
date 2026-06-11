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
// vi.mock is hoisted — MockIBApi must be defined inside the factory.

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

    placeOrder(_orderId: number, _contract: unknown, _order: unknown): void {
      // stub
    }

    cancelOrder(_orderId: number): void {
      // stub
    }

    reqManagedAccts(): void {
      // stub
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
    execDetails: "execDetails",
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

// Import IBKRConnection AFTER mocking @stoqey/ib
import { IBKRConnection } from "../src/ibkr.js";

// ── Test Helpers ──

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ibkr-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeTracker(): OrderStateTracker {
  const log = new DurableEventLog(join(tmpDir, "orders-v2.jsonl"));
  const tracker = new OrderStateTracker(log);
  tracker.rebuild();
  return tracker;
}

function getApiInstance(ibkr: IBKRConnection): EventEmitter {
  // Access the private api field
  return (ibkr as any).api as EventEmitter;
}

const TEST_ORDER_REF = buildOrderRef({
  account: "DUP514636",
  tradeIntentId: "AAPL-260611-01",
  conId: 265598,
  leg: "entry",
  gen: 0,
});

// ── Tests ──

describe("IBKR Permanent Listeners", () => {
  it("1. Handlers are registered on new IBApi after connect()", async () => {
    const ibkr = new IBKRConnection();
    await ibkr.connect();

    // Wait for async connected event
    await new Promise((r) => setTimeout(r, 50));

    const api = getApiInstance(ibkr);
    expect(api).toBeDefined();

    // Check that orderStatus, openOrder, execDetails, error have listeners
    expect(api.listenerCount("orderStatus")).toBeGreaterThanOrEqual(1);
    expect(api.listenerCount("openOrder")).toBeGreaterThanOrEqual(1);
    expect(api.listenerCount("execDetails")).toBeGreaterThanOrEqual(1);
    // error has both connection handler and order handler
    expect(api.listenerCount("error")).toBeGreaterThanOrEqual(2);

    ibkr.disconnect();
  });

  it("2. 3 reconnects -> exactly 1 handler call per event (no accumulation)", async () => {
    const ibkr = new IBKRConnection();
    const statusCalls: number[] = [];

    ibkr.on("orderStatus", (orderId: number) => {
      statusCalls.push(orderId);
    });

    // Simulate 3 connect cycles (each creates a new IBApi)
    for (let i = 0; i < 3; i++) {
      // Force state to disconnected to allow reconnect
      (ibkr as any)._state = "disconnected";
      await ibkr.connect();
      await new Promise((r) => setTimeout(r, 50));
    }

    // Now emit orderStatus on the CURRENT api instance
    const api = getApiInstance(ibkr);
    api.emit("orderStatus", 100, "Submitted", 0, 10, 0, undefined, undefined, undefined);

    // Should receive exactly 1 call (old APIs are GC'd, listeners gone)
    expect(statusCalls).toHaveLength(1);
    expect(statusCalls[0]).toBe(100);

    ibkr.disconnect();
  });

  it("3. orderStatus with known orderRef -> tracker.applyEvent called", async () => {
    const ibkr = new IBKRConnection();
    const tracker = makeTracker();
    ibkr.setTracker(tracker);

    await ibkr.connect();
    await new Promise((r) => setTimeout(r, 50));

    // Register the orderId -> orderRef mapping
    ibkr.registerOrderRef(42, TEST_ORDER_REF);

    const api = getApiInstance(ibkr);
    api.emit("orderStatus", 42, "Submitted", 0, 10, 0, 999, undefined, undefined);

    // Tracker should have the event
    const events = tracker.getEventsForOrder(TEST_ORDER_REF);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("order_status_changed");

    ibkr.disconnect();
  });

  it("4. execDetails -> order_filled event in tracker", async () => {
    const ibkr = new IBKRConnection();
    const tracker = makeTracker();
    ibkr.setTracker(tracker);

    await ibkr.connect();
    await new Promise((r) => setTimeout(r, 50));

    // Register the orderId -> orderRef mapping
    ibkr.registerOrderRef(42, TEST_ORDER_REF);

    const api = getApiInstance(ibkr);
    api.emit("execDetails", 0, { symbol: "AAPL" }, {
      orderId: 42,
      orderRef: TEST_ORDER_REF,
      execId: "0000e0d5.6845b123.01.01",
      side: "BOT",
      shares: 10,
      price: 149.50,
      cumQty: 10,
      avgPrice: 149.50,
    });

    const events = tracker.getEventsForOrder(TEST_ORDER_REF);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("order_filled");

    ibkr.disconnect();
  });

  it("5. orderStatus without known orderRef -> emits but no tracker event", async () => {
    const ibkr = new IBKRConnection();
    const tracker = makeTracker();
    ibkr.setTracker(tracker);

    let emitted = false;
    ibkr.on("orderStatus", () => { emitted = true; });

    await ibkr.connect();
    await new Promise((r) => setTimeout(r, 50));

    // Do NOT register orderId 99 -> no orderRef mapping
    const api = getApiInstance(ibkr);
    api.emit("orderStatus", 99, "Submitted", 0, 10, 0);

    expect(emitted).toBe(true);
    // Tracker should have NO events (unknown orderId)
    const allEvents = tracker.getEventsForOrder(TEST_ORDER_REF);
    expect(allEvents).toHaveLength(0);

    ibkr.disconnect();
  });

  it("6. Duplicate orderStatus -> tracker deduplicates (applyEvent returns false)", async () => {
    const ibkr = new IBKRConnection();
    const tracker = makeTracker();
    ibkr.setTracker(tracker);

    await ibkr.connect();
    await new Promise((r) => setTimeout(r, 50));

    ibkr.registerOrderRef(42, TEST_ORDER_REF);

    const api = getApiInstance(ibkr);
    // Emit same status twice
    api.emit("orderStatus", 42, "Submitted", 0, 10, 0, 999);
    api.emit("orderStatus", 42, "Submitted", 0, 10, 0, 999);

    // Only 1 event should be stored (second is deduplicated)
    const events = tracker.getEventsForOrder(TEST_ORDER_REF);
    expect(events).toHaveLength(1);

    ibkr.disconnect();
  });

  it("7. execDetails without prior orderStatus -> tracker accepts", async () => {
    const ibkr = new IBKRConnection();
    const tracker = makeTracker();
    ibkr.setTracker(tracker);

    await ibkr.connect();
    await new Promise((r) => setTimeout(r, 50));

    // execDetails arrives before any orderStatus — should still work
    // The handler auto-populates _orderIdToRef from execution.orderRef
    const api = getApiInstance(ibkr);
    api.emit("execDetails", 0, { symbol: "AAPL" }, {
      orderId: 55,
      orderRef: TEST_ORDER_REF,
      execId: "0000e0d5.6845b123.02.01",
      side: "BOT",
      shares: 5,
      price: 150.00,
      cumQty: 5,
      avgPrice: 150.00,
    });

    const events = tracker.getEventsForOrder(TEST_ORDER_REF);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("order_filled");

    ibkr.disconnect();
  });

  it("8. Order error (id>0) with known orderRef -> order_error in tracker", async () => {
    const ibkr = new IBKRConnection();
    const tracker = makeTracker();
    ibkr.setTracker(tracker);

    await ibkr.connect();
    await new Promise((r) => setTimeout(r, 50));

    ibkr.registerOrderRef(42, TEST_ORDER_REF);

    const api = getApiInstance(ibkr);
    // Emit error with id=42 (order-related), not id=-1 (connection)
    api.emit("error", new Error("Order rejected"), 201, 42);

    expect(tracker.hasError(TEST_ORDER_REF)).toBe(true);

    const events = tracker.getEventsForOrder(TEST_ORDER_REF);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("order_error");

    ibkr.disconnect();
  });
});
