import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  buildOrderRef,
  parseOrderRef,
  isOwnOrderRef,
  buildOcaGroup,
  buildTradeIntentId,
  execIdBase,
  DurableEventLog,
  OrderStateTracker,
  OrderIdSequencer,
  ORDER_REF_PREFIX,
  type OrderSubmittedEvent,
  type OrderStatusChangedEvent,
  type OrderFilledEvent,
  type OrderCancelledEvent,
  type IntentEvent,
  type OrderEvent,
} from "../src/order-state-tracker.js";

// ── Helpers ──

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ost-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function logPath(): string {
  return join(tmpDir, "orders-v2.jsonl");
}

function makeSubmitted(overrides: Partial<OrderSubmittedEvent> = {}): OrderSubmittedEvent {
  return {
    type: "order_submitted",
    timestamp: new Date().toISOString(),
    orderRef: buildOrderRef({
      account: "DUP514636",
      tradeIntentId: "AAPL-260611-01",
      conId: 265598,
      leg: "entry",
      gen: 0,
    }),
    symbol: "AAPL",
    conId: 265598,
    action: "BUY",
    orderType: "LMT",
    quantity: 10,
    limitPrice: 150.0,
    tif: "GTC",
    exchange: "SMART",
    currency: "USD",
    ...overrides,
  };
}

function makeStatusChanged(
  overrides: Partial<OrderStatusChangedEvent> = {},
): OrderStatusChangedEvent {
  return {
    type: "order_status_changed",
    timestamp: new Date().toISOString(),
    orderRef: buildOrderRef({
      account: "DUP514636",
      tradeIntentId: "AAPL-260611-01",
      conId: 265598,
      leg: "entry",
      gen: 0,
    }),
    status: "Submitted",
    filled: 0,
    remaining: 10,
    avgFillPrice: 0,
    ...overrides,
  };
}

function makeFilled(overrides: Partial<OrderFilledEvent> = {}): OrderFilledEvent {
  return {
    type: "order_filled",
    timestamp: new Date().toISOString(),
    orderRef: buildOrderRef({
      account: "DUP514636",
      tradeIntentId: "AAPL-260611-01",
      conId: 265598,
      leg: "entry",
      gen: 0,
    }),
    execId: "0000e0d5.6845b123.01.01",
    execIdBase: "0000e0d5.6845b123.01",
    side: "BOT",
    shares: 10,
    price: 149.50,
    cumQty: 10,
    avgPrice: 149.50,
    ...overrides,
  };
}

function makeCancelled(overrides: Partial<OrderCancelledEvent> = {}): OrderCancelledEvent {
  return {
    type: "order_cancelled",
    timestamp: new Date().toISOString(),
    orderRef: buildOrderRef({
      account: "DUP514636",
      tradeIntentId: "AAPL-260611-01",
      conId: 265598,
      leg: "entry",
      gen: 0,
    }),
    ...overrides,
  };
}

// ─── Group 1: orderRef Schema (6 Tests) ─────────────────────────────────────

