import { describe, it, expect } from "vitest";
import {
  classifyPositions,
  type ClassificationResult,
  type PositionState,
} from "../src/position-classifier.js";
import type { SyncSnapshot, SyncOpenOrder, SyncPosition } from "../src/ibkr.js";
import type { ExitState, OpenIntent } from "../src/order-state-tracker.js";
import { buildOrderRef, buildOcaGroup } from "../src/order-state-tracker.js";

// ── Stub Tracker ──

class StubTracker {
  private exitStates = new Map<number, ExitState | null>();
  private _openIntents: OpenIntent[] = [];

  setExitState(conId: number, state: ExitState | null): void {
    this.exitStates.set(conId, state);
  }

  setOpenIntents(intents: OpenIntent[]): void {
    this._openIntents = intents;
  }

  getExitState(conId: number): ExitState | null {
    return this.exitStates.get(conId) ?? null;
  }

  getOpenIntents(): OpenIntent[] {
    return this._openIntents;
  }
}

// ── Factories ──

const ACCOUNT = "DUP514636";

function makePosition(overrides: Partial<SyncPosition> = {}): SyncPosition {
  return {
    symbol: "AAPL",
    conId: 265598,
    exchange: "SMART",
    currency: "USD",
    quantity: 100,
    avgCost: 150.0,
    ...overrides,
  };
}

