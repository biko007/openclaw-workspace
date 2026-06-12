import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  DurableEventLog,
  OrderStateTracker,
  OrderIdSequencer,
  buildOrderRef,
  buildOcaGroup,
  buildTradeIntentId,
  parseOrderRef,
} from "../src/order-state-tracker.js";

// ── Mock @stoqey/ib ──

vi.mock("@stoqey/ib", () => {
  const { EventEmitter: EE } = require("node:events");

  class MockIBApi extends EE {
    connected = false;
    placedOrders: { orderId: number; contract: any; order: any }[] = [];
    cancelledOrders: number[] = [];

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

    placeOrder(orderId: number, contract: unknown, order: unknown): void {
      this.placedOrders.push({ orderId, contract: contract as any, order: order as any });
    }

    cancelOrder(orderId: number): void {
      this.cancelledOrders.push(orderId);
    }

    reqManagedAccts(): void {
      // stub
    }

    reqContractDetails(reqId: number, _contract: unknown): void {
      // Simulate async response
      setTimeout(() => {
        this.emit("contractDetails", reqId, {
          contract: { conId: 265598, symbol: "AAPL" },
        });
      }, 5);
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
    contractDetails: "contractDetails",
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

// Import AFTER mocking
import { IBKRConnection } from "../src/ibkr.js";

// ── Helpers ──

const ACCOUNT = "DUP514636";
const SYMBOL = "AAPL";
const CON_ID = 265598;

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "entry-path-test-"));
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

function getApi(ibkr: IBKRConnection): EventEmitter & {
  placedOrders: { orderId: number; contract: any; order: any }[];
  cancelledOrders: number[];
} {
  return (ibkr as any).api;
}

async function connectIBKR(): Promise<IBKRConnection> {
  const ibkr = new IBKRConnection();
  await ibkr.connect();
  await new Promise((r) => setTimeout(r, 50));
  // Set account so orderRefs have the right value
  (ibkr as any).account = ACCOUNT;
  return ibkr;
}

function simulateFullFill(
  api: EventEmitter,
  entryOrderId: number,
  qty: number,
  price: number,
  orderRef: string,
) {
  api.emit("execDetails", 0, { symbol: SYMBOL }, {
    orderId: entryOrderId,
    orderRef,
    execId: `exec-${entryOrderId}.01`,
    side: "BOT",
    shares: qty,
    price,
    cumQty: qty,
    avgPrice: price,
  });
  api.emit("orderStatus", entryOrderId, "Filled", qty, 0, price, 999, undefined, undefined);
}

function simulatePartialFill(
  api: EventEmitter,
  entryOrderId: number,
  shares: number,
  cumQty: number,
  price: number,
  orderRef: string,
  execSuffix: string,
) {
  api.emit("execDetails", 0, { symbol: SYMBOL }, {
    orderId: entryOrderId,
    orderRef,
    execId: `exec-${entryOrderId}.${execSuffix}`,
    side: "BOT",
    shares,
    price,
    cumQty,
    avgPrice: price,
  });
}

function simulateOrderStatus(
  api: EventEmitter,
  orderId: number,
  status: string,
  filled: number,
  remaining: number,
  avgFillPrice: number,
) {
  api.emit("orderStatus", orderId, status, filled, remaining, avgFillPrice, 999, undefined, undefined);
}

// Also simulate ack for exit orders (Submitted status)
function simulateExitAck(api: EventEmitter, orderId: number) {
  api.emit("orderStatus", orderId, "Submitted", 0, 100, 0, 999, undefined, undefined);
}

function simulateExitCancelled(api: EventEmitter, orderId: number) {
  api.emit("orderStatus", orderId, "Cancelled", 0, 0, 0, 999, undefined, undefined);
}

// ── Tests ──

describe("E5 Entry Path", () => {
  it("1. Full fill → Exits for full qty", async () => {
    const ibkr = await connectIBKR();
    const tracker = makeTracker();
    ibkr.setTracker(tracker);

    const api = getApi(ibkr);
    const tradeIntentId = "AAPL-260612-01";

    const promise = ibkr.placeBracketOrder({
      symbol: SYMBOL,
      exchange: "SMART",
      currency: "USD",
      quantity: 100,
      limitPrice: 150.00,
      stopPrice: 145.00,
      takeProfitPrice: 160.00,
      tradeIntentId,
      conId: CON_ID,
    });

    // Find the entry order ID from placed orders
    await new Promise((r) => setTimeout(r, 10));
    const entryPlacement = api.placedOrders.find((o) => o.order.action === "BUY");
    expect(entryPlacement).toBeDefined();
    const entryId = entryPlacement!.orderId;
    const entryRef = buildOrderRef({
      account: ACCOUNT, tradeIntentId, conId: CON_ID, leg: "entry", gen: 0,
    });

    // Simulate full fill
    simulateFullFill(api, entryId, 100, 149.50, entryRef);

    const result = await promise;

    expect(result.actualFilledQty).toBe(100);
    expect(result.entry.status).toBe("Filled");
    expect(result.stopLoss).toBeDefined();
    expect(result.takeProfit).toBeDefined();
    expect(result.stopLoss!.quantity).toBe(100);
    expect(result.takeProfit!.quantity).toBe(100);
    expect(result.exitGen).toBe(0);

    ibkr.disconnect();
  });

  it("2. Partial fill 50/100 → Exits for 50", async () => {
    const ibkr = await connectIBKR();
    const tracker = makeTracker();
    ibkr.setTracker(tracker);

    const api = getApi(ibkr);
    const tradeIntentId = "AAPL-260612-01";

    const promise = ibkr.placeBracketOrder({
      symbol: SYMBOL,
      exchange: "SMART",
      currency: "USD",
      quantity: 100,
      limitPrice: 150.00,
      stopPrice: 145.00,
      takeProfitPrice: 160.00,
      tradeIntentId,
      conId: CON_ID,
    });

    await new Promise((r) => setTimeout(r, 10));
    const entryId = api.placedOrders[0].orderId;
    const entryRef = buildOrderRef({
      account: ACCOUNT, tradeIntentId, conId: CON_ID, leg: "entry", gen: 0,
    });

    // Partial fill 50/100, then cancel rest (timeout)
    simulatePartialFill(api, entryId, 50, 50, 149.50, entryRef, "01");
    // Simulate entry cancelled (remaining not filled)
    simulateOrderStatus(api, entryId, "Cancelled", 50, 50, 149.50);

    const result = await promise;

    expect(result.actualFilledQty).toBe(50);
    expect(result.stopLoss).toBeDefined();
    expect(result.takeProfit).toBeDefined();
    expect(result.stopLoss!.quantity).toBe(50);
    expect(result.takeProfit!.quantity).toBe(50);
    expect(result.exitGen).toBe(0);

    ibkr.disconnect();
  });

  it("3. Second fill (cumQty=100) → Cancel+Replace gen=1", async () => {
    const ibkr = await connectIBKR();
    const tracker = makeTracker();
    ibkr.setTracker(tracker);

    const api = getApi(ibkr);
    const tradeIntentId = "AAPL-260612-01";

    const promise = ibkr.placeBracketOrder({
      symbol: SYMBOL,
      exchange: "SMART",
      currency: "USD",
      quantity: 100,
      limitPrice: 150.00,
      stopPrice: 145.00,
      takeProfitPrice: 160.00,
      tradeIntentId,
      conId: CON_ID,
    });

    await new Promise((r) => setTimeout(r, 10));
    const entryId = api.placedOrders[0].orderId;
    const entryRef = buildOrderRef({
      account: ACCOUNT, tradeIntentId, conId: CON_ID, leg: "entry", gen: 0,
    });

    // First partial fill: 50
    simulatePartialFill(api, entryId, 50, 50, 149.50, entryRef, "01");
    await new Promise((r) => setTimeout(r, 20));

    // Record gen=0 exit order IDs
    const gen0Exits = api.placedOrders.filter((o) => o.order.action === "SELL");
    expect(gen0Exits.length).toBe(2);
    const gen0StopId = gen0Exits[0].orderId;
    const gen0TpId = gen0Exits[1].orderId;

    // Second partial fill: cumQty=100 (total)
    simulatePartialFill(api, entryId, 50, 100, 149.50, entryRef, "02");
    await new Promise((r) => setTimeout(r, 20));

    // New gen=1 exits should have been placed
    const gen1Exits = api.placedOrders.filter(
      (o) => o.order.action === "SELL" && !gen0Exits.includes(o),
    );
    expect(gen1Exits.length).toBe(2);

    // Stagger acks: waitForOrderAck is sequential, each needs its own tick
    simulateExitAck(api, gen1Exits[0].orderId);
    await new Promise((r) => setTimeout(r, 10));
    simulateExitAck(api, gen1Exits[1].orderId);
    await new Promise((r) => setTimeout(r, 10));

    // First cancelGuardianOrder dispatched, waiting for Cancelled
    expect(api.cancelledOrders).toContain(gen0StopId);
    simulateExitCancelled(api, gen0StopId);
    await new Promise((r) => setTimeout(r, 10));

    // Second cancelGuardianOrder dispatched after first resolved
    expect(api.cancelledOrders).toContain(gen0TpId);
    simulateExitCancelled(api, gen0TpId);
    await new Promise((r) => setTimeout(r, 10));

    // Now simulate entry fully filled
    simulateOrderStatus(api, entryId, "Filled", 100, 0, 149.50);

    const result = await promise;

    expect(result.actualFilledQty).toBe(100);
    expect(result.exitGen).toBe(1);
    expect(result.stopLoss!.quantity).toBe(100);
    expect(result.takeProfit!.quantity).toBe(100);

    ibkr.disconnect();
  });

  it("4. Timeout with partial (50/100) → Exits for 50, entry cancelled", async () => {
    const ibkr = await connectIBKR();
    const tracker = makeTracker();
    ibkr.setTracker(tracker);

    const api = getApi(ibkr);
    const tradeIntentId = "AAPL-260612-01";

    // Use shorter timeout for test by overriding — we simulate the timeout
    // by immediately cancelling after partial fill
    const promise = ibkr.placeBracketOrder({
      symbol: SYMBOL,
      exchange: "SMART",
      currency: "USD",
      quantity: 100,
      limitPrice: 150.00,
      stopPrice: 145.00,
      takeProfitPrice: 160.00,
      tradeIntentId,
      conId: CON_ID,
    });

    await new Promise((r) => setTimeout(r, 10));
    const entryId = api.placedOrders[0].orderId;
    const entryRef = buildOrderRef({
      account: ACCOUNT, tradeIntentId, conId: CON_ID, leg: "entry", gen: 0,
    });

    // Partial fill 50/100
    simulatePartialFill(api, entryId, 50, 50, 149.50, entryRef, "01");
    await new Promise((r) => setTimeout(r, 10));

    // Simulate entry cancelled (as if timeout triggered cancel)
    simulateOrderStatus(api, entryId, "Cancelled", 50, 50, 149.50);

    const result = await promise;

    expect(result.actualFilledQty).toBe(50);
    expect(result.entry.status).toBe("Filled"); // Had fills, so "Filled"
    expect(result.stopLoss).toBeDefined();
    expect(result.takeProfit).toBeDefined();
    expect(result.stopLoss!.quantity).toBe(50);

    ibkr.disconnect();
  });

  it("5. Timeout without fill → No exits", async () => {
    const ibkr = await connectIBKR();
    const tracker = makeTracker();
    ibkr.setTracker(tracker);

    const api = getApi(ibkr);
    const tradeIntentId = "AAPL-260612-01";

    const promise = ibkr.placeBracketOrder({
      symbol: SYMBOL,
      exchange: "SMART",
      currency: "USD",
      quantity: 100,
      limitPrice: 150.00,
      stopPrice: 145.00,
      takeProfitPrice: 160.00,
      tradeIntentId,
      conId: CON_ID,
    });

    await new Promise((r) => setTimeout(r, 10));
    const entryId = api.placedOrders[0].orderId;

    // Simulate entry cancelled without any fills
    simulateOrderStatus(api, entryId, "Cancelled", 0, 100, 0);

    const result = await promise;

    expect(result.actualFilledQty).toBe(0);
    expect(result.entry.status).toBe("Cancelled");
    expect(result.stopLoss).toBeUndefined();
    expect(result.takeProfit).toBeUndefined();
    expect(result.exitGen).toBe(0);

    ibkr.disconnect();
  });

  it("6. orderRef OCAGENT schema on all legs", async () => {
    const ibkr = await connectIBKR();
    const tracker = makeTracker();
    ibkr.setTracker(tracker);

    const api = getApi(ibkr);
    const tradeIntentId = "AAPL-260612-01";

    const promise = ibkr.placeBracketOrder({
      symbol: SYMBOL,
      exchange: "SMART",
      currency: "USD",
      quantity: 100,
      limitPrice: 150.00,
      stopPrice: 145.00,
      takeProfitPrice: 160.00,
      tradeIntentId,
      conId: CON_ID,
    });

    await new Promise((r) => setTimeout(r, 10));
    const entryId = api.placedOrders[0].orderId;
    const entryRef = buildOrderRef({
      account: ACCOUNT, tradeIntentId, conId: CON_ID, leg: "entry", gen: 0,
    });

    // Verify entry orderRef
    expect(api.placedOrders[0].order.orderRef).toBe(entryRef);
    const parsedEntry = parseOrderRef(api.placedOrders[0].order.orderRef);
    expect(parsedEntry).not.toBeNull();
    expect(parsedEntry!.leg).toBe("entry");
    expect(parsedEntry!.gen).toBe(0);
    expect(parsedEntry!.conId).toBe(CON_ID);

    // Simulate fill to trigger exit placement
    simulateFullFill(api, entryId, 100, 149.50, entryRef);

    const result = await promise;

    // Check exit orderRefs
    const exitOrders = api.placedOrders.filter((o) => o.order.action === "SELL");
    expect(exitOrders.length).toBe(2);

    const stopOrder = exitOrders.find((o) => o.order.orderType === "STP");
    const tpOrder = exitOrders.find((o) => o.order.orderType === "LMT");

    const parsedStop = parseOrderRef(stopOrder!.order.orderRef);
    expect(parsedStop).not.toBeNull();
    expect(parsedStop!.leg).toBe("stop");
    expect(parsedStop!.gen).toBe(0);
    expect(parsedStop!.tradeIntentId).toBe(tradeIntentId);

    const parsedTp = parseOrderRef(tpOrder!.order.orderRef);
    expect(parsedTp).not.toBeNull();
    expect(parsedTp!.leg).toBe("tp");
    expect(parsedTp!.gen).toBe(0);
    expect(parsedTp!.tradeIntentId).toBe(tradeIntentId);

    ibkr.disconnect();
  });

  it("7. ocaType=2, transmit=true, GTC, outsideRth=false on all exits", async () => {
    const ibkr = await connectIBKR();
    const tracker = makeTracker();
    ibkr.setTracker(tracker);

    const api = getApi(ibkr);
    const tradeIntentId = "AAPL-260612-01";

    const promise = ibkr.placeBracketOrder({
      symbol: SYMBOL,
      exchange: "SMART",
      currency: "USD",
      quantity: 100,
      limitPrice: 150.00,
      stopPrice: 145.00,
      takeProfitPrice: 160.00,
      tradeIntentId,
      conId: CON_ID,
    });

    await new Promise((r) => setTimeout(r, 10));
    const entryId = api.placedOrders[0].orderId;
    const entryRef = buildOrderRef({
      account: ACCOUNT, tradeIntentId, conId: CON_ID, leg: "entry", gen: 0,
    });

    simulateFullFill(api, entryId, 100, 149.50, entryRef);
    const result = await promise;

    const exitOrders = api.placedOrders.filter((o) => o.order.action === "SELL");
    for (const exit of exitOrders) {
      expect(exit.order.ocaType).toBe(2);
      expect(exit.order.transmit).toBe(true);
      expect(exit.order.tif).toBe("GTC");
      expect(exit.order.outsideRth).toBe(false);
    }

    ibkr.disconnect();
  });

  it("8. OCA group deterministic: OCA|tradeIntentId|gen", async () => {
    const ibkr = await connectIBKR();
    const tracker = makeTracker();
    ibkr.setTracker(tracker);

    const api = getApi(ibkr);
    const tradeIntentId = "AAPL-260612-01";

    const promise = ibkr.placeBracketOrder({
      symbol: SYMBOL,
      exchange: "SMART",
      currency: "USD",
      quantity: 100,
      limitPrice: 150.00,
      stopPrice: 145.00,
      takeProfitPrice: 160.00,
      tradeIntentId,
      conId: CON_ID,
    });

    await new Promise((r) => setTimeout(r, 10));
    const entryId = api.placedOrders[0].orderId;
    const entryRef = buildOrderRef({
      account: ACCOUNT, tradeIntentId, conId: CON_ID, leg: "entry", gen: 0,
    });

    simulateFullFill(api, entryId, 100, 149.50, entryRef);
    const result = await promise;

    const expectedOca = buildOcaGroup(tradeIntentId, 0);
    expect(expectedOca).toBe("OCA|AAPL-260612-01|0");

    const exitOrders = api.placedOrders.filter((o) => o.order.action === "SELL");
    for (const exit of exitOrders) {
      expect(exit.order.ocaGroup).toBe(expectedOca);
    }

    ibkr.disconnect();
  });

  it("9. order_submitted events for all legs in tracker", async () => {
    const ibkr = await connectIBKR();
    const tracker = makeTracker();
    ibkr.setTracker(tracker);

    const api = getApi(ibkr);
    const tradeIntentId = "AAPL-260612-01";

    const promise = ibkr.placeBracketOrder({
      symbol: SYMBOL,
      exchange: "SMART",
      currency: "USD",
      quantity: 100,
      limitPrice: 150.00,
      stopPrice: 145.00,
      takeProfitPrice: 160.00,
      tradeIntentId,
      conId: CON_ID,
    });

    await new Promise((r) => setTimeout(r, 10));
    const entryId = api.placedOrders[0].orderId;
    const entryRef = buildOrderRef({
      account: ACCOUNT, tradeIntentId, conId: CON_ID, leg: "entry", gen: 0,
    });

    // Entry order_submitted should already be in tracker
    const entryEvents = tracker.getEventsForOrder(entryRef);
    expect(entryEvents.length).toBeGreaterThanOrEqual(1);
    expect(entryEvents[0].type).toBe("order_submitted");

    // Simulate fill
    simulateFullFill(api, entryId, 100, 149.50, entryRef);
    const result = await promise;

    // Stop and TP order_submitted events
    const stopRef = buildOrderRef({
      account: ACCOUNT, tradeIntentId, conId: CON_ID, leg: "stop", gen: 0,
    });
    const tpRef = buildOrderRef({
      account: ACCOUNT, tradeIntentId, conId: CON_ID, leg: "tp", gen: 0,
    });

    const stopEvents = tracker.getEventsForOrder(stopRef);
    expect(stopEvents.some((e) => e.type === "order_submitted")).toBe(true);

    const tpEvents = tracker.getEventsForOrder(tpRef);
    expect(tpEvents.some((e) => e.type === "order_submitted")).toBe(true);

    ibkr.disconnect();
  });

  it("10. Partial-fill gen-increment → replacement intent events", async () => {
    const ibkr = await connectIBKR();
    const tracker = makeTracker();
    ibkr.setTracker(tracker);

    const api = getApi(ibkr);
    const tradeIntentId = "AAPL-260612-01";

    const promise = ibkr.placeBracketOrder({
      symbol: SYMBOL,
      exchange: "SMART",
      currency: "USD",
      quantity: 100,
      limitPrice: 150.00,
      stopPrice: 145.00,
      takeProfitPrice: 160.00,
      tradeIntentId,
      conId: CON_ID,
    });

    await new Promise((r) => setTimeout(r, 10));
    const entryId = api.placedOrders[0].orderId;
    const entryRef = buildOrderRef({
      account: ACCOUNT, tradeIntentId, conId: CON_ID, leg: "entry", gen: 0,
    });

    // First partial fill
    simulatePartialFill(api, entryId, 50, 50, 149.50, entryRef, "01");
    await new Promise((r) => setTimeout(r, 20));

    // Second fill triggering replacement
    simulatePartialFill(api, entryId, 50, 100, 149.50, entryRef, "02");
    await new Promise((r) => setTimeout(r, 20));

    // Stagger acks for gen=1 orders
    const gen1Exits = api.placedOrders.filter(
      (o) => o.order.action === "SELL" && o.order.orderRef?.includes("|1"),
    );
    for (const exit of gen1Exits) {
      simulateExitAck(api, exit.orderId);
      await new Promise((r) => setTimeout(r, 10));
    }

    // Stagger cancel acks for gen=0 orders
    const gen0Exits = api.placedOrders.filter(
      (o) => o.order.action === "SELL" && o.order.orderRef?.includes("|0"),
    );
    for (const exit of gen0Exits) {
      simulateExitCancelled(api, exit.orderId);
      await new Promise((r) => setTimeout(r, 10));
    }

    // Complete the entry
    simulateOrderStatus(api, entryId, "Filled", 100, 0, 149.50);
    const result = await promise;

    // Check for replacement intent events in tracker
    const gen0StopRef = buildOrderRef({
      account: ACCOUNT, tradeIntentId, conId: CON_ID, leg: "stop", gen: 0,
    });
    const intentEvents = tracker.getEventsForOrder(gen0StopRef);
    const hasStarted = intentEvents.some((e) => e.type === "replacement_intent_started");
    const hasConfirmed = intentEvents.some((e) => e.type === "replacement_intent_confirmed");
    expect(hasStarted).toBe(true);
    expect(hasConfirmed).toBe(true);

    ibkr.disconnect();
  });

  it("11. ZTS-Bug: Exit qty = cumQty, not orderQty (400/742)", async () => {
    const ibkr = await connectIBKR();
    const tracker = makeTracker();
    ibkr.setTracker(tracker);

    const api = getApi(ibkr);
    const tradeIntentId = "ZTS-260612-01";

    const promise = ibkr.placeBracketOrder({
      symbol: "ZTS",
      exchange: "SMART",
      currency: "USD",
      quantity: 742,
      limitPrice: 150.00,
      stopPrice: 145.00,
      takeProfitPrice: 160.00,
      tradeIntentId,
      conId: 12345,
    });

    await new Promise((r) => setTimeout(r, 10));
    const entryId = api.placedOrders[0].orderId;
    const entryRef = buildOrderRef({
      account: ACCOUNT, tradeIntentId, conId: 12345, leg: "entry", gen: 0,
    });

    // Only 400 of 742 filled, then entry cancelled
    simulatePartialFill(api, entryId, 400, 400, 149.50, entryRef, "01");
    await new Promise((r) => setTimeout(r, 10));
    simulateOrderStatus(api, entryId, "Cancelled", 400, 342, 149.50);

    const result = await promise;

    // Exit qty must be 400 (cumQty), NOT 742 (orderQty)
    expect(result.actualFilledQty).toBe(400);
    expect(result.stopLoss).toBeDefined();
    expect(result.stopLoss!.quantity).toBe(400);
    expect(result.takeProfit).toBeDefined();
    expect(result.takeProfit!.quantity).toBe(400);

    ibkr.disconnect();
  });

  it("12. BMY-Bug: Rebuy → new tradeIntentId, fresh exits", async () => {
    const ibkr = await connectIBKR();
    const tracker = makeTracker();
    ibkr.setTracker(tracker);

    const api = getApi(ibkr);

    // First trade: BMY-260612-01
    const tid1 = "BMY-260612-01";

    const promise1 = ibkr.placeBracketOrder({
      symbol: "BMY",
      exchange: "SMART",
      currency: "USD",
      quantity: 50,
      limitPrice: 60.00,
      stopPrice: 58.00,
      takeProfitPrice: 64.00,
      tradeIntentId: tid1,
      conId: 99999,
    });

    await new Promise((r) => setTimeout(r, 10));
    const entry1Id = api.placedOrders[0].orderId;
    const entry1Ref = buildOrderRef({
      account: ACCOUNT, tradeIntentId: tid1, conId: 99999, leg: "entry", gen: 0,
    });

    simulateFullFill(api, entry1Id, 50, 59.50, entry1Ref);
    const result1 = await promise1;
    expect(result1.actualFilledQty).toBe(50);

    // Record how many orders were placed for first trade
    const ordersAfterFirst = api.placedOrders.length;

    // Second trade (rebuy): BMY-260612-02
    const tid2 = "BMY-260612-02";

    const promise2 = ibkr.placeBracketOrder({
      symbol: "BMY",
      exchange: "SMART",
      currency: "USD",
      quantity: 50,
      limitPrice: 60.00,
      stopPrice: 58.00,
      takeProfitPrice: 64.00,
      tradeIntentId: tid2,
      conId: 99999,
    });

    await new Promise((r) => setTimeout(r, 10));
    const newOrders = api.placedOrders.slice(ordersAfterFirst);
    const entry2 = newOrders.find((o) => o.order.action === "BUY");
    expect(entry2).toBeDefined();
    const entry2Id = entry2!.orderId;
    const entry2Ref = buildOrderRef({
      account: ACCOUNT, tradeIntentId: tid2, conId: 99999, leg: "entry", gen: 0,
    });

    simulateFullFill(api, entry2Id, 50, 59.80, entry2Ref);
    const result2 = await promise2;
    expect(result2.actualFilledQty).toBe(50);

    // Key assertion: two different tradeIntentIds, both have their own exits
    expect(tid1).not.toBe(tid2);

    // First trade exits reference tid1
    const exit1Stop = buildOrderRef({
      account: ACCOUNT, tradeIntentId: tid1, conId: 99999, leg: "stop", gen: 0,
    });
    const exit1Submitted = tracker.getSubmittedEvent(exit1Stop);
    expect(exit1Submitted).not.toBeNull();

    // Second trade exits reference tid2
    const exit2Stop = buildOrderRef({
      account: ACCOUNT, tradeIntentId: tid2, conId: 99999, leg: "stop", gen: 0,
    });
    const exit2Submitted = tracker.getSubmittedEvent(exit2Stop);
    expect(exit2Submitted).not.toBeNull();

    // They are distinct entries in the tracker
    expect(exit1Stop).not.toBe(exit2Stop);

    ibkr.disconnect();
  });
});

describe("OrderStateTracker.getMaxTradeIntentSeq", () => {
  it("returns 0 when no matching intents exist", () => {
    const tracker = makeTracker();
    expect(tracker.getMaxTradeIntentSeq("AAPL", new Date(2026, 5, 12))).toBe(0);
  });

  it("returns highest seq for matching symbol+date", () => {
    const tracker = makeTracker();
    const log = (tracker as any).log as DurableEventLog;
    // Simulate two entries for AAPL on 260612
    log.appendEvent({
      type: "order_submitted",
      timestamp: new Date().toISOString(),
      orderRef: buildOrderRef({
        account: ACCOUNT, tradeIntentId: "AAPL-260612-01", conId: 265598, leg: "entry", gen: 0,
      }),
      orderId: 100,
      symbol: "AAPL",
      conId: 265598,
      action: "BUY",
      orderType: "LMT",
      quantity: 100,
      tif: "DAY",
      exchange: "SMART",
      currency: "USD",
    });
    log.appendEvent({
      type: "order_submitted",
      timestamp: new Date().toISOString(),
      orderRef: buildOrderRef({
        account: ACCOUNT, tradeIntentId: "AAPL-260612-03", conId: 265598, leg: "entry", gen: 0,
      }),
      orderId: 200,
      symbol: "AAPL",
      conId: 265598,
      action: "BUY",
      orderType: "LMT",
      quantity: 100,
      tif: "DAY",
      exchange: "SMART",
      currency: "USD",
    });
    tracker.rebuild();

    const seq = tracker.getMaxTradeIntentSeq("AAPL", new Date(2026, 5, 12));
    expect(seq).toBe(3);
  });
});

describe("resolveContractId", () => {
  it("resolves conId from contractDetails event", async () => {
    const ibkr = await connectIBKR();
    const conId = await ibkr.resolveContractId("AAPL", "SMART", "USD");
    expect(conId).toBe(265598);
    ibkr.disconnect();
  });
});
