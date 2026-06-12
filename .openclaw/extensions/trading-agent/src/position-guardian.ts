/**
 * Position Guardian State Machine (Etappe 4)
 *
 * Consumes ClassificationResult from E3b and restores protection:
 * missing legs replaced, qty/OCA repaired, fallback-close as last resort.
 * Legacy orders (clientId 1/98) are strictly READ-ONLY — only alert, no cancel, no placement.
 */

import type { IBKRConnection, SyncSnapshot } from "./ibkr.js";
import type { OrderStateTracker, OpenIntent, OrderSubmittedEvent, IntentEvent } from "./order-state-tracker.js";
import { parseOrderRef, buildOrderRef, buildOcaGroup } from "./order-state-tracker.js";
import type { ClassificationResult, ClassifiedPosition } from "./position-classifier.js";
import type { AlertManager } from "./alert-manager.js";
import { isMarketOpen } from "./market-hours.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GuardianConfig {
  fallbackMode: "market_close" | "alert_only";
  maxRetriesPerHour: number;
  quoteMaxAgeSec: number;
}

export interface QuoteSnapshot {
  bid: number;
  ask: number;
  last: number;
  timestamp: number;
}

export type GuardianActionType =
  | "noop"
  | "replacement"
  | "fallback_close"
  | "fallback_alert"
  | "alert_only";

export interface GuardianAction {
  type: GuardianActionType;
  symbol: string;
  reason: string;
}

// ─── Symbol Lock ──────────────────────────────────────────────────────────────

async function withSymbolLock<T>(
  symbol: string,
  locks: Map<string, Promise<void>>,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = locks.get(symbol) ?? Promise.resolve();
  let releaseLock!: () => void;
  const current = new Promise<void>((r) => { releaseLock = r; });
  locks.set(symbol, current);
  await prev;
  try {
    return await fn();
  } finally {
    releaseLock();
    if (locks.get(symbol) === current) {
      locks.delete(symbol);
    }
  }
}

// ─── Price Extraction ─────────────────────────────────────────────────────────

function extractPrices(
  cp: ClassifiedPosition,
  tracker: OrderStateTracker,
  snapshot: SyncSnapshot,
): { stopPrice: number | null; tpPrice: number | null } {
  let stopPrice: number | null = null;
  let tpPrice: number | null = null;

  // Source 1: Snapshot orders (auxPrice for STP, lmtPrice for TP)
  for (const order of snapshot.ownOrders) {
    if (order.orderRef === cp.stopOrderRef && order.auxPrice && order.auxPrice > 0) {
      stopPrice = order.auxPrice;
    }
    if (order.orderRef === cp.tpOrderRef && order.lmtPrice && order.lmtPrice > 0) {
      tpPrice = order.lmtPrice;
    }
  }

  // Source 2: Tracker history for current refs
  if (stopPrice === null && cp.stopOrderRef) {
    const ev = tracker.getSubmittedEvent(cp.stopOrderRef);
    if (ev?.auxPrice && ev.auxPrice > 0) stopPrice = ev.auxPrice;
  }
  if (tpPrice === null && cp.tpOrderRef) {
    const ev = tracker.getSubmittedEvent(cp.tpOrderRef);
    if (ev?.limitPrice && ev.limitPrice > 0) tpPrice = ev.limitPrice;
  }

  // Source 3: Fallback — search all orderRefs for this conId, highest gen
  if (stopPrice === null || tpPrice === null) {
    const refs = tracker.getOrderRefsForConId(cp.conId);
    let maxGen = -1;
    for (const ref of refs) {
      const parsed = parseOrderRef(ref);
      if (parsed && parsed.gen > maxGen) maxGen = parsed.gen;
    }
    if (maxGen >= 0) {
      for (const ref of refs) {
        const parsed = parseOrderRef(ref);
        if (!parsed || parsed.gen !== maxGen) continue;
        const ev = tracker.getSubmittedEvent(ref);
        if (!ev) continue;
        if (parsed.leg === "stop" && stopPrice === null && ev.auxPrice && ev.auxPrice > 0) {
          stopPrice = ev.auxPrice;
        }
        if (parsed.leg === "tp" && tpPrice === null && ev.limitPrice && ev.limitPrice > 0) {
          tpPrice = ev.limitPrice;
        }
      }
    }
  }

  return { stopPrice, tpPrice };
}

