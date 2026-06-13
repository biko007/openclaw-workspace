/**
 * Watchdog Metrics — Exit Coverage Check (Etappe 8a)
 *
 * Extracted from index.ts watchdogTick() Check-4 logic to enable unit testing.
 * index.ts has top-level side effects (IBKR connect, timer start) that fire on
 * import — this file has none.
 */

import type { ClassificationResult } from "./position-classifier.js";
import type { ExitState } from "./order-state-tracker.js";
import type { AlertManager } from "./alert-manager.js";
import type { GuardianAlertCache } from "./position-guardian.js";

export interface ExitCoverageResult {
  exitsLabel: string;
  exitsIncomplete: number;
  stopCoverage: number;
  tpCoverage: number;
}

/**
 * Check-4: Exit coverage (exits_incomplete + qty_undercoverage).
 *
 * Computes how many positions are fully protected, alerts on gaps,
 * and escalates exits_incomplete WARN→CRITICAL after escalationMs.
 */
export async function checkExitCoverage(
  classification: ClassificationResult,
  getExitState: (conId: number) => ExitState | null,
  alertManager: AlertManager,
  guardianAlertCache: GuardianAlertCache,
  escalationMs: number,
): Promise<ExitCoverageResult> {
  const total = classification.positions.length;
  const protectedCount = classification.stateCount["protected"] ?? 0;
  const exitsIncomplete = total - protectedCount;
  const exitsLabel = `${protectedCount}/${total}`;

  // Qty coverage: sum active exit-order qty vs position qty
  // Only count positions with tracker-managed exits (OCAGENT orders).
  // Legacy-protected positions (clientId=98) are not in the tracker.
  let totalPositionQty = 0;
  let totalStopQty = 0;
  let totalTpQty = 0;
  for (const cp of classification.positions) {
    const exitState = getExitState(cp.conId);
    if (!exitState) continue; // legacy or no tracker state — skip qty check
    const posQty = Math.abs(cp.positionQty);
    totalPositionQty += posQty;
    totalStopQty += exitState.stopQty ?? 0;
    totalTpQty += exitState.tpQty ?? 0;
  }
  const stopCoverage = totalPositionQty > 0 ? totalStopQty / totalPositionQty : 1;
  const tpCoverage = totalPositionQty > 0 ? totalTpQty / totalPositionQty : 1;

  // Escalation: exits_incomplete (state-based)
  const exitsKey = "watchdog_exits_incomplete";
  if (exitsIncomplete > 0) {
    const entry = guardianAlertCache.get(exitsKey);
    if (!entry) {
      // First occurrence → WARN
      await alertManager.sendAlert(exitsKey, "WARN", [
        `⚠️ *Watchdog: Exit Coverage*`,
        ``,
        `${exitsIncomplete} position(s) not fully protected`,
        `Protected: ${protectedCount}/${total}`,
        `States: ${JSON.stringify(classification.stateCount)}`,
      ].join("\n"));
      guardianAlertCache.set(exitsKey, { state: "exits_incomplete", alertedAt: Date.now() });
    } else if (Date.now() - entry.alertedAt >= escalationMs) {
      // escalationMs unchanged → CRITICAL
      await alertManager.sendAlert(exitsKey, "CRITICAL", [
        `🚨 *Watchdog: Exit Coverage — CRITICAL*`,
        ``,
        `${exitsIncomplete} position(s) unprotected for >15min`,
        `Protected: ${protectedCount}/${total}`,
        `States: ${JSON.stringify(classification.stateCount)}`,
      ].join("\n"));
      guardianAlertCache.set(exitsKey, { state: "exits_incomplete", alertedAt: Date.now() });
    }
  } else {
    // All protected — resolve exits_incomplete if active
    if (guardianAlertCache.has(exitsKey)) {
      await alertManager.resolve(exitsKey);
      guardianAlertCache.delete(exitsKey);
    }
  }

  // Escalation: qty_undercoverage (qty-based, independent of state)
  const qtyKey = "watchdog_qty_undercoverage";
  if (exitsIncomplete === 0 && totalPositionQty > 0 && (stopCoverage < 1 || tpCoverage < 1)) {
    if (!guardianAlertCache.has(qtyKey)) {
      await alertManager.sendAlert(qtyKey, "WARN", [
        `⚠️ *Watchdog: Qty Undercoverage*`,
        ``,
        `All positions protected but exit qty < position qty`,
        `Stop coverage: ${(stopCoverage * 100).toFixed(0)}% (${totalStopQty}/${totalPositionQty})`,
        `TP coverage: ${(tpCoverage * 100).toFixed(0)}% (${totalTpQty}/${totalPositionQty})`,
      ].join("\n"));
      guardianAlertCache.set(qtyKey, { state: "qty_undercoverage", alertedAt: Date.now() });
    }
  } else {
    if (guardianAlertCache.has(qtyKey)) {
      await alertManager.resolve(qtyKey);
      guardianAlertCache.delete(qtyKey);
    }
  }

  return { exitsLabel, exitsIncomplete, stopCoverage, tpCoverage };
}