function makeOrder(overrides: Partial<SyncOpenOrder> = {}): SyncOpenOrder {
  return {
    orderId: 1,
    permId: 1001,
    clientId: 1,
    symbol: "AAPL",
    conId: 265598,
    action: "SELL",
    orderType: "STP",
    totalQuantity: 100,
    tif: "GTC",
    ocaGroup: "",
    status: "Submitted",
    parentId: 0,
    orderRef: "",
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<SyncSnapshot> = {}): SyncSnapshot {
  return {
    timestamp: new Date().toISOString(),
    ownOrders: [],
    foreignOrders: [],
    positions: [],
    backfilledExecutions: [],
    completedOrders: [],
    isReconnect: false,
    timedOutPhases: [],
    ...overrides,
  } as SyncSnapshot;
}

const tradeId = "AAPL-260612-01";
const stopRef = buildOrderRef({ account: ACCOUNT, tradeIntentId: tradeId, conId: 265598, leg: "stop", gen: 0 });
const tpRef = buildOrderRef({ account: ACCOUNT, tradeIntentId: tradeId, conId: 265598, leg: "tp", gen: 0 });
const ocaGroup = buildOcaGroup(tradeId, 0);

// ── Tests ──

describe("Position Classifier (E3b)", () => {
  it("1. protected — STP+TP active, qty match, same OCA", () => {
    const tracker = new StubTracker();
    tracker.setExitState(265598, {
      stopOrder: { orderRef: stopRef, status: "Submitted" },
      tpOrder: { orderRef: tpRef, status: "Submitted" },
      qty: 100,
      gen: 0,
    });

    const snapshot = makeSnapshot({
      positions: [makePosition()],
      ownOrders: [
        makeOrder({ orderId: 10, orderRef: stopRef, orderType: "STP", ocaGroup }),
        makeOrder({ orderId: 11, orderRef: tpRef, orderType: "LMT", ocaGroup }),
      ],
    });

    const result = classifyPositions(snapshot, tracker as any, ACCOUNT);
    expect(result.positions).toHaveLength(1);
    expect(result.positions[0].state).toBe("protected");
    expect(result.stateCount["protected"]).toBe(1);
  });

  it("2. missing_stop — TP active, no STP", () => {
    const tracker = new StubTracker();
    tracker.setExitState(265598, {
      tpOrder: { orderRef: tpRef, status: "Submitted" },
      qty: 100,
      gen: 0,
    });

    const snapshot = makeSnapshot({
      positions: [makePosition()],
      ownOrders: [makeOrder({ orderId: 11, orderRef: tpRef, orderType: "LMT" })],
    });

    const result = classifyPositions(snapshot, tracker as any, ACCOUNT);
    expect(result.positions[0].state).toBe("missing_stop");
  });

  it("3. missing_tp — STP active, no TP", () => {
    const tracker = new StubTracker();
    tracker.setExitState(265598, {
      stopOrder: { orderRef: stopRef, status: "Submitted" },
      qty: 100,
      gen: 0,
    });

    const snapshot = makeSnapshot({
      positions: [makePosition()],
      ownOrders: [makeOrder({ orderId: 10, orderRef: stopRef, orderType: "STP" })],
    });

    const result = classifyPositions(snapshot, tracker as any, ACCOUNT);
    expect(result.positions[0].state).toBe("missing_tp");
  });

  it("4. missing_both — no exit orders but open intent exists", () => {
    const tracker = new StubTracker();
    // No exit state but has an open intent
    tracker.setOpenIntents([
      {
        orderRef: stopRef,
        type: "replacement_intent_started",
        timestamp: new Date().toISOString(),
      },
    ]);

    const snapshot = makeSnapshot({
      positions: [makePosition()],
    });

    const result = classifyPositions(snapshot, tracker as any, ACCOUNT);
    expect(result.positions[0].state).toBe("missing_both");
    expect(result.positions[0].details).toContain("intent");
  });

  it("5. qty_mismatch — STP and TP have different quantities (tracker signal)", () => {
    const tracker = new StubTracker();
    tracker.setExitState(265598, {
      stopOrder: { orderRef: stopRef, status: "Submitted" },
      tpOrder: { orderRef: tpRef, status: "Submitted" },
      qty: -1, // Signal: mismatch
      gen: 0,
    });

    const snapshot = makeSnapshot({
      positions: [makePosition()],
      ownOrders: [
        makeOrder({ orderId: 10, orderRef: stopRef, orderType: "STP", ocaGroup }),
        makeOrder({ orderId: 11, orderRef: tpRef, orderType: "LMT", ocaGroup }),
      ],
    });

    const result = classifyPositions(snapshot, tracker as any, ACCOUNT);
    expect(result.positions[0].state).toBe("qty_mismatch");
  });

  it("6. qty_mismatch — exit qty != position qty", () => {
    const tracker = new StubTracker();
    tracker.setExitState(265598, {
      stopOrder: { orderRef: stopRef, status: "Submitted" },
      tpOrder: { orderRef: tpRef, status: "Submitted" },
      qty: 50, // Position has 100
      gen: 0,
    });

    const snapshot = makeSnapshot({
      positions: [makePosition({ quantity: 100 })],
      ownOrders: [
        makeOrder({ orderId: 10, orderRef: stopRef, orderType: "STP", ocaGroup }),
        makeOrder({ orderId: 11, orderRef: tpRef, orderType: "LMT", ocaGroup }),
      ],
    });

    const result = classifyPositions(snapshot, tracker as any, ACCOUNT);
    expect(result.positions[0].state).toBe("qty_mismatch");
  });

  it("7. oca_broken — stop and tp in different OCA groups", () => {
    const tracker = new StubTracker();
    tracker.setExitState(265598, {
      stopOrder: { orderRef: stopRef, status: "Submitted" },
      tpOrder: { orderRef: tpRef, status: "Submitted" },
      qty: 100,
      gen: 0,
    });

    const snapshot = makeSnapshot({
      positions: [makePosition()],
      ownOrders: [
        makeOrder({ orderId: 10, orderRef: stopRef, orderType: "STP", ocaGroup: "OCA|AAPL-260612-01|0" }),
        makeOrder({ orderId: 11, orderRef: tpRef, orderType: "LMT", ocaGroup: "OCA|AAPL-260612-01|1" }), // Different gen!
      ],
    });

    const result = classifyPositions(snapshot, tracker as any, ACCOUNT);
    expect(result.positions[0].state).toBe("oca_broken");
  });

  it("8. unreconstructable — no exit orders, no legacy, no intent", () => {
    const tracker = new StubTracker();
    // Nothing: no exit state, no intents, no legacy

    const snapshot = makeSnapshot({
      positions: [makePosition()],
    });

    const result = classifyPositions(snapshot, tracker as any, ACCOUNT);
    expect(result.positions[0].state).toBe("unreconstructable");
  });

  it("9. GTC-Inactive counts as active (I6) → protected", () => {
    const tracker = new StubTracker();
    tracker.setExitState(265598, {
      stopOrder: { orderRef: stopRef, status: "Inactive" }, // GTC outside RTH
      tpOrder: { orderRef: tpRef, status: "Submitted" },
      qty: 100,
      gen: 0,
    });

    const snapshot = makeSnapshot({
      positions: [makePosition()],
      ownOrders: [
        makeOrder({ orderId: 10, orderRef: stopRef, orderType: "STP", ocaGroup, status: "Inactive" }),
        makeOrder({ orderId: 11, orderRef: tpRef, orderType: "LMT", ocaGroup, status: "Submitted" }),
      ],
    });

    const result = classifyPositions(snapshot, tracker as any, ACCOUNT);
    expect(result.positions[0].state).toBe("protected");
  });

  it("10. foreign_involved — non-legacy foreign order on position conId", () => {
    const tracker = new StubTracker();
    // No exit state from tracker

    const snapshot = makeSnapshot({
      positions: [makePosition()],
      foreignOrders: [
        makeOrder({
          orderId: 99,
          clientId: 42, // NOT a legacy clientId
          orderRef: "",
          conId: 265598,
        }),
      ],
    });

    const result = classifyPositions(snapshot, tracker as any, ACCOUNT);
    expect(result.positions[0].state).toBe("foreign_involved");
  });

  it("11. legacy_own (clientId 1) STP+TP → protected", () => {
    const tracker = new StubTracker();
    // No exit state in tracker — only legacy orders exist

    const snapshot = makeSnapshot({
      positions: [makePosition({ symbol: "ZTS", conId: 12087 })],
      foreignOrders: [
        makeOrder({
          orderId: 3,
          clientId: 1,
          symbol: "ZTS",
          conId: 12087,
          orderRef: "",
          orderType: "STP",
          totalQuantity: 100,
        }),
        makeOrder({
          orderId: 4,
          clientId: 1,
          symbol: "ZTS",
          conId: 12087,
          orderRef: "",
          orderType: "LMT",
          totalQuantity: 100,
        }),
      ],
    });

    const result = classifyPositions(snapshot, tracker as any, ACCOUNT);
    expect(result.positions[0].state).toBe("protected");
    expect(result.positions[0].details).toContain("legacy");
    expect(result.legacyOwn).toHaveLength(2);
    expect(result.foreignCount).toBe(0);
  });

  it("12. legacy_own only STP, no TP → missing_tp", () => {
    const tracker = new StubTracker();

    const snapshot = makeSnapshot({
      positions: [makePosition({ symbol: "ZTS", conId: 12087 })],
      foreignOrders: [
        makeOrder({
          orderId: 3,
          clientId: 98,
          symbol: "ZTS",
          conId: 12087,
          orderRef: "",
          orderType: "STP",
          totalQuantity: 100,
        }),
      ],
    });

    const result = classifyPositions(snapshot, tracker as any, ACCOUNT);
    expect(result.positions[0].state).toBe("missing_tp");
    expect(result.legacyOwn).toHaveLength(1);
  });

  it("13. orphan — own order without matching position", () => {
    const tracker = new StubTracker();

    const orphanRef = buildOrderRef({
      account: ACCOUNT,
      tradeIntentId: "MSFT-260612-01",
      conId: 272093,
      leg: "stop",
      gen: 0,
    });

    const snapshot = makeSnapshot({
      positions: [makePosition()], // AAPL conId=265598
      ownOrders: [
        makeOrder({ orderId: 50, orderRef: orphanRef, conId: 272093, symbol: "MSFT" }),
      ],
    });

    // AAPL position with no tracker state → unreconstructable
    const result = classifyPositions(snapshot, tracker as any, ACCOUNT);
    expect(result.orphans).toHaveLength(1);
    expect(result.orphans[0].conId).toBe(272093);
    expect(result.orphans[0].symbol).toBe("MSFT");
  });

  it("14. short position → CRITICAL, skipped from classification", () => {
    const tracker = new StubTracker();

    const snapshot = makeSnapshot({
      positions: [makePosition({ quantity: -50 })],
    });

    const result = classifyPositions(snapshot, tracker as any, ACCOUNT);
    // Short position is skipped — not included in classified positions
    expect(result.positions).toHaveLength(0);
  });
});