// ─── TradeIntentId Lookup ─────────────────────────────────────────────────────

function findTradeIntentId(conId: number, tracker: OrderStateTracker): string {
  const refs = tracker.getOrderRefsForConId(conId);
  for (const ref of refs) {
    const parsed = parseOrderRef(ref);
    if (parsed) return parsed.tradeIntentId;
  }
  return "";
}

// ─── Intent Reconciliation (Startup) ──────────────────────────────────────────

export function reconcileOpenIntents(
  openIntents: OpenIntent[],
  snapshot: SyncSnapshot,
  tracker: OrderStateTracker,
): void {
  const orderRefSet = new Set<string>();
  for (const order of snapshot.ownOrders) {
    if (order.orderRef) orderRefSet.add(order.orderRef);
  }

  for (const intent of openIntents) {
    const parsed = parseOrderRef(intent.orderRef);
    if (!parsed) {
      const abandonType = intent.type.startsWith("replacement_")
        ? "replacement_intent_abandoned" as const
        : "fallback_intent_abandoned" as const;
      const ev: IntentEvent = {
        type: abandonType,
        timestamp: new Date().toISOString(),
        orderRef: intent.orderRef,
        reason: "reconciled — unparseable orderRef",
      };
      tracker.applyEvent(ev);
      console.log(`[guardian] Intent reconciled (abandoned, unparseable): ${intent.orderRef}`);
      continue;
    }

    const isFallback = intent.type.startsWith("fallback_");

    if (isFallback) {
      // Fallback intent — check if fbclose order is in snapshot
      const found = orderRefSet.has(intent.orderRef);
      const ev: IntentEvent = {
        type: found ? "fallback_intent_confirmed" as const : "fallback_intent_abandoned" as const,
        timestamp: new Date().toISOString(),
        orderRef: intent.orderRef,
        reason: found ? "reconciled — order found" : "reconciled — order not found",
      };
      tracker.applyEvent(ev);
    } else {
      // Replacement intent — check if stop+tp of the intent's gen exist
      const stopRef = intent.orderRef;
      const tpRef = buildOrderRef({ ...parsed, leg: "tp" });
      const found = orderRefSet.has(stopRef) || orderRefSet.has(tpRef);
      const ev: IntentEvent = {
        type: found ? "replacement_intent_confirmed" as const : "replacement_intent_abandoned" as const,
        timestamp: new Date().toISOString(),
        orderRef: intent.orderRef,
        reason: found ? "reconciled — orders found" : "reconciled — orders not found",
      };
      tracker.applyEvent(ev);
    }

    console.log(`[guardian] Intent reconciled: ${intent.orderRef}`);
  }
}

// ─── Fallback Close ───────────────────────────────────────────────────────────

