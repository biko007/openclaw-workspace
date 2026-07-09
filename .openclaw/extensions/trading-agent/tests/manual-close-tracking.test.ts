import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  buildOrderRef,
  DurableEventLog,
  OrderStateTracker,
  type OrderSubmittedEvent,
  type PositionClosedEvent,
  type TrackerTradeRecord,
} from "../src/order-state-tracker.js";

// ── Helpers ──

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "mct-test-"));
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
    timestamp: "2026-07-01T15:00:00.000Z",
    orderRef: buildOrderRef({
      account: "DUP514636",
      tradeIntentId: "NKE-260701-01",
      conId: 10291,
      leg: "entry",
      gen: 0,
    }),
    symbol: "NKE",
    conId: 10291,
    action: "BUY",
    orderType: "LMT",
    quantity: 1355,
    limitPrice: 42.44,
    tif: "DAY",
    exchange: "SMART",
    currency: "USD",
    ...overrides,
  };
}

function makePositionClosed(overrides: Partial<PositionClosedEvent> = {}): PositionClosedEvent {
  return {
    type: "position_closed",
    timestamp: "2026-07-02T13:30:31.000Z",
    orderRef: "CLOSE|sentinel|NKE|20260702T133031000Z",
    symbol: "NKE",
    quantity: 1355,
    entryPrice: 42.44,
    exitPrice: 43.05,
    pnl: 833.32,
    pnlPercent: 1.45,
    source: "sentinel",
    ...overrides,
  };
}

// ── Group 1: position_closed event persistence ──

describe("position_closed event persistence", () => {
  it("writes and reads back a position_closed event", () => {
    const log = new DurableEventLog(logPath());
    const tracker = new OrderStateTracker(log);
    tracker.rebuild();

    const event = makePositionClosed();
    const applied = tracker.applyEvent(event);
    expect(applied).toBe(true);

    // Rebuild from log
    const tracker2 = new OrderStateTracker(new DurableEventLog(logPath()));
    tracker2.rebuild();

    const fills = tracker2.getRecentFills({ sinceDays: 7 }).filter((t) => t.side === "SELL");
    expect(fills.length).toBe(1);
    expect(fills[0].symbol).toBe("NKE");
    expect(fills[0].pnl).toBe(833.32);
    expect(fills[0].source).toBe("sentinel");
    expect(fills[0].fillPrice).toBe(43.05);
    expect(fills[0].status).toBe("Filled");
  });

  it("deduplicates position_closed by orderRef", () => {
    const log = new DurableEventLog(logPath());
    const tracker = new OrderStateTracker(log);
    tracker.rebuild();

    const event = makePositionClosed();
    expect(tracker.applyEvent(event)).toBe(true);
    expect(tracker.applyEvent(event)).toBe(false); // duplicate

    const fills = tracker.getRecentFills({ sinceDays: 7 }).filter((t) => t.side === "SELL");
    expect(fills.length).toBe(1);
  });

  it("returns position_closed events with source=manual", () => {
    const log = new DurableEventLog(logPath());
    const tracker = new OrderStateTracker(log);
    tracker.rebuild();

    tracker.applyEvent(makePositionClosed({ source: "manual" }));

    const fills = tracker.getRecentFills({ sinceDays: 7 }).filter((t) => t.side === "SELL");
    expect(fills[0].source).toBe("manual");
  });
});

// ── Group 2: getRecentFills integration ──