describe("orderRef Schema", () => {
  it("1. buildOrderRef produces correct format", () => {
    const ref = buildOrderRef({
      account: "DUP514636",
      tradeIntentId: "AAPL-260611-01",
      conId: 265598,
      leg: "entry",
      gen: 0,
    });
    expect(ref).toBe("OCAGENT|DUP514636|AAPL-260611-01|265598|entry|0");
  });

  it("2. parseOrderRef round-trip is correct", () => {
    const components = {
      account: "DUP514636",
      tradeIntentId: "AAPL-260611-01",
      conId: 265598,
      leg: "entry" as const,
      gen: 0,
    };
    const ref = buildOrderRef(components);
    const parsed = parseOrderRef(ref);
    expect(parsed).toEqual(components);
  });

  it("3. parseOrderRef returns null for invalid inputs", () => {
    // Wrong prefix
    expect(parseOrderRef("WRONG|DUP514636|AAPL-260611-01|265598|entry|0")).toBeNull();
    // Invalid leg
    expect(parseOrderRef("OCAGENT|DUP514636|AAPL-260611-01|265598|market|0")).toBeNull();
    // Negative gen
    expect(parseOrderRef("OCAGENT|DUP514636|AAPL-260611-01|265598|entry|-1")).toBeNull();
    // Missing parts
    expect(parseOrderRef("OCAGENT|DUP514636|AAPL-260611-01")).toBeNull();
  });

  it("4. isOwnOrderRef true/false", () => {
    expect(isOwnOrderRef("OCAGENT|DUP514636|AAPL-260611-01|265598|entry|0")).toBe(true);
    expect(isOwnOrderRef("OTHER|DUP514636|AAPL-260611-01|265598|entry|0")).toBe(false);
    expect(isOwnOrderRef("")).toBe(false);
    expect(isOwnOrderRef("OCAGENT")).toBe(false);
  });

  it("5. buildOcaGroup produces correct format", () => {
    expect(buildOcaGroup("AAPL-260611-01", 0)).toBe("OCA|AAPL-260611-01|0");
    expect(buildOcaGroup("MSFT-260612-03", 2)).toBe("OCA|MSFT-260612-03|2");
  });

  it("6. buildTradeIntentId produces correct format", () => {
    const date = new Date(2026, 5, 11); // June 11, 2026
    expect(buildTradeIntentId("AAPL", date, 1)).toBe("AAPL-260611-01");
    expect(buildTradeIntentId("MSFT", date, 12)).toBe("MSFT-260611-12");
  });
});

// ─── Group 2: execId Correction (3 Tests) ───────────────────────────────────

describe("execId Correction", () => {
  it("7. execIdBase extracts base correctly", () => {
    expect(execIdBase("0000e0d5.6845b123.01.01")).toBe("0000e0d5.6845b123.01");
  });

  it("8. single-segment execId returns unchanged", () => {
    expect(execIdBase("singleSegment")).toBe("singleSegment");
  });

  it("9. two-segment execId", () => {
    expect(execIdBase("abc.def")).toBe("abc");
  });
});

// ─── Group 3: DurableEventLog (6 Tests) ─────────────────────────────────────

describe("DurableEventLog", () => {
  it("10. appendEvent + loadEvents round-trip (3 events)", () => {
    const log = new DurableEventLog(logPath());
    const e1 = makeSubmitted();
    const e2 = makeStatusChanged();
    const e3 = makeFilled();

    log.appendEvent(e1);
    log.appendEvent(e2);
    log.appendEvent(e3);

    const result = log.loadEvents();
    expect(result.events).toHaveLength(3);
    expect(result.corrupted).toBe(false);
    expect(result.quarantinedLine).toBeNull();
    expect(result.events[0].type).toBe("order_submitted");
    expect(result.events[1].type).toBe("order_status_changed");
    expect(result.events[2].type).toBe("order_filled");
  });

  it("11. fsync guarantee: after append, immediately readable", () => {
    const log = new DurableEventLog(logPath());
    const event = makeSubmitted();
    log.appendEvent(event);

    // Immediately read back with a new log instance (simulates separate process)
    const log2 = new DurableEventLog(logPath());
    const result = log2.loadEvents();
    expect(result.events).toHaveLength(1);
    expect(result.events[0].type).toBe("order_submitted");
  });

  it("12. quarantine: valid line + truncated JSON → quarantined, good events OK", () => {
    const log = new DurableEventLog(logPath());
    const event = makeSubmitted();
    log.appendEvent(event);

    // Manually append a truncated line
    const existing = readFileSync(logPath(), "utf8");
    writeFileSync(logPath(), existing + '{"type":"order_sta', "utf8");

    const result = log.loadEvents();
    expect(result.events).toHaveLength(1);
    expect(result.corrupted).toBe(false);
    expect(result.quarantinedLine).toBe('{"type":"order_sta');

    // Verify quarantine file exists
    expect(existsSync(logPath() + ".quarantine")).toBe(true);
  });

  it("13. fail-closed: 2 corrupt lines → corrupted=true", () => {
    const path = logPath();
    writeFileSync(path, '{"valid":"event","type":"order_submitted","timestamp":"t","orderRef":"r","symbol":"S","conId":1,"action":"BUY","orderType":"LMT","quantity":1,"tif":"GTC","exchange":"SMART","currency":"USD"}\nBAD LINE 1\nBAD LINE 2\n', "utf8");

    const log = new DurableEventLog(path);
    const result = log.loadEvents();
    expect(result.corrupted).toBe(true);
    expect(result.events).toHaveLength(1);
  });

  it("14. empty file → 0 events", () => {
    const path = logPath();
    writeFileSync(path, "", "utf8");

    const log = new DurableEventLog(path);
    const result = log.loadEvents();
    expect(result.events).toHaveLength(0);
    expect(result.corrupted).toBe(false);
  });

  it("15. missing file → 0 events", () => {
    const log = new DurableEventLog(join(tmpDir, "nonexistent.jsonl"));
    const result = log.loadEvents();
    expect(result.events).toHaveLength(0);
    expect(result.corrupted).toBe(false);
  });
});