export async function checkFallbackClose(
  cp: ClassifiedPosition,
  snapshot: SyncSnapshot,
  ibkr: IBKRConnection,
  tracker: OrderStateTracker,
  alertManager: AlertManager,
  config: GuardianConfig,
  quoteCache: Map<number, QuoteSnapshot>,
  symbolLocks: Map<string, Promise<void>>,
): Promise<GuardianAction | null> {
  // Gate 1: connected
  if (!ibkr.isConnected()) return null;

  // Gate 2: snapshot freshness < 5min
  const snapshotAge = Date.now() - new Date(snapshot.timestamp).getTime();
  if (snapshotAge > 5 * 60_000) return null;

  // Gate 3: IBKR quote present, fresh, plausible
  const quote = quoteCache.get(cp.conId);
  if (!quote) return null;
  const quoteAge = (Date.now() - quote.timestamp) / 1000;
  if (quoteAge > config.quoteMaxAgeSec) return null;
  if (quote.bid <= 0 || quote.ask <= 0) return null;
  if (quote.ask / quote.bid > 1.10) return null;
  // getQuoteSnapshot can resolve with last=0 on timeout — 0 <= stop would falsely trigger fallback
  if (quote.last <= 0) return null;

  // Gate 4: market open
  if (!isMarketOpen()) return null;

  // Gate 5: no reconnect cooldown
  if (ibkr.isReconnectCooldownActive()) return null;

  // Gate 6: position exists in snapshot
  const posInSnapshot = snapshot.positions.some((p) => p.conId === cp.conId);
  if (!posInSnapshot) return null;

  // Gate 7: no active STP
  const exitState = tracker.getExitState(cp.conId);
  if (exitState?.stopOrder) return null;

  // Gate 8: market price <= expected stop
  const prices = extractPrices(cp, tracker, snapshot);
  if (!prices.stopPrice) return null;
  if (quote.last > prices.stopPrice) return null;

  // All pre-lock gates passed
  if (config.fallbackMode === "alert_only") {
    await alertManager.sendAlert(
      `guardian_fallback_${cp.symbol}`,
      "CRITICAL",
      `\u26a0\ufe0f *Guardian Fallback Alert*\n${cp.symbol}: price ${quote.last} <= stop ${prices.stopPrice}, no active STP. Mode=alert_only.`,
    );
    return { type: "fallback_alert", symbol: cp.symbol, reason: "alert_only mode" };
  }

  // market_close mode — acquire symbol lock, do live recheck
  return withSymbolLock(cp.symbol, symbolLocks, async () => {
    // Gate 9: Live recheck — STP may have appeared during lock wait
    const freshExit = tracker.getExitState(cp.conId);
    if (freshExit?.stopOrder) {
      console.log(`[guardian] Fallback aborted: STP appeared during lock wait for ${cp.symbol}`);
      return null;
    }

    const tradeIntentId = findTradeIntentId(cp.conId, tracker);
    if (!tradeIntentId) {
      await alertManager.sendAlert(
        `guardian_fallback_${cp.symbol}`,
        "CRITICAL",
        `\u26a0\ufe0f *Guardian Fallback*\n${cp.symbol}: no tradeIntentId found, cannot close.`,
      );
      return null;
    }

    const account = ibkr.getAccount();
    const gen = (cp.gen ?? 0) + 1;
    const fbRef = buildOrderRef({ account, tradeIntentId, conId: cp.conId, leg: "fbclose", gen });
    const fbOrderId = ibkr.sequencer.next();

    // fallback_intent_started (I9: fsync before placement)
    const intentStart: IntentEvent = {
      type: "fallback_intent_started",
      timestamp: new Date().toISOString(),
      orderRef: fbRef,
      reason: `price ${quote.last} <= stop ${prices.stopPrice}`,
    };
    tracker.applyEvent(intentStart);

    // order_submitted (leg=fbclose)
    const submitted: OrderSubmittedEvent = {
      type: "order_submitted",
      timestamp: new Date().toISOString(),
      orderRef: fbRef,
      orderId: fbOrderId,
      symbol: cp.symbol,
      conId: cp.conId,
      action: "SELL",
      orderType: "MKT",
      quantity: cp.positionQty,
      tif: "GTC",
      exchange: cp.exchange,
      currency: cp.currency,
    };
    tracker.applyEvent(submitted);

    try {
      const result = await ibkr.placeGuardianMarketSell({
        orderId: fbOrderId,
        orderRef: fbRef,
        symbol: cp.symbol,
        exchange: cp.exchange,
        currency: cp.currency,
        quantity: cp.positionQty,
      });

      const confirmEv: IntentEvent = {
        type: result.filled ? "fallback_intent_confirmed" : "fallback_intent_abandoned",
        timestamp: new Date().toISOString(),
        orderRef: fbRef,
        reason: result.filled ? `filled @ ${result.avgFillPrice}` : "not filled",
      };
      tracker.applyEvent(confirmEv);
    } catch (e) {
      const abandonEv: IntentEvent = {
        type: "fallback_intent_abandoned",
        timestamp: new Date().toISOString(),
        orderRef: fbRef,
        reason: `error: ${e instanceof Error ? e.message : String(e)}`,
      };
      tracker.applyEvent(abandonEv);
    }

    await alertManager.sendAlert(
      `guardian_fallback_${cp.symbol}`,
      "CRITICAL",
      `\ud83d\udea8 *Guardian Fallback Close*\n${cp.symbol}: MKT SELL ${cp.positionQty} \u2014 price ${quote.last} <= stop ${prices.stopPrice}`,
    );

    return { type: "fallback_close", symbol: cp.symbol, reason: `price ${quote.last} <= stop ${prices.stopPrice}` };
  });
}