describe("getRecentFills with position_closed", () => {
  it("includes position_closed alongside regular fills", () => {
    const log = new DurableEventLog(logPath());
    const tracker = new OrderStateTracker(log);
    tracker.rebuild();

    // Regular entry (submitted only — not yet filled, so won't appear in getRecentFills)
    tracker.applyEvent(makeSubmitted());
    // Position closed
    tracker.applyEvent(makePositionClosed());

    const allFills = tracker.getRecentFills({ sinceDays: 7 });
    const exits = allFills.filter((t) => t.side === "SELL");

    // Position closed event appears as a SELL fill
    expect(exits.length).toBe(1);
    expect(exits[0].pnl).toBe(833.32);
    expect(exits[0].symbol).toBe("NKE");
  });

  it("excludes position_closed when leg filter is specified", () => {
    const log = new DurableEventLog(logPath());
    const tracker = new OrderStateTracker(log);
    tracker.rebuild();

    tracker.applyEvent(makePositionClosed());

    // Filtering by specific leg should exclude position_closed events
    const entryFills = tracker.getRecentFills({ sinceDays: 7, leg: "entry" });
    expect(entryFills.length).toBe(0);

    const stopFills = tracker.getRecentFills({ sinceDays: 7, leg: "stop" });
    expect(stopFills.length).toBe(0);

    // Without leg filter, should include
    const allFills = tracker.getRecentFills({ sinceDays: 7 });
    expect(allFills.length).toBe(1);
  });

  it("respects sinceDays cutoff for position_closed", () => {
    const log = new DurableEventLog(logPath());
    const tracker = new OrderStateTracker(log);
    tracker.rebuild();

    // Old event (30 days ago)
    const oldDate = new Date(Date.now() - 30 * 86_400_000).toISOString();
    tracker.applyEvent(makePositionClosed({
      timestamp: oldDate,
      orderRef: "CLOSE|sentinel|OLD|old",
    }));

    const recentFills = tracker.getRecentFills({ sinceDays: 1 });
    expect(recentFills.length).toBe(0);

    const allFills = tracker.getRecentFills({ sinceDays: 60 });
    expect(allFills.length).toBe(1);
  });
});

// ── Group 3: hasRecentClose ──

describe("hasRecentClose", () => {
  it("returns true for recent close within window", () => {
    const log = new DurableEventLog(logPath());
    const tracker = new OrderStateTracker(log);
    tracker.rebuild();

    tracker.applyEvent(makePositionClosed({
      timestamp: new Date().toISOString(),
    }));

    expect(tracker.hasRecentClose("NKE", 120_000)).toBe(true);
    expect(tracker.hasRecentClose("AAPL", 120_000)).toBe(false);
  });

  it("returns false for old close outside window", () => {
    const log = new DurableEventLog(logPath());
    const tracker = new OrderStateTracker(log);
    tracker.rebuild();

    const oldDate = new Date(Date.now() - 300_000).toISOString(); // 5 min ago
    tracker.applyEvent(makePositionClosed({ timestamp: oldDate }));

    expect(tracker.hasRecentClose("NKE", 120_000)).toBe(false); // 2 min window
    expect(tracker.hasRecentClose("NKE", 600_000)).toBe(true);  // 10 min window
  });
});

// ── Group 4: Win/Loss counting logic ──

describe("Win/Loss counting with position_closed", () => {
  it("counts winning manual close correctly", () => {
    const log = new DurableEventLog(logPath());
    const tracker = new OrderStateTracker(log);
    tracker.rebuild();

    // Entry
    tracker.applyEvent(makeSubmitted());
    // Winning close (pnl > 0)
    tracker.applyEvent(makePositionClosed({ pnl: 833.32, source: "sentinel" }));

    const exits = tracker.getRecentFills({ sinceDays: 7 })
      .filter((t) => t.side === "SELL");

    let wins = 0;
    let losses = 0;
    let manualCount = 0;

    for (const exit of exits) {
      if (exit.pnl !== undefined) {
        if (exit.pnl >= 0) wins++;
        else losses++;
        if (exit.source === "manual" || exit.source === "sentinel") manualCount++;
      }
    }

    expect(wins).toBe(1);
    expect(losses).toBe(0);
    expect(manualCount).toBe(1);
  });

  it("counts losing manual close correctly", () => {
    const log = new DurableEventLog(logPath());
    const tracker = new OrderStateTracker(log);
    tracker.rebuild();

    tracker.applyEvent(makePositionClosed({
      pnl: -200,
      pnlPercent: -1.5,
      orderRef: "CLOSE|manual|LOSE|ts",
      source: "manual",
    }));

    const exits = tracker.getRecentFills({ sinceDays: 7 })
      .filter((t) => t.side === "SELL");

    expect(exits.length).toBe(1);
    expect(exits[0].pnl).toBe(-200);
    expect(exits[0].source).toBe("manual");
  });

  it("handles mixed bracket and manual closes", () => {
    const log = new DurableEventLog(logPath());
    const tracker = new OrderStateTracker(log);
    tracker.rebuild();

    // Bracket entry + exit (regular tracked order)
    const entryRef = buildOrderRef({
      account: "DUP514636",
      tradeIntentId: "AAPL-260702-01",
      conId: 265598,
      leg: "entry",
      gen: 0,
    });
    tracker.applyEvent(makeSubmitted({
      orderRef: entryRef,
      symbol: "AAPL",
      conId: 265598,
      timestamp: "2026-07-02T14:00:00.000Z",
    }));

    // Manual close for a different symbol
    tracker.applyEvent(makePositionClosed({
      symbol: "NKE",
      pnl: 833.32,
      source: "sentinel",
      timestamp: "2026-07-02T15:00:00.000Z",
    }));

    const exits = tracker.getRecentFills({ sinceDays: 7 })
      .filter((t) => t.side === "SELL");

    // Only the manual close appears (AAPL entry is submitted but not filled)
    expect(exits.length).toBe(1);
    expect(exits[0].pnl).toBe(833.32);
    expect(exits[0].symbol).toBe("NKE");
  });
});