// ─── Group 4: Tracker Rebuild (7 Tests) ──────────────────────────────────────

describe("Tracker Rebuild", () => {
  it("16. rebuild from clean log with 5 mixed events", () => {
    const log = new DurableEventLog(logPath());
    const entryRef = buildOrderRef({
      account: "DUP514636",
      tradeIntentId: "AAPL-260611-01",
      conId: 265598,
      leg: "entry",
      gen: 0,
    });
    const stopRef = buildOrderRef({
      account: "DUP514636",
      tradeIntentId: "AAPL-260611-01",
      conId: 265598,
      leg: "stop",
      gen: 0,
    });

    log.appendEvent(makeSubmitted({ orderRef: entryRef }));
    log.appendEvent(makeStatusChanged({ orderRef: entryRef, status: "Filled", filled: 10, remaining: 0, avgFillPrice: 149.50 }));
    log.appendEvent(makeFilled({ orderRef: entryRef }));
    log.appendEvent(makeSubmitted({ orderRef: stopRef, action: "SELL", orderType: "STP" }));
    log.appendEvent(makeStatusChanged({ orderRef: stopRef, status: "PreSubmitted", filled: 0, remaining: 10, avgFillPrice: 0 }));

    const tracker = new OrderStateTracker(log);
    const result = tracker.rebuild();

    expect(result.tradingLocked).toBe(false);
    expect(result.openIntents).toHaveLength(0);
    expect(result.quarantinedLine).toBeNull();
    expect(tracker.getEventsForOrder(entryRef)).toHaveLength(3);
    expect(tracker.getEventsForOrder(stopRef)).toHaveLength(2);
  });

  it("17. rebuild detects open intent at startup", () => {
    const log = new DurableEventLog(logPath());
    const ref = buildOrderRef({
      account: "DUP514636",
      tradeIntentId: "AAPL-260611-01",
      conId: 265598,
      leg: "stop",
      gen: 0,
    });

    const intent: IntentEvent = {
      type: "replacement_intent_started",
      timestamp: new Date().toISOString(),
      orderRef: ref,
      targetOrderRef: "some-target",
      reason: "missing_stop",
      newGen: 1,
    };
    log.appendEvent(intent);

    const tracker = new OrderStateTracker(log);
    const result = tracker.rebuild();

    expect(result.openIntents).toHaveLength(1);
    expect(result.openIntents[0].orderRef).toBe(ref);
    expect(result.openIntents[0].type).toBe("replacement_intent_started");
  });

  it("18. deduplicates orderStatus events", () => {
    const log = new DurableEventLog(logPath());
    const ref = buildOrderRef({
      account: "DUP514636",
      tradeIntentId: "AAPL-260611-01",
      conId: 265598,
      leg: "entry",
      gen: 0,
    });

    log.appendEvent(makeSubmitted({ orderRef: ref }));

    // Same status event twice
    const statusEvent = makeStatusChanged({
      orderRef: ref,
      status: "Submitted",
      filled: 0,
      remaining: 10,
      avgFillPrice: 0,
    });
    log.appendEvent(statusEvent);
    log.appendEvent(statusEvent);

    const tracker = new OrderStateTracker(log);
    tracker.rebuild();

    // After rebuild, applying the same status should be deduplicated
    const isDuplicate = !tracker.applyEvent(statusEvent);
    expect(isDuplicate).toBe(true);
  });

  it("19. deduplicates exact execId repetitions", () => {
    const log = new DurableEventLog(logPath());
    const ref = buildOrderRef({
      account: "DUP514636",
      tradeIntentId: "AAPL-260611-01",
      conId: 265598,
      leg: "entry",
      gen: 0,
    });

    log.appendEvent(makeSubmitted({ orderRef: ref }));

    const fillEvent = makeFilled({
      orderRef: ref,
      execId: "0000e0d5.6845b123.01.01",
      execIdBase: "0000e0d5.6845b123.01",
    });
    log.appendEvent(fillEvent);

    const tracker = new OrderStateTracker(log);
    tracker.rebuild();

    // Same execId should be deduplicated
    const isDuplicate = !tracker.applyEvent(fillEvent);
    expect(isDuplicate).toBe(true);
  });

  it("20. execId correction: .02 replaces .01", () => {
    const log = new DurableEventLog(logPath());
    const ref = buildOrderRef({
      account: "DUP514636",
      tradeIntentId: "AAPL-260611-01",
      conId: 265598,
      leg: "entry",
      gen: 0,
    });

    log.appendEvent(makeSubmitted({ orderRef: ref }));

    // Original fill
    log.appendEvent(makeFilled({
      orderRef: ref,
      execId: "0000e0d5.6845b123.01.01",
      execIdBase: "0000e0d5.6845b123.01",
      price: 149.50,
      shares: 10,
      cumQty: 10,
      avgPrice: 149.50,
    }));

    const tracker = new OrderStateTracker(log);
    tracker.rebuild();

    // Correction fill (same base, different suffix)
    const correctionFill = makeFilled({
      orderRef: ref,
      execId: "0000e0d5.6845b123.01.02",
      execIdBase: "0000e0d5.6845b123.01",
      price: 150.00,
      shares: 10,
      cumQty: 10,
      avgPrice: 150.00,
    });

    const applied = tracker.applyEvent(correctionFill);
    expect(applied).toBe(true);

    // The original execId should no longer be considered a duplicate
    // (it was replaced by the correction)
    const originalAgain = makeFilled({
      orderRef: ref,
      execId: "0000e0d5.6845b123.01.01",
      execIdBase: "0000e0d5.6845b123.01",
      price: 149.50,
      shares: 10,
      cumQty: 10,
      avgPrice: 149.50,
    });
    // Original execId is no longer tracked — the correction replaced it
    const canApplyOriginal = !tracker.applyEvent(originalAgain);
    // This should NOT be deduplicated since the correction cleared the original
    expect(canApplyOriginal).toBe(false);
  });

  it("21. corrupt last line → quarantined, state from good lines, tradingLocked=false", () => {
    const log = new DurableEventLog(logPath());
    const ref = buildOrderRef({
      account: "DUP514636",
      tradeIntentId: "AAPL-260611-01",
      conId: 265598,
      leg: "entry",
      gen: 0,
    });

    log.appendEvent(makeSubmitted({ orderRef: ref }));

    // Manually append truncated JSON
    const existing = readFileSync(logPath(), "utf8");
    writeFileSync(logPath(), existing + '{"truncated', "utf8");

    const tracker = new OrderStateTracker(log);
    const result = tracker.rebuild();

    expect(result.tradingLocked).toBe(false);
    expect(result.quarantinedLine).toBe('{"truncated');
    expect(tracker.getEventsForOrder(ref)).toHaveLength(1);
  });

  it("22. >1 corrupt lines → tradingLocked=true", () => {
    const path = logPath();
    const goodEvent = makeSubmitted();
    writeFileSync(path, JSON.stringify(goodEvent) + "\nBAD1\nBAD2\n", "utf8");

    const log = new DurableEventLog(path);
    const tracker = new OrderStateTracker(log);
    const result = tracker.rebuild();

    expect(result.tradingLocked).toBe(true);
  });
});

