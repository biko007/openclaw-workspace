/**
 * Position Classifier (Etappe 3b)
 *
 * Pure function: takes a SyncSnapshot + OrderStateTracker, returns per-position
 * classification. No I/O, no side effects — easy to test.
 */

import type { SyncSnapshot, SyncOpenOrder, SyncPosition } from "./ibkr.js";
import type { OrderStateTracker } from "./order-state-tracker.js";
import { parseOrderRef, isOwnOrderRef } from "./order-state-tracker.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export type PositionState =
  | "protected"
  | "missing_stop"
  | "missing_tp"
  | "missing_both"
  | "qty_mismatch"
  | "oca_broken"
  | "unreconstructable"
  | "foreign_involved";

export interface ClassifiedPosition {
  symbol: string;
  conId: number;
  exchange: string;
  currency: string;
  positionQty: number;
  state: PositionState;
  details: string;
  stopOrderRef?: string;
  tpOrderRef?: string;
  gen?: number;
}

export interface OrphanOrder {
  orderId: number;
  orderRef: string;
  symbol: string;
  conId: number;
  reason: string;
}

export interface LegacyOwnOrder {
  orderId: number;
  symbol: string;
  conId: number;
  orderType: string;
  totalQuantity: number;
  clientId: number;
}

export interface ClassificationResult {
  positions: ClassifiedPosition[];
  orphans: OrphanOrder[];
  legacyOwn: LegacyOwnOrder[];
  stateCount: Record<string, number>;
  foreignCount: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_LEGACY_CLIENT_IDS = [1, 98];
const FINAL_STATUSES = new Set(["Filled", "Cancelled", "ApiCancelled"]);

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * I6: GTC + Inactive = still active (normal outside RTH). Only truly missing
 * if status is Cancelled/ApiCancelled/Filled.
 */
function isActiveStatus(status: string): boolean {
  return !FINAL_STATUSES.has(status);
}

/**
 * Check if stop and tp are in the same OCA group by looking them up in the
 * snapshot's order index.
 */
function checkOcaConsistency(
  stopRef: string,
  tpRef: string,
  orderIndex: Map<string, SyncOpenOrder>,
): boolean {
  const stopOrder = orderIndex.get(stopRef);
  const tpOrder = orderIndex.get(tpRef);
  if (!stopOrder || !tpOrder) return true; // Can't check — assume ok
  if (!stopOrder.ocaGroup && !tpOrder.ocaGroup) return true; // No OCA at all
  return stopOrder.ocaGroup === tpOrder.ocaGroup;
}

/**
 * Derive protection state from legacy orders for a position.
 * Returns the classified state based on which order types are present.
 */
function classifyFromLegacy(
  legacyOrders: LegacyOwnOrder[],
  posQty: number,
): { state: PositionState; details: string } {
  const hasStop = legacyOrders.some((o) => o.orderType === "STP" || o.orderType === "STP LMT");
  const hasTp = legacyOrders.some((o) => o.orderType === "LMT" || o.orderType === "TRAIL");

  if (hasStop && hasTp) {
    return { state: "protected", details: "legacy STP+TP active" };
  } else if (hasStop && !hasTp) {
    return { state: "missing_tp", details: "legacy STP only, no TP" };
  } else if (!hasStop && hasTp) {
    return { state: "missing_stop", details: "legacy TP only, no STP" };
  }
  return { state: "missing_both", details: "legacy orders present but no STP/TP identified" };
}

// ─── Main Function ───────────────────────────────────────────────────────────

export function classifyPositions(
  snapshot: SyncSnapshot,
  tracker: OrderStateTracker,
  account: string,
  opts?: { legacyClientIds?: number[] },
): ClassificationResult {
  const legacyClientIds = new Set(opts?.legacyClientIds ?? DEFAULT_LEGACY_CLIENT_IDS);

  const positions: ClassifiedPosition[] = [];
  const orphans: OrphanOrder[] = [];
  const legacyOwn: LegacyOwnOrder[] = [];
  const stateCount: Record<string, number> = {};

  // ── Step 1: Separate legacy-own from truly foreign ──

  const legacyByConId = new Map<number, LegacyOwnOrder[]>();
  const trulyForeign: SyncOpenOrder[] = [];

  for (const order of snapshot.foreignOrders) {
    if (order.clientId !== undefined && legacyClientIds.has(order.clientId)) {
      const lo: LegacyOwnOrder = {
        orderId: order.orderId,
        symbol: order.symbol,
        conId: order.conId,
        orderType: order.orderType,
        totalQuantity: order.totalQuantity,
        clientId: order.clientId,
      };
      legacyOwn.push(lo);
      let arr = legacyByConId.get(order.conId);
      if (!arr) {
        arr = [];
        legacyByConId.set(order.conId, arr);
      }
      arr.push(lo);
    } else {
      trulyForeign.push(order);
    }
  }

  // ── Step 2: Build indexes ──

  // Position conIds for orphan detection
  const positionConIds = new Set<number>();
  for (const pos of snapshot.positions) {
    positionConIds.add(pos.conId);
  }

  // Order index by orderRef (for OCA consistency check)
  const orderByRef = new Map<string, SyncOpenOrder>();
  for (const order of snapshot.ownOrders) {
    if (order.orderRef) orderByRef.set(order.orderRef, order);
  }

  // Foreign orders by conId (truly foreign only)
  const foreignByConId = new Map<number, SyncOpenOrder[]>();
  for (const order of trulyForeign) {
    let arr = foreignByConId.get(order.conId);
    if (!arr) {
      arr = [];
      foreignByConId.set(order.conId, arr);
    }
    arr.push(order);
  }

  // Open intents indexed by conId
  const openIntentConIds = new Set<number>();
  for (const intent of tracker.getOpenIntents()) {
    const parsed = parseOrderRef(intent.orderRef);
    if (parsed) openIntentConIds.add(parsed.conId);
  }

  // ── Step 3: Classify each position ──

  for (const pos of snapshot.positions) {
    // I1: short positions — log CRITICAL, skip classification
    if (pos.quantity < 0) {
      console.error(
        `[reconcile] CRITICAL: unexpected_short_detected ${pos.symbol} conId=${pos.conId} qty=${pos.quantity}`,
      );
      continue;
    }

    let state: PositionState;
    let details: string;
    let stopOrderRef: string | undefined;
    let tpOrderRef: string | undefined;
    let gen: number | undefined;

    const exitState = tracker.getExitState(pos.conId);

    if (exitState === null) {
      // Tracker has no active exit orders for this conId
      const legacy = legacyByConId.get(pos.conId);
      if (legacy && legacy.length > 0) {
        // Legacy-own orders provide protection
        const result = classifyFromLegacy(legacy, pos.quantity);
        state = result.state;
        details = result.details;
      } else if (openIntentConIds.has(pos.conId)) {
        state = "missing_both";
        details = "open intent exists but no active exit orders";
      } else {
        state = "unreconstructable";
        details = "no exit orders, no legacy, no intent in log";
      }
    } else {
      gen = exitState.gen;

      // qty mismatch signal from tracker
      if (exitState.qty === -1) {
        state = "qty_mismatch";
        details = "STP and TP have different quantities";
        stopOrderRef = exitState.stopOrder?.orderRef;
        tpOrderRef = exitState.tpOrder?.orderRef;
      } else if (exitState.stopOrder && exitState.tpOrder) {
        // Both legs present
        stopOrderRef = exitState.stopOrder.orderRef;
        tpOrderRef = exitState.tpOrder.orderRef;

        // I6: check statuses are active
        const stopActive = isActiveStatus(exitState.stopOrder.status);
        const tpActive = isActiveStatus(exitState.tpOrder.status);

        if (!stopActive && !tpActive) {
          state = "missing_both";
          details = `both in final status (stop=${exitState.stopOrder.status}, tp=${exitState.tpOrder.status})`;
        } else if (!stopActive) {
          state = "missing_stop";
          details = `stop in final status (${exitState.stopOrder.status})`;
        } else if (!tpActive) {
          state = "missing_tp";
          details = `tp in final status (${exitState.tpOrder.status})`;
        } else {
          // Both active — check OCA consistency
          const ocaOk = checkOcaConsistency(stopOrderRef, tpOrderRef, orderByRef);
          if (!ocaOk) {
            state = "oca_broken";
            details = "stop and tp in different OCA groups";
          } else if (exitState.qty !== Math.abs(pos.quantity)) {
            state = "qty_mismatch";
            details = `exit qty=${exitState.qty} != position qty=${Math.abs(pos.quantity)}`;
          } else {
            state = "protected";
            details = "STP+TP active, qty match, OCA consistent";
          }
        }
      } else if (exitState.stopOrder) {
        stopOrderRef = exitState.stopOrder.orderRef;
        if (isActiveStatus(exitState.stopOrder.status)) {
          state = "missing_tp";
          details = "STP active, no TP";
        } else {
          state = "missing_both";
          details = `STP in final status (${exitState.stopOrder.status}), no TP`;
        }
      } else if (exitState.tpOrder) {
        tpOrderRef = exitState.tpOrder.orderRef;
        if (isActiveStatus(exitState.tpOrder.status)) {
          state = "missing_stop";
          details = "TP active, no STP";
        } else {
          state = "missing_both";
          details = `TP in final status (${exitState.tpOrder.status}), no STP`;
        }
      } else {
        // exitState exists but no orders (all filtered as final)
        state = "missing_both";
        details = "tracker has history but no active exit orders";
      }
    }

    // Foreign override: truly foreign orders on this conId → foreign_involved
    if (state !== "protected" && foreignByConId.has(pos.conId)) {
      state = "foreign_involved";
      details = "non-legacy foreign orders present on this conId";
    }

    positions.push({
      symbol: pos.symbol,
      conId: pos.conId,
      exchange: pos.exchange,
      currency: pos.currency,
      positionQty: pos.quantity,
      state,
      details,
      stopOrderRef,
      tpOrderRef,
      gen,
    });

    stateCount[state] = (stateCount[state] ?? 0) + 1;
  }

  // ── Step 4: Orphan detection (own orders without matching position) ──

  for (const order of snapshot.ownOrders) {
    if (FINAL_STATUSES.has(order.status)) continue;
    if (!positionConIds.has(order.conId)) {
      orphans.push({
        orderId: order.orderId,
        orderRef: order.orderRef,
        symbol: order.symbol,
        conId: order.conId,
        reason: "no_matching_position",
      });
    }
  }

  return {
    positions,
    orphans,
    legacyOwn,
    stateCount,
    foreignCount: trulyForeign.length,
  };
}
