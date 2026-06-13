/**
 * order-state-tracker.ts — Order Identity, Durable Event Log, In-Memory Tracker, OrderId Sequencer
 *
 * Etappe 1 of Order Reconciliation (spec-trading-order-reconciliation-v2.md)
 *
 * INVARIANT: orders.jsonl remains read-only Legacy until Etappe 5.
 * All new events go exclusively to orders-v2.jsonl.
 * No code path writes to both files simultaneously.
 */

import {
  openSync,
  writeSync,
  fdatasyncSync,
  closeSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { join, dirname } from "node:path";

// ─── Section 1: Types & Constants ────────────────────────────────────────────

export const ORDER_REF_PREFIX = "OCAGENT";

export type OrderLeg = "entry" | "stop" | "tp" | "fbclose";

const VALID_LEGS: ReadonlySet<string> = new Set<OrderLeg>(["entry", "stop", "tp", "fbclose"]);

export type OrderEventType =
  | "order_submitted"
  | "order_status_changed"
  | "order_filled"
  | "order_cancelled"
  | "order_error"
  | "replacement_intent_started"
  | "replacement_intent_confirmed"
  | "replacement_intent_abandoned"
  | "fallback_intent_started"
  | "fallback_intent_confirmed"
  | "fallback_intent_abandoned";

// ── Interfaces ──

export interface OrderRefComponents {
  account: string;
  tradeIntentId: string;
  conId: number;
  leg: OrderLeg;
  gen: number;
}

export interface OrderEventBase {
  type: OrderEventType;
  timestamp: string;
  orderRef: string;
  orderId?: number;
  permId?: number;
}

export interface OrderSubmittedEvent extends OrderEventBase {
  type: "order_submitted";
  symbol: string;
  conId: number;
  action: "BUY" | "SELL";
  orderType: string;
  quantity: number;
  limitPrice?: number;
  auxPrice?: number;
  tif: string;
  ocaGroup?: string;
  exchange: string;
  currency: string;
}

export interface OrderStatusChangedEvent extends OrderEventBase {
  type: "order_status_changed";
  status: string;
  filled: number;
  remaining: number;
  avgFillPrice: number;
  lastFillPrice?: number;
}

export interface OrderFilledEvent extends OrderEventBase {
  type: "order_filled";
  execId: string;
  execIdBase: string;
  side: string;
  shares: number;
  price: number;
  cumQty: number;
  avgPrice: number;
}

export interface OrderCancelledEvent extends OrderEventBase {
  type: "order_cancelled";
  reason?: string;
}

export interface OrderErrorEvent extends OrderEventBase {
  type: "order_error";
  errorCode: number;
  errorMessage: string;
}

export interface IntentEvent extends OrderEventBase {
  type:
    | "replacement_intent_started"
    | "replacement_intent_confirmed"
    | "replacement_intent_abandoned"
    | "fallback_intent_started"
    | "fallback_intent_confirmed"
    | "fallback_intent_abandoned";
  targetOrderRef?: string;
  reason?: string;
  newGen?: number;
}

export type OrderEvent =
  | OrderSubmittedEvent
  | OrderStatusChangedEvent
  | OrderFilledEvent
  | OrderCancelledEvent
  | OrderErrorEvent
  | IntentEvent;

export interface ExitState {
  stopOrder?: { orderRef: string; status: string };
  tpOrder?: { orderRef: string; status: string };
  qty: number;
  gen: number;
  stopQty?: number;
  tpQty?: number;
}

export interface TrackerTradeRecord {
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  price: number;
  fillPrice?: number;
  timestamp: string;
  status: string;
  tradeIntentId: string;
}

export interface OpenIntent {
  orderRef: string;
  type: OrderEventType;
  timestamp: string;
  targetOrderRef?: string;
  reason?: string;
}

// ─── Section 2: orderRef / OCA Functions ─────────────────────────────────────

/**
 * Build an orderRef string: `OCAGENT|account|tradeIntentId|conId|leg|gen`
 */
export function buildOrderRef(c: OrderRefComponents): string {
  return `${ORDER_REF_PREFIX}|${c.account}|${c.tradeIntentId}|${c.conId}|${c.leg}|${c.gen}`;
}

/**
 * Parse an orderRef string back into components. Returns null if invalid.
 */
export function parseOrderRef(ref: string): OrderRefComponents | null {
  const parts = ref.split("|");
  if (parts.length !== 6) return null;
  if (parts[0] !== ORDER_REF_PREFIX) return null;

  const leg = parts[4];
  if (!VALID_LEGS.has(leg)) return null;

  const gen = Number(parts[5]);
  if (!Number.isInteger(gen) || gen < 0) return null;

  const conId = Number(parts[3]);
  if (!Number.isInteger(conId)) return null;

  return {
    account: parts[1],
    tradeIntentId: parts[2],
    conId,
    leg: leg as OrderLeg,
    gen,
  };
}

/**
 * Check if an orderRef belongs to this system (has OCAGENT| prefix). (I2)
 */
export function isOwnOrderRef(ref: string): boolean {
  return ref.startsWith(ORDER_REF_PREFIX + "|");
}

/**
 * Build a deterministic OCA group name: `OCA|tradeIntentId|gen`
 */
export function buildOcaGroup(tradeIntentId: string, gen: number): string {
  return `OCA|${tradeIntentId}|${gen}`;
}

/**
 * Build a tradeIntentId: `SYMBOL-YYMMDD-nn`
 */
export function buildTradeIntentId(symbol: string, date: Date, seq: number): string {
  const yy = String(date.getFullYear()).slice(2);
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const nn = String(seq).padStart(2, "0");
  return `${symbol}-${yy}${mm}${dd}-${nn}`;
}

/**
 * Extract the base of an execId (everything up to the last dot).
 * Used for correction matching: same base, different suffix = correction replaces original.
 */
export function execIdBase(execId: string): string {
  const lastDot = execId.lastIndexOf(".");
  if (lastDot <= 0) return execId;
  return execId.substring(0, lastDot);
}

// ─── Section 3: DurableEventLog ──────────────────────────────────────────────

/**
 * Path: orders-v2.jsonl (alongside existing orders.jsonl)
 *
 * INVARIANT: orders.jsonl remains read-only Legacy until E5.
 * All new events go exclusively to orders-v2.jsonl.
 * No code path writes to both files simultaneously.
 */

export interface LoadResult {
  events: OrderEvent[];
  corrupted: boolean;
  quarantinedLine: string | null;
}

export class DurableEventLog {
  readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /**
   * Append an event with fsync guarantee:
   * openSync(path, "a") → writeSync(fd, line) → fdatasyncSync(fd) → closeSync(fd)
   * At <100 events/day, one syscall per event is irrelevant.
   */
  appendEvent(event: OrderEvent): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const line = JSON.stringify(event) + "\n";
    const fd = openSync(this.filePath, "a");
    try {
      writeSync(fd, line);
      fdatasyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  /**
   * Load all events from the log file with startup hardening:
   * - 0 corrupt lines → normal
   * - 1 corrupt line AND it's the last line → quarantine to .quarantine + WARN, load good events
   * - >1 corrupt lines → corrupted=true, load events but CRITICAL (trading locked)
   */
  loadEvents(): LoadResult {
    if (!existsSync(this.filePath)) {
      return { events: [], corrupted: false, quarantinedLine: null };
    }

    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch {
      return { events: [], corrupted: false, quarantinedLine: null };
    }

    if (raw.trim() === "") {
      return { events: [], corrupted: false, quarantinedLine: null };
    }

    const lines = raw.split("\n").filter((l) => l.trim() !== "");
    const events: OrderEvent[] = [];
    const corruptIndices: number[] = [];

    for (let i = 0; i < lines.length; i++) {
      try {
        events.push(JSON.parse(lines[i]));
      } catch {
        corruptIndices.push(i);
      }
    }

    if (corruptIndices.length === 0) {
      return { events, corrupted: false, quarantinedLine: null };
    }

    if (corruptIndices.length === 1 && corruptIndices[0] === lines.length - 1) {
      // Single corrupt line at the end — quarantine it
      const quarantinedLine = lines[corruptIndices[0]];
      const quarantinePath = this.filePath + ".quarantine";
      try {
        writeFileSync(quarantinePath, quarantinedLine + "\n", "utf8");
      } catch {
        // Best-effort quarantine write
      }

      // Rewrite file without the corrupt last line.
      // No fsync here: this runs only at startup before any new events are appended,
      // so a crash during rewrite just means the corrupt line survives and will be
      // quarantined again on the next startup. Deliberately accepted trade-off.
      const goodLines = lines.slice(0, -1);
      try {
        writeFileSync(this.filePath, goodLines.map((l) => l + "\n").join(""), "utf8");
      } catch {
        // If rewrite fails, still return the good events
      }

      console.warn(
        `[order-state-tracker] WARN: Quarantined corrupt last line from ${this.filePath}`,
      );
      return { events, corrupted: false, quarantinedLine };
    }

    // >1 corrupt lines → fail-closed
    console.error(
      `[order-state-tracker] CRITICAL: ${corruptIndices.length} corrupt lines in ${this.filePath} — trading locked`,
    );
    return { events, corrupted: true, quarantinedLine: null };
  }
}

// ─── Section 4: OrderStateTracker ────────────────────────────────────────────

const FINAL_STATUSES = new Set(["Filled", "Cancelled", "ApiCancelled"]);

const INTENT_START_TYPES = new Set<OrderEventType>([
  "replacement_intent_started",
  "fallback_intent_started",
]);

const INTENT_END_TYPES = new Set<OrderEventType>([
  "replacement_intent_confirmed",
  "replacement_intent_abandoned",
  "fallback_intent_confirmed",
  "fallback_intent_abandoned",
]);

function isIntentResolution(type: OrderEventType): boolean {
  return INTENT_END_TYPES.has(type);
}

export class OrderStateTracker {
  private log: DurableEventLog;
  private _tradingLocked = false;

  // Internal indices
  private statusDedupeSet = new Set<string>();
  private fillsByExecBase = new Map<string, OrderFilledEvent>();
  private seenExecIds = new Set<string>();
  private eventsByOrderRef = new Map<string, OrderEvent[]>();
  private orderRefsByConId = new Map<number, Set<string>>();
  private _openIntents = new Map<string, IntentEvent>();

  // For tracking errors per orderRef
  private errorsByRef = new Map<string, OrderErrorEvent[]>();
  private errorDedupeSet = new Set<string>();

  // For tracking latest status per orderRef
  private latestStatusByRef = new Map<string, string>();
  // For tracking cumQty per orderRef from fills
  private fillCumQtyByRef = new Map<string, number>();
  // For tracking submitted quantity per orderRef (from order_submitted events)
  private submittedQtyByRef = new Map<string, number>();

  constructor(log: DurableEventLog) {
    this.log = log;
  }

  /**
   * Rebuild in-memory state from the durable event log.
   * Returns flags about the log state.
   */
  rebuild(): { tradingLocked: boolean; openIntents: OpenIntent[]; quarantinedLine: string | null } {
    // Clear all indices
    this.statusDedupeSet.clear();
    this.fillsByExecBase.clear();
    this.seenExecIds.clear();
    this.eventsByOrderRef.clear();
    this.orderRefsByConId.clear();
    this._openIntents.clear();
    this.errorsByRef.clear();
    this.errorDedupeSet.clear();
    this.latestStatusByRef.clear();
    this.fillCumQtyByRef.clear();
    this.submittedQtyByRef.clear();
    this._tradingLocked = false;

    const { events, corrupted, quarantinedLine } = this.log.loadEvents();

    if (corrupted) {
      this._tradingLocked = true;
    }

    // Project all events into memory
    for (const event of events) {
      this.projectEvent(event);
    }

    return {
      tradingLocked: this._tradingLocked,
      openIntents: this.getOpenIntents(),
      quarantinedLine,
    };
  }

  /**
   * Apply a new event: persist first (crash-safe), then project into memory.
   * Returns false if the event was deduplicated (already seen).
   * Throws if tradingLocked and event is not an intent resolution.
   */
  applyEvent(event: OrderEvent): boolean {
    if (this._tradingLocked && !isIntentResolution(event.type)) {
      throw new Error(
        `Trading locked (corrupted log) — cannot apply event type=${event.type} orderRef=${event.orderRef}`,
      );
    }

    // Dedupe check before persisting
    if (this.isDuplicate(event)) {
      return false;
    }

    // Persist first (crash-safe)
    this.log.appendEvent(event);

    // Then project into memory
    this.projectEvent(event);

    return true;
  }

  /**
   * Get the exit state for a position identified by conId.
   * Returns stop/tp orders from the highest generation that are not in a final status.
   */
  getExitState(conId: number): ExitState | null {
    const refs = this.orderRefsByConId.get(conId);
    if (!refs || refs.size === 0) return null;

    // Find max generation
    let maxGen = -1;
    for (const ref of refs) {
      const parsed = parseOrderRef(ref);
      if (parsed) {
        maxGen = Math.max(maxGen, parsed.gen);
      }
    }

    if (maxGen < 0) return null;

    let stopOrder: { orderRef: string; status: string } | undefined;
    let tpOrder: { orderRef: string; status: string } | undefined;
    // Derive qty from order_submitted.quantity of the stop/tp legs of maxGen,
    // not from entry cumQty — because at gen>0 (replacements) there is no
    // new entry order, only replacement exit legs with their own submitted qty.
    let stopQty: number | undefined;
    let tpQty: number | undefined;

    for (const ref of refs) {
      const parsed = parseOrderRef(ref);
      if (!parsed || parsed.gen !== maxGen) continue;

      const status = this.latestStatusByRef.get(ref) ?? "unknown";
      const isFinal = FINAL_STATUSES.has(status);

      if (parsed.leg === "stop" && !isFinal) {
        stopOrder = { orderRef: ref, status };
        stopQty = this.submittedQtyByRef.get(ref);
      } else if (parsed.leg === "tp" && !isFinal) {
        tpOrder = { orderRef: ref, status };
        tpQty = this.submittedQtyByRef.get(ref);
      }
    }

    // If both stop and tp exist with differing quantities, signal mismatch.
    // qty = -1 means the Guardian (Etappe 4) must treat this as qty_mismatch
    // and re-place both legs with consistent quantity.
    let qty: number;
    if (stopQty !== undefined && tpQty !== undefined && stopQty !== tpQty) {
      qty = -1;
    } else {
      qty = stopQty ?? tpQty ?? 0;
    }

    return { stopOrder, tpOrder, qty, gen: maxGen, stopQty, tpQty };
  }

  /**
   * Scan all known orderRefs, parse tradeIntentId, filter by symbol+date,
   * return the highest seq number. Default: 0.
   */
  getMaxTradeIntentSeq(symbol: string, date: Date): number {
    const yy = String(date.getFullYear()).slice(2);
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");
    const prefix = `${symbol}-${yy}${mm}${dd}-`;
    let maxSeq = 0;
    for (const refs of this.orderRefsByConId.values()) {
      for (const ref of refs) {
        const parsed = parseOrderRef(ref);
        if (!parsed) continue;
        const tid = parsed.tradeIntentId;
        if (tid.startsWith(prefix)) {
          const seqStr = tid.slice(prefix.length);
          const seq = Number(seqStr);
          if (Number.isInteger(seq) && seq > maxSeq) maxSeq = seq;
        }
      }
    }
    return maxSeq;
  }

  /**
   * Get all open intents (started but not confirmed/abandoned).
   */
  getOpenIntents(): OpenIntent[] {
    const intents: OpenIntent[] = [];
    for (const intent of this._openIntents.values()) {
      intents.push({
        orderRef: intent.orderRef,
        type: intent.type,
        timestamp: intent.timestamp,
        targetOrderRef: intent.targetOrderRef,
        reason: intent.reason,
      });
    }
    return intents;
  }

  /**
   * Get all events for a specific orderRef.
   */
  getEventsForOrder(orderRef: string): OrderEvent[] {
    return this.eventsByOrderRef.get(orderRef) ?? [];
  }

  /**
   * Check if any errors have been recorded for an orderRef.
   */
  hasError(orderRef: string): boolean {
    const errors = this.errorsByRef.get(orderRef);
    return !!errors && errors.length > 0;
  }

  /**
   * Get the latest known status for an orderRef (read-only access to latestStatusByRef).
   */
  getLatestStatus(orderRef: string): string | undefined {
    return this.latestStatusByRef.get(orderRef);
  }

  /**
   * Get all known orderRefs for a conId (for price extraction and tradeIntentId lookup).
   */
  getOrderRefsForConId(conId: number): Set<string> {
    return this.orderRefsByConId.get(conId) ?? new Set();
  }

  /**
   * Get the order_submitted event for an orderRef (for auxPrice/limitPrice extraction).
   */
  getSubmittedEvent(orderRef: string): OrderSubmittedEvent | null {
    const events = this.eventsByOrderRef.get(orderRef);
    if (!events) return null;
    for (const ev of events) {
      if (ev.type === "order_submitted") return ev as OrderSubmittedEvent;
    }
    return null;
  }

  /**
   * Get recent filled trades from the tracker log.
   * Filters by leg type, symbol, and time window.
   */
  getRecentFills(options?: { symbol?: string; sinceDays?: number; leg?: OrderLeg }): TrackerTradeRecord[] {
    const results: TrackerTradeRecord[] = [];
    const cutoff = options?.sinceDays
      ? new Date(Date.now() - options.sinceDays * 24 * 60 * 60 * 1000).toISOString()
      : undefined;

    for (const refs of this.orderRefsByConId.values()) {
      for (const ref of refs) {
        const parsed = parseOrderRef(ref);
        if (!parsed) continue;
        if (options?.leg && parsed.leg !== options.leg) continue;

        const submitted = this.getSubmittedEvent(ref);
        if (!submitted) continue;
        if (options?.symbol && submitted.symbol !== options.symbol) continue;
        if (cutoff && submitted.timestamp < cutoff) continue;

        // Check if filled
        const status = this.latestStatusByRef.get(ref) ?? "unknown";
        const events = this.eventsByOrderRef.get(ref) ?? [];

        // Find fill price from status_changed events
        let fillPrice: number | undefined;
        for (const ev of events) {
          if (ev.type === "order_status_changed") {
            const sc = ev as OrderStatusChangedEvent;
            if (sc.avgFillPrice > 0) fillPrice = sc.avgFillPrice;
          }
          if (ev.type === "order_filled") {
            const fe = ev as OrderFilledEvent;
            if (fe.avgPrice > 0) fillPrice = fe.avgPrice;
          }
        }

        // Only include if at least partially filled
        const cumQty = this.fillCumQtyByRef.get(ref);
        if (!fillPrice && (!cumQty || cumQty <= 0) && status !== "Filled") continue;

        results.push({
          symbol: submitted.symbol,
          side: submitted.action,
          quantity: submitted.quantity,
          price: submitted.limitPrice ?? submitted.auxPrice ?? 0,
          fillPrice,
          timestamp: submitted.timestamp,
          status,
          tradeIntentId: parsed.tradeIntentId,
        });
      }
    }

    // Sort by timestamp descending
    results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    return results;
  }

  get tradingLocked(): boolean {
    return this._tradingLocked;
  }

  // ── Private ──

  /**
   * Check if an event is a duplicate based on its type-specific dedupe key.
   */
  private isDuplicate(event: OrderEvent): boolean {
    if (event.type === "order_status_changed") {
      const e = event as OrderStatusChangedEvent;
      const key = `${e.orderRef}|${e.status}|${e.filled}|${e.remaining}|${e.avgFillPrice}`;
      return this.statusDedupeSet.has(key);
    }

    if (event.type === "order_filled") {
      const e = event as OrderFilledEvent;
      return this.seenExecIds.has(e.execId);
    }

    if (event.type === "order_error") {
      const e = event as OrderErrorEvent;
      const key = `${e.orderRef}|${e.errorCode}|${e.errorMessage}`;
      return this.errorDedupeSet.has(key);
    }

    return false;
  }

  /**
   * Project a single event into the in-memory indices.
   */
  private projectEvent(event: OrderEvent): void {
    // Index by orderRef
    let events = this.eventsByOrderRef.get(event.orderRef);
    if (!events) {
      events = [];
      this.eventsByOrderRef.set(event.orderRef, events);
    }
    events.push(event);

    // Index orderRef by conId (for getExitState lookup)
    if (event.type === "order_submitted") {
      const e = event as OrderSubmittedEvent;
      let conIdRefs = this.orderRefsByConId.get(e.conId);
      if (!conIdRefs) {
        conIdRefs = new Set();
        this.orderRefsByConId.set(e.conId, conIdRefs);
      }
      conIdRefs.add(e.orderRef);
    }

    // Type-specific projection
    switch (event.type) {
      case "order_submitted": {
        const e = event as OrderSubmittedEvent;
        // Set initial status
        this.latestStatusByRef.set(e.orderRef, "Submitted");
        this.submittedQtyByRef.set(e.orderRef, e.quantity);
        break;
      }

      case "order_status_changed": {
        const e = event as OrderStatusChangedEvent;
        const key = `${e.orderRef}|${e.status}|${e.filled}|${e.remaining}|${e.avgFillPrice}`;
        this.statusDedupeSet.add(key);
        this.latestStatusByRef.set(e.orderRef, e.status);
        break;
      }

      case "order_filled": {
        const e = event as OrderFilledEvent;
        const base = e.execIdBase;

        // Correction: same base, different suffix replaces original
        if (this.fillsByExecBase.has(base)) {
          // Replace existing fill with correction
          const oldFill = this.fillsByExecBase.get(base)!;
          this.seenExecIds.delete(oldFill.execId);
        }

        this.fillsByExecBase.set(base, e);
        this.seenExecIds.add(e.execId);
        this.fillCumQtyByRef.set(e.orderRef, e.cumQty);
        break;
      }

      case "order_cancelled": {
        const e = event as OrderCancelledEvent;
        this.latestStatusByRef.set(e.orderRef, "Cancelled");
        break;
      }

      case "order_error": {
        const e = event as OrderErrorEvent;
        const key = `${e.orderRef}|${e.errorCode}|${e.errorMessage}`;
        this.errorDedupeSet.add(key);
        let errors = this.errorsByRef.get(e.orderRef);
        if (!errors) {
          errors = [];
          this.errorsByRef.set(e.orderRef, errors);
        }
        errors.push(e);
        break;
      }

      default: {
        // Intent events
        if (INTENT_START_TYPES.has(event.type)) {
          this._openIntents.set(event.orderRef, event as IntentEvent);
        } else if (INTENT_END_TYPES.has(event.type)) {
          this._openIntents.delete(event.orderRef);
        }
        break;
      }
    }
  }
}

// ─── Section 5: OrderIdSequencer ─────────────────────────────────────────────

/**
 * Manages orderId allocation ensuring next() always returns
 * max(nextValidId, highestSeen + 1).
 */
export class OrderIdSequencer {
  private _nextValidId = 0;
  private _highestSeen = 0;

  /**
   * Called when IBKR sends nextValidId event.
   */
  setNextValidId(id: number): void {
    this._nextValidId = id;
  }

  /**
   * Track a seen orderId from orderStatus/openOrder events.
   */
  trackSeenId(id: number): void {
    if (id > this._highestSeen) {
      this._highestSeen = id;
    }
  }

  /**
   * Arm the sequencer after log rebuild with the highest known orderId.
   */
  arm(highestKnownId: number): void {
    if (highestKnownId > this._highestSeen) {
      this._highestSeen = highestKnownId;
    }
  }

  /**
   * Allocate the next orderId.
   * Returns max(nextValidId, highestSeen + 1) and advances the counter.
   */
  next(): number {
    const id = Math.max(this._nextValidId, this._highestSeen + 1);
    // Advance both counters past the allocated id
    this._nextValidId = id + 1;
    this._highestSeen = id;
    return id;
  }

  /**
   * Non-consuming peek at the next orderId that would be allocated.
   */
  peek(): number {
    return Math.max(this._nextValidId, this._highestSeen + 1);
  }
}