// ─── Group 5: applyEvent (5 Tests) ──────────────────────────────────────────

describe("applyEvent", () => {
  it("23. new event is persisted and projected", () => {
    const log = new DurableEventLog(logPath());
    const tracker = new OrderStateTracker(log);
    tracker.rebuild();

    const event = makeSubmitted();
    const applied = tracker.applyEvent(event);
    expect(applied).toBe(true);
    expect(tracker.getEventsForOrder(event.orderRef)).toHaveLength(1);

    // Verify it was persisted
    const result = log.loadEvents();
    expect(result.events).toHaveLength(1);
  });

  it("24. duplicate status → false", () => {
    const log = new DurableEventLog(logPath());
    const tracker = new OrderStateTracker(log);
    tracker.rebuild();

    const ref = buildOrderRef({
      account: "DUP514636",
      tradeIntentId: "AAPL-260611-01",
      conId: 265598,
      leg: "entry",
      gen: 0,
    });

    tracker.applyEvent(makeSubmitted({ orderRef: ref }));

    const statusEvent = makeStatusChanged({
      orderRef: ref,
      status: "Submitted",
      filled: 0,
      remaining: 10,
      avgFillPrice: 0,
    });
    expect(tracker.applyEvent(statusEvent)).toBe(true);
    expect(tracker.applyEvent(statusEvent)).toBe(false);
  });

  it("25. duplicate execId → false", () => {
    const log = new DurableEventLog(logPath());
    const tracker = new OrderStateTracker(log);
    tracker.rebuild();

    const ref = buildOrderRef({
      account: "DUP514636",
      tradeIntentId: "AAPL-260611-01",
      conId: 265598,
      leg: "entry",
      gen: 0,
    });

    tracker.applyEvent(makeSubmitted({ orderRef: ref }));

    const fillEvent = makeFilled({ orderRef: ref });
    expect(tracker.applyEvent(fillEvent)).toBe(true);
    expect(tracker.applyEvent(fillEvent)).toBe(false);
  });

  it("26. tradingLocked + non-intent → throws", () => {
    const path = logPath();
    const goodEvent = makeSubmitted();
    writeFileSync(path, JSON.stringify(goodEvent) + "\nBAD1\nBAD2\n", "utf8");

    const log = new DurableEventLog(path);
    const tracker = new OrderStateTracker(log);
    tracker.rebuild();

    expect(tracker.tradingLocked).toBe(true);

    expect(() => tracker.applyEvent(makeSubmitted())).toThrow(/Trading locked/);
  });

  it("27. tradingLocked + intent resolution → allowed", () => {
    const path = logPath();
    const goodEvent = makeSubmitted();
    writeFileSync(path, JSON.stringify(goodEvent) + "\nBAD1\nBAD2\n", "utf8");

    const log = new DurableEventLog(path);
    const tracker = new OrderStateTracker(log);
    tracker.rebuild();

    expect(tracker.tradingLocked).toBe(true);

    const ref = buildOrderRef({
      account: "DUP514636",
      tradeIntentId: "AAPL-260611-01",
      conId: 265598,
      leg: "stop",
      gen: 0,
    });

    const intentResolution: IntentEvent = {
      type: "replacement_intent_confirmed",
      timestamp: new Date().toISOString(),
      orderRef: ref,
    };

    // Should not throw
    expect(() => tracker.applyEvent(intentResolution)).not.toThrow();
  });
});