// ─── Main Guardian Cycle ──────────────────────────────────────────────────────

export async function runGuardianCycle(
  classification: ClassificationResult,
  snapshot: SyncSnapshot,
  ibkr: IBKRConnection,
  tracker: OrderStateTracker,
  alertManager: AlertManager,
  config: GuardianConfig,
  retryTracker: Map<string, { count: number; windowStart: number }>,
  symbolLocks: Map<string, Promise<void>>,
  _quoteCache: Map<number, QuoteSnapshot>,
): Promise<GuardianAction[]> {
  // Belt + suspenders: caller also gates, but double-check
  if (ibkr.guardianLocked || ibkr.syncInProgress || tracker.tradingLocked) {
    return [];
  }

  const actions: GuardianAction[] = [];
  const account = ibkr.getAccount();

  // Build legacy conId set for I2 check
  const legacyConIds = new Set<number>();
  for (const lo of classification.legacyOwn) {
    legacyConIds.add(lo.conId);
  }

  for (const cp of classification.positions) {
    // 1. Protected → noop
    if (cp.state === "protected") {
      actions.push({ type: "noop", symbol: cp.symbol, reason: "protected" });
      continue;
    }

    // 2. Legacy-involved + not protected → CRITICAL alert only (I2)
    if (legacyConIds.has(cp.conId)) {
      await alertManager.sendAlert(
        `guardian_legacy_${cp.symbol}`,
        "CRITICAL",
        `\u26a0\ufe0f *Guardian*: ${cp.symbol} state=${cp.state} \u2014 legacy orders involved, no auto-action (I2). ${cp.details}`,
      );
      actions.push({ type: "alert_only", symbol: cp.symbol, reason: `legacy-involved: ${cp.state}` });
      continue;
    }

    // 3. foreign_involved → WARN alert, no action
    if (cp.state === "foreign_involved") {
      await alertManager.sendAlert(
        `guardian_foreign_${cp.symbol}`,
        "WARN",
        `\u26a0\ufe0f *Guardian*: ${cp.symbol} has non-legacy foreign orders \u2014 no auto-action.`,
      );
      actions.push({ type: "alert_only", symbol: cp.symbol, reason: "foreign_involved" });
      continue;
    }

    // 4. unreconstructable → CRITICAL, no placement
    if (cp.state === "unreconstructable") {
      await alertManager.sendAlert(
        `guardian_unrecon_${cp.symbol}`,
        "CRITICAL",
        `\ud83d\udea8 *Guardian*: ${cp.symbol} unreconstructable \u2014 no exit orders, no intent, no legacy.`,
      );
      actions.push({ type: "alert_only", symbol: cp.symbol, reason: "unreconstructable" });
      continue;
    }

    // Retry budget check
    const now = Date.now();
    let retry = retryTracker.get(cp.symbol);
    if (retry) {
      if (now - retry.windowStart > 3600_000) {
        // Window expired — reset
        retry = { count: 0, windowStart: now };
        retryTracker.set(cp.symbol, retry);
      }
      if (retry.count >= config.maxRetriesPerHour) {
        await alertManager.sendAlert(
          `guardian_retry_${cp.symbol}`,
          "CRITICAL",
          `\ud83d\udea8 *Guardian*: ${cp.symbol} retry limit (${config.maxRetriesPerHour}/hr) reached. State: ${cp.state}`,
        );
        actions.push({ type: "alert_only", symbol: cp.symbol, reason: "retry limit reached" });
        continue;
      }
    }

    // Replacement action needed — within symbol lock
    const action = await withSymbolLock(cp.symbol, symbolLocks, async (): Promise<GuardianAction> => {
      const tradeIntentId = findTradeIntentId(cp.conId, tracker);
      if (!tradeIntentId) {
        await alertManager.sendAlert(
          `guardian_nointent_${cp.symbol}`,
          "CRITICAL",
          `\ud83d\udea8 *Guardian*: ${cp.symbol} no tradeIntentId found \u2014 cannot replace.`,
        );
        return { type: "alert_only", symbol: cp.symbol, reason: "no tradeIntentId" };
      }

      const prices = extractPrices(cp, tracker, snapshot);
      if (prices.stopPrice === null || prices.tpPrice === null) {
        await alertManager.sendAlert(
          `guardian_noprices_${cp.symbol}`,
          "CRITICAL",
          `\ud83d\udea8 *Guardian*: ${cp.symbol} cannot extract stop/tp prices \u2014 cannot replace.`,
        );
        return { type: "alert_only", symbol: cp.symbol, reason: "no prices" };
      }

      const newGen = (cp.gen ?? 0) + 1;
      const newStopRef = buildOrderRef({ account, tradeIntentId, conId: cp.conId, leg: "stop", gen: newGen });
      const newTpRef = buildOrderRef({ account, tradeIntentId, conId: cp.conId, leg: "tp", gen: newGen });
      const newOcaGroup = buildOcaGroup(tradeIntentId, newGen);
      const stopOrderId = ibkr.sequencer.next();
      const tpOrderId = ibkr.sequencer.next();

      // Increment retry counter BEFORE placement attempt — failed attempts
      // must consume the budget to prevent infinite retry loops on persistent errors
      let r = retryTracker.get(cp.symbol);
      if (!r) {
        r = { count: 0, windowStart: now };
        retryTracker.set(cp.symbol, r);
      }
      r.count++;

      try {
        switch (cp.state) {
          case "missing_tp": {
            // Two-phase: place new STP+TP gen+1, wait for ack, then cancel old STP (I4)
            const intentEv: IntentEvent = {
              type: "replacement_intent_started",
              timestamp: new Date().toISOString(),
              orderRef: newStopRef,
              targetOrderRef: cp.stopOrderRef,
              reason: "missing_tp",
              newGen,
            };
            tracker.applyEvent(intentEv);

            logSubmittedPair(tracker, newStopRef, newTpRef, stopOrderId, tpOrderId,
              cp, prices.stopPrice, prices.tpPrice, newOcaGroup);

            await ibkr.placeGuardianOrders({
              stopOrderId, tpOrderId, stopRef: newStopRef, tpRef: newTpRef,
              symbol: cp.symbol, exchange: cp.exchange, currency: cp.currency,
              quantity: cp.positionQty, stopPrice: prices.stopPrice, tpPrice: prices.tpPrice,
              ocaGroup: newOcaGroup,
            });

            // I4: wait for ack on new STP before cancelling old
            const acked = await ibkr.waitForOrderAck(stopOrderId);
            if (!acked) {
              const abandonEv: IntentEvent = {
                type: "replacement_intent_abandoned",
                timestamp: new Date().toISOString(),
                orderRef: newStopRef,
                reason: "new STP not acknowledged",
              };
              tracker.applyEvent(abandonEv);
              return { type: "alert_only", symbol: cp.symbol, reason: "new STP not acked" };
            }

            // Cancel old STP
            if (cp.stopOrderRef) {
              const oldOrder = snapshot.ownOrders.find((o) => o.orderRef === cp.stopOrderRef);
              if (oldOrder) await ibkr.cancelGuardianOrder(oldOrder.orderId);
            }

            const confirmEv: IntentEvent = {
              type: "replacement_intent_confirmed",
              timestamp: new Date().toISOString(),
              orderRef: newStopRef,
              reason: "missing_tp replaced",
            };
            tracker.applyEvent(confirmEv);
            break;
          }

          case "missing_stop": {
            // Cancel old TP first, then place fresh STP+TP gen+1
            const intentEv: IntentEvent = {
              type: "replacement_intent_started",
              timestamp: new Date().toISOString(),
              orderRef: newStopRef,
              targetOrderRef: cp.tpOrderRef,
              reason: "missing_stop",
              newGen,
            };
            tracker.applyEvent(intentEv);

            if (cp.tpOrderRef) {
              const oldOrder = snapshot.ownOrders.find((o) => o.orderRef === cp.tpOrderRef);
              if (oldOrder) {
                const cancelled = await ibkr.cancelGuardianOrder(oldOrder.orderId);
                if (!cancelled) {
                  const abandonEv: IntentEvent = {
                    type: "replacement_intent_abandoned",
                    timestamp: new Date().toISOString(),
                    orderRef: newStopRef,
                    reason: "old TP cancel failed",
                  };
                  tracker.applyEvent(abandonEv);
                  return { type: "alert_only", symbol: cp.symbol, reason: "old TP cancel failed" };
                }
              }
            }

            logSubmittedPair(tracker, newStopRef, newTpRef, stopOrderId, tpOrderId,
              cp, prices.stopPrice, prices.tpPrice, newOcaGroup);

            await ibkr.placeGuardianOrders({
              stopOrderId, tpOrderId, stopRef: newStopRef, tpRef: newTpRef,
              symbol: cp.symbol, exchange: cp.exchange, currency: cp.currency,
              quantity: cp.positionQty, stopPrice: prices.stopPrice, tpPrice: prices.tpPrice,
              ocaGroup: newOcaGroup,
            });

            const confirmEv: IntentEvent = {
              type: "replacement_intent_confirmed",
              timestamp: new Date().toISOString(),
              orderRef: newStopRef,
              reason: "missing_stop replaced",
            };
            tracker.applyEvent(confirmEv);
            break;
          }

          case "missing_both": {
            // Fresh STP+TP gen+1 with prices from tracker history
            const intentEv: IntentEvent = {
              type: "replacement_intent_started",
              timestamp: new Date().toISOString(),
              orderRef: newStopRef,
              reason: "missing_both",
              newGen,
            };
            tracker.applyEvent(intentEv);

            logSubmittedPair(tracker, newStopRef, newTpRef, stopOrderId, tpOrderId,
              cp, prices.stopPrice, prices.tpPrice, newOcaGroup);

            await ibkr.placeGuardianOrders({
              stopOrderId, tpOrderId, stopRef: newStopRef, tpRef: newTpRef,
              symbol: cp.symbol, exchange: cp.exchange, currency: cp.currency,
              quantity: cp.positionQty, stopPrice: prices.stopPrice, tpPrice: prices.tpPrice,
              ocaGroup: newOcaGroup,
            });

            const confirmEv: IntentEvent = {
              type: "replacement_intent_confirmed",
              timestamp: new Date().toISOString(),
              orderRef: newStopRef,
              reason: "missing_both replaced",
            };
            tracker.applyEvent(confirmEv);
            break;
          }

          case "qty_mismatch":
          case "oca_broken": {
            // Cancel both, place fresh gen+1
            const intentEv: IntentEvent = {
              type: "replacement_intent_started",
              timestamp: new Date().toISOString(),
              orderRef: newStopRef,
              targetOrderRef: cp.stopOrderRef,
              reason: cp.state,
              newGen,
            };
            tracker.applyEvent(intentEv);

            if (cp.stopOrderRef) {
              const oldStop = snapshot.ownOrders.find((o) => o.orderRef === cp.stopOrderRef);
              if (oldStop) await ibkr.cancelGuardianOrder(oldStop.orderId);
            }
            if (cp.tpOrderRef) {
              const oldTp = snapshot.ownOrders.find((o) => o.orderRef === cp.tpOrderRef);
              if (oldTp) await ibkr.cancelGuardianOrder(oldTp.orderId);
            }

            logSubmittedPair(tracker, newStopRef, newTpRef, stopOrderId, tpOrderId,
              cp, prices.stopPrice, prices.tpPrice, newOcaGroup);

            await ibkr.placeGuardianOrders({
              stopOrderId, tpOrderId, stopRef: newStopRef, tpRef: newTpRef,
              symbol: cp.symbol, exchange: cp.exchange, currency: cp.currency,
              quantity: cp.positionQty, stopPrice: prices.stopPrice, tpPrice: prices.tpPrice,
              ocaGroup: newOcaGroup,
            });

            const confirmEv: IntentEvent = {
              type: "replacement_intent_confirmed",
              timestamp: new Date().toISOString(),
              orderRef: newStopRef,
              reason: `${cp.state} replaced`,
            };
            tracker.applyEvent(confirmEv);
            break;
          }

          default:
            return { type: "noop", symbol: cp.symbol, reason: `unhandled state ${cp.state}` };
        }

        console.log(`[guardian] ${cp.symbol}: ${cp.state} \u2192 replacement gen=${newGen}`);
        return { type: "replacement", symbol: cp.symbol, reason: cp.state };

      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const abandonEv: IntentEvent = {
          type: "replacement_intent_abandoned",
          timestamp: new Date().toISOString(),
          orderRef: newStopRef,
          reason: `error: ${msg}`,
        };
        tracker.applyEvent(abandonEv);
        await alertManager.sendAlert(
          `guardian_error_${cp.symbol}`,
          "CRITICAL",
          `\ud83d\udea8 *Guardian Error*: ${cp.symbol} ${cp.state} \u2014 ${msg}`,
        );
        return { type: "alert_only", symbol: cp.symbol, reason: `error: ${msg}` };
      }
    });

    actions.push(action);
  }

  return actions;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function logSubmittedPair(
  tracker: OrderStateTracker,
  stopRef: string,
  tpRef: string,
  stopOrderId: number,
  tpOrderId: number,
  cp: ClassifiedPosition,
  stopPrice: number,
  tpPrice: number,
  ocaGroup: string,
): void {
  const stopEv: OrderSubmittedEvent = {
    type: "order_submitted",
    timestamp: new Date().toISOString(),
    orderRef: stopRef,
    orderId: stopOrderId,
    symbol: cp.symbol,
    conId: cp.conId,
    action: "SELL",
    orderType: "STP",
    quantity: cp.positionQty,
    auxPrice: stopPrice,
    tif: "GTC",
    ocaGroup,
    exchange: cp.exchange,
    currency: cp.currency,
  };
  tracker.applyEvent(stopEv);

  const tpEv: OrderSubmittedEvent = {
    type: "order_submitted",
    timestamp: new Date().toISOString(),
    orderRef: tpRef,
    orderId: tpOrderId,
    symbol: cp.symbol,
    conId: cp.conId,
    action: "SELL",
    orderType: "LMT",
    quantity: cp.positionQty,
    limitPrice: tpPrice,
    tif: "GTC",
    ocaGroup,
    exchange: cp.exchange,
    currency: cp.currency,
  };
  tracker.applyEvent(tpEv);
}