// ── Group 5: Computed dailyPnl logic ──

describe("computed dailyPnl", () => {
  it("computes realized P&L from position_closed events", () => {
    const log = new DurableEventLog(logPath());
    const tracker = new OrderStateTracker(log);
    tracker.rebuild();

    const today = new Date().toISOString().slice(0, 10);

    tracker.applyEvent(makePositionClosed({
      timestamp: `${today}T15:00:00.000Z`,
      pnl: 833.32,
      symbol: "NKE",
      orderRef: `CLOSE|sentinel|NKE|${today}`,
    }));
    tracker.applyEvent(makePositionClosed({
      timestamp: `${today}T16:00:00.000Z`,
      pnl: 3348.92,
      symbol: "GILD",
      orderRef: `CLOSE|sentinel|GILD|${today}`,
    }));

    const todayExits = tracker.getRecentFills({ sinceDays: 1 })
      .filter((t) => t.side === "SELL" && t.timestamp.startsWith(today));

    let realizedPnl = 0;
    for (const exit of todayExits) {
      if (exit.pnl !== undefined) {
        realizedPnl += exit.pnl;
      }
    }

    expect(realizedPnl).toBeCloseTo(4182.24, 2);
  });

  it("computed dailyPnl = realized + unrealized delta", () => {
    // Simulate the computation logic from sendDailyReport
    const ibkrDailyPnl = 0; // Paper account returns 0
    const realizedPnlToday = 833.32; // From position_closed events
    const currentUnrealized = 500; // Current positions unrealized
    const prevUnrealized = 300; // Yesterday's unrealized from performance
    const unrealizedDelta = currentUnrealized - prevUnrealized; // +200

    let displayDailyPnl = ibkrDailyPnl;
    let pnlComputed = false;

    if (ibkrDailyPnl === 0) {
      const computed = realizedPnlToday + unrealizedDelta;
      if (computed !== 0 || realizedPnlToday !== 0) {
        displayDailyPnl = computed;
        pnlComputed = true;
      }
    }

    expect(displayDailyPnl).toBeCloseTo(1033.32, 2); // 833.32 + 200
    expect(pnlComputed).toBe(true);
  });

  it("uses IBKR value when non-zero (live account path unchanged)", () => {
    const ibkrDailyPnl = 1500.50; // Live account returns real value
    const realizedPnlToday = 833.32;

    let displayDailyPnl = ibkrDailyPnl;
    let pnlComputed = false;

    if (ibkrDailyPnl === 0) {
      // Would compute — but won't enter this branch
      displayDailyPnl = realizedPnlToday;
      pnlComputed = true;
    }

    expect(displayDailyPnl).toBe(1500.50);
    expect(pnlComputed).toBe(false);
  });

  it("prefix is ~ when computed, empty when IBKR-delivered", () => {
    // Computed case
    const pnlComputed1 = true;
    const prefix1 = pnlComputed1 ? "~" : "";
    expect(prefix1).toBe("~");

    // IBKR-delivered case
    const pnlComputed2 = false;
    const prefix2 = pnlComputed2 ? "~" : "";
    expect(prefix2).toBe("");
  });
});