// ─── Group 6: getExitState (4 Tests) ────────────────────────────────────────

describe("getExitState", () => {
  it("28. correct stop + TP for simple bracket", () => {
    const log = new DurableEventLog(logPath());
    const tracker = new OrderStateTracker(log);
    tracker.rebuild();

    const conId = 265598;
    const entryRef = buildOrderRef({ account: "DUP514636", tradeIntentId: "AAPL-260611-01", conId, leg: "entry", gen: 0 });
    const stopRef = buildOrderRef({ account: "DUP514636", tradeIntentId: "AAPL-260611-01", conId, leg: "stop", gen: 0 });
    const tpRef = buildOrderRef({ account: "DUP514636", tradeIntentId: "AAPL-260611-01", conId, leg: "tp", gen: 0 });

    tracker.applyEvent(makeSubmitted({ orderRef: entryRef, conId }));
    tracker.applyEvent(makeFilled({ orderRef: entryRef, cumQty: 10 }));
    tracker.applyEvent(makeSubmitted({ orderRef: stopRef, conId, action: "SELL", orderType: "STP" }));
    tracker.applyEvent(makeStatusChanged({ orderRef: stopRef, status: "PreSubmitted", filled: 0, remaining: 10, avgFillPrice: 0 }));
    tracker.applyEvent(makeSubmitted({ orderRef: tpRef, conId, action: "SELL", orderType: "LMT" }));
    tracker.applyEvent(makeStatusChanged({ orderRef: tpRef, status: "PreSubmitted", filled: 0, remaining: 10, avgFillPrice: 0 }));

    const exitState = tracker.getExitState(conId);
    expect(exitState).not.toBeNull();
    expect(exitState!.stopOrder).toBeDefined();
    expect(exitState!.stopOrder!.orderRef).toBe(stopRef);
    expect(exitState!.tpOrder).toBeDefined();
    expect(exitState!.tpOrder!.orderRef).toBe(tpRef);
    expect(exitState!.qty).toBe(10);
    expect(exitState!.gen).toBe(0);
  });

  it("29. unknown conId → null", () => {
    const log = new DurableEventLog(logPath());
    const tracker = new OrderStateTracker(log);
    tracker.rebuild();

    expect(tracker.getExitState(999999)).toBeNull();
  });

  it("30. generation tracking: gen-0 cancelled → gen-1 submitted → returns gen-1", () => {
    const log = new DurableEventLog(logPath());
    const tracker = new OrderStateTracker(log);
    tracker.rebuild();

    const conId = 265598;

    // Gen 0 entry + stop
    const entryRef0 = buildOrderRef({ account: "DUP514636", tradeIntentId: "AAPL-260611-01", conId, leg: "entry", gen: 0 });
    const stopRef0 = buildOrderRef({ account: "DUP514636", tradeIntentId: "AAPL-260611-01", conId, leg: "stop", gen: 0 });
    tracker.applyEvent(makeSubmitted({ orderRef: entryRef0, conId }));
    tracker.applyEvent(makeFilled({ orderRef: entryRef0, cumQty: 10 }));
    tracker.applyEvent(makeSubmitted({ orderRef: stopRef0, conId, action: "SELL", orderType: "STP" }));
    tracker.applyEvent(makeCancelled({ orderRef: stopRef0 }));

    // Gen 1 stop
    const stopRef1 = buildOrderRef({ account: "DUP514636", tradeIntentId: "AAPL-260611-01", conId, leg: "stop", gen: 1 });
    tracker.applyEvent(makeSubmitted({ orderRef: stopRef1, conId, action: "SELL", orderType: "STP" }));
    tracker.applyEvent(makeStatusChanged({ orderRef: stopRef1, status: "PreSubmitted", filled: 0, remaining: 10, avgFillPrice: 0 }));

    const exitState = tracker.getExitState(conId);
    expect(exitState).not.toBeNull();
    expect(exitState!.gen).toBe(1);
    expect(exitState!.stopOrder).toBeDefined();
    expect(exitState!.stopOrder!.orderRef).toBe(stopRef1);
  });

  it("31. filled/cancelled exit orders not returned", () => {
    const log = new DurableEventLog(logPath());
    const tracker = new OrderStateTracker(log);
    tracker.rebuild();

    const conId = 265598;
    const entryRef = buildOrderRef({ account: "DUP514636", tradeIntentId: "AAPL-260611-01", conId, leg: "entry", gen: 0 });
    const stopRef = buildOrderRef({ account: "DUP514636", tradeIntentId: "AAPL-260611-01", conId, leg: "stop", gen: 0 });

    tracker.applyEvent(makeSubmitted({ orderRef: entryRef, conId }));
    tracker.applyEvent(makeFilled({ orderRef: entryRef, cumQty: 10 }));
    tracker.applyEvent(makeSubmitted({ orderRef: stopRef, conId, action: "SELL", orderType: "STP" }));
    tracker.applyEvent(makeStatusChanged({ orderRef: stopRef, status: "Filled", filled: 10, remaining: 0, avgFillPrice: 145.00 }));

    const exitState = tracker.getExitState(conId);
    expect(exitState).not.toBeNull();
    expect(exitState!.stopOrder).toBeUndefined();
  });

  it("31b. gen-1 replacement derives qty from stop/tp submitted quantity", () => {
    const log = new DurableEventLog(logPath());
    const tracker = new OrderStateTracker(log);
    tracker.rebuild();

    const conId = 265598;

    // Gen 0: entry filled with 10, stop submitted with 10, then cancelled
    const entryRef0 = buildOrderRef({ account: "DUP514636", tradeIntentId: "AAPL-260611-01", conId, leg: "entry", gen: 0 });
    const stopRef0 = buildOrderRef({ account: "DUP514636", tradeIntentId: "AAPL-260611-01", conId, leg: "stop", gen: 0 });
    tracker.applyEvent(makeSubmitted({ orderRef: entryRef0, conId }));
    tracker.applyEvent(makeFilled({ orderRef: entryRef0, cumQty: 10 }));
    tracker.applyEvent(makeSubmitted({ orderRef: stopRef0, conId, action: "SELL", orderType: "STP", quantity: 10 }));
    tracker.applyEvent(makeCancelled({ orderRef: stopRef0 }));

    // Gen 1: replacement stop + tp, no new entry — qty must come from these legs
    const stopRef1 = buildOrderRef({ account: "DUP514636", tradeIntentId: "AAPL-260611-01", conId, leg: "stop", gen: 1 });
    const tpRef1 = buildOrderRef({ account: "DUP514636", tradeIntentId: "AAPL-260611-01", conId, leg: "tp", gen: 1 });
    tracker.applyEvent(makeSubmitted({ orderRef: stopRef1, conId, action: "SELL", orderType: "STP", quantity: 10 }));
    tracker.applyEvent(makeStatusChanged({ orderRef: stopRef1, status: "PreSubmitted", filled: 0, remaining: 10, avgFillPrice: 0 }));
    tracker.applyEvent(makeSubmitted({ orderRef: tpRef1, conId, action: "SELL", orderType: "LMT", quantity: 10 }));
    tracker.applyEvent(makeStatusChanged({ orderRef: tpRef1, status: "PreSubmitted", filled: 0, remaining: 10, avgFillPrice: 0 }));

    const exitState = tracker.getExitState(conId);
    expect(exitState).not.toBeNull();
    expect(exitState!.gen).toBe(1);
    expect(exitState!.qty).toBe(10);
    expect(exitState!.stopOrder).toBeDefined();
    expect(exitState!.tpOrder).toBeDefined();
  });

  it("31c. differing stop/tp submitted qty yields qty=-1 mismatch marker", () => {
    const log = new DurableEventLog(logPath());
    const tracker = new OrderStateTracker(log);
    tracker.rebuild();

    const conId = 265598;

    // Submit stop with qty=10, tp with qty=5 — intentional mismatch scenario
    const stopRef = buildOrderRef({ account: "DUP514636", tradeIntentId: "AAPL-260611-01", conId, leg: "stop", gen: 0 });
    const tpRef = buildOrderRef({ account: "DUP514636", tradeIntentId: "AAPL-260611-01", conId, leg: "tp", gen: 0 });
    tracker.applyEvent(makeSubmitted({ orderRef: stopRef, conId, action: "SELL", orderType: "STP", quantity: 10 }));
    tracker.applyEvent(makeStatusChanged({ orderRef: stopRef, status: "PreSubmitted", filled: 0, remaining: 10, avgFillPrice: 0 }));
    tracker.applyEvent(makeSubmitted({ orderRef: tpRef, conId, action: "SELL", orderType: "LMT", quantity: 5 }));
    tracker.applyEvent(makeStatusChanged({ orderRef: tpRef, status: "PreSubmitted", filled: 0, remaining: 5, avgFillPrice: 0 }));

    const exitState = tracker.getExitState(conId);
    expect(exitState).not.toBeNull();
    expect(exitState!.qty).toBe(-1);
  });
});

// ─── Group 7: getOpenIntents (3 Tests) ──────────────────────────────────────

describe("getOpenIntents", () => {
  it("32. empty when no intents", () => {
    const log = new DurableEventLog(logPath());
    const tracker = new OrderStateTracker(log);
    tracker.rebuild();

    expect(tracker.getOpenIntents()).toHaveLength(0);
  });

  it("33. returns started, not confirmed intents", () => {
    const log = new DurableEventLog(logPath());
    const tracker = new OrderStateTracker(log);
    tracker.rebuild();

    const ref = buildOrderRef({
      account: "DUP514636",
      tradeIntentId: "AAPL-260611-01",
      conId: 265598,
      leg: "stop",
      gen: 0,
    });

    tracker.applyEvent({
      type: "replacement_intent_started",
      timestamp: new Date().toISOString(),
      orderRef: ref,
      targetOrderRef: "target",
      reason: "missing_stop",
      newGen: 1,
    } as IntentEvent);

    const intents = tracker.getOpenIntents();
    expect(intents).toHaveLength(1);
    expect(intents[0].orderRef).toBe(ref);
  });

  it("34. removes intent after confirmed/abandoned", () => {
    const log = new DurableEventLog(logPath());
    const tracker = new OrderStateTracker(log);
    tracker.rebuild();

    const ref = buildOrderRef({
      account: "DUP514636",
      tradeIntentId: "AAPL-260611-01",
      conId: 265598,
      leg: "stop",
      gen: 0,
    });

    tracker.applyEvent({
      type: "replacement_intent_started",
      timestamp: new Date().toISOString(),
      orderRef: ref,
      targetOrderRef: "target",
      reason: "missing_stop",
      newGen: 1,
    } as IntentEvent);

    expect(tracker.getOpenIntents()).toHaveLength(1);

    tracker.applyEvent({
      type: "replacement_intent_confirmed",
      timestamp: new Date().toISOString(),
      orderRef: ref,
    } as IntentEvent);

    expect(tracker.getOpenIntents()).toHaveLength(0);
  });
});

// ─── Group 8: OrderIdSequencer (3 Tests) ─────────────────────────────────────

describe("OrderIdSequencer", () => {
  it("35. arm() sets floor: next() > highestSeen", () => {
    const seq = new OrderIdSequencer();
    seq.arm(100);
    const id = seq.next();
    expect(id).toBe(101);
  });

  it("36. next() incorporates trackSeenId", () => {
    const seq = new OrderIdSequencer();
    seq.setNextValidId(10);
    expect(seq.next()).toBe(10);

    // Now track a high seen id
    seq.trackSeenId(50);
    expect(seq.next()).toBe(51);
  });

  it("37. setNextValidId with higher value → uses higher", () => {
    const seq = new OrderIdSequencer();
    seq.arm(10);
    seq.setNextValidId(100);
    const id = seq.next();
    expect(id).toBe(100);

    // After next(), nextValidId advances
    seq.setNextValidId(50); // lower than current
    seq.trackSeenId(200);
    expect(seq.next()).toBe(201);
  });
});
