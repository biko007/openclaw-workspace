/**
 * Reine Hilfsfunktionen für Status, Glattstellungs-Meldung und /orders
 * (Auftrag Option A, 24.10.2026). Ohne Seiteneffekte, damit testbar —
 * index.ts lässt sich in Tests nicht laden.
 */

import type { OrderRecord } from "./store.js";

/**
 * Unrealisierter Gewinn/Verlust für den Status.
 * Ohne Position ist er 0 — vorher blieb der letzte Wert stehen (z. B.
 * +18,44 $ nach der MDT-Glattstellung am 09.10.2026).
 */
export function unrealizedPnlFor(
  positions: readonly { unrealizedPnl: number }[],
  accountUnrealized: number | null,
  previous: number,
): number {
  if (positions.length === 0) return 0;
  if (accountUnrealized !== null && accountUnrealized !== 0) return accountUnrealized;
  const positionPnl = positions.reduce((sum, p) => sum + p.unrealizedPnl, 0);
  return positionPnl || previous;
}

/** Schlüssel einer Position: gleiche Menge und gleicher Einstand = dieselbe Position. */
export function positionKey(p: { symbol: string; quantity: number; avgCost: number }): string {
  return `${p.symbol}|${p.quantity}|${p.avgCost.toFixed(4)}`;
}

export interface SentinelCloseValues {
  exitPrice: number;
  pnl: number;
  pnlPercent: number;
  /** true = kein Ausführungskurs von IBKR, Betrag aus dem letzten Marktpreis */
  estimated: boolean;
}

/**
 * Glattstellungs-Werte einer verschwundenen Position.
 * Mit echtem Ausführungskurs (IBKR-Execution) wird damit gerechnet; sonst
 * aus dem letzten Marktpreis, als geschätzt gekennzeichnet. Vorher wurde der
 * letzte unrealisierte Wert gemeldet (RHM 24.09.: +527 $ gemeldet, real −732 €).
 */
export function sentinelCloseValues(
  last: { quantity: number; avgCost: number; marketPrice: number },
  entryPrice: number,
  fillPrice: number | null,
): SentinelCloseValues {
  const estimated = !(fillPrice !== null && fillPrice > 0);
  const exitPrice = estimated ? last.marketPrice : (fillPrice as number);
  const basis = entryPrice > 0 ? entryPrice : last.avgCost;
  const pnl = (exitPrice - basis) * last.quantity;
  const pnlPercent = basis > 0 ? ((exitPrice - basis) / basis) * 100 : 0;
  return { exitPrice, pnl, pnlPercent, estimated };
}

const OPEN_LIKE = new Set(["Submitted", "PreSubmitted", "PendingSubmit", "ApiPending", "PendingCancel"]);

export type DisplayOrder = OrderRecord & { logStatus?: string; hinweis?: string };

/**
 * Anzeige der Alt-Orders aus orders.jsonl (bis 12.06.2026).
 * Steht dort noch ein offener Status, die Order ist bei IBKR aber nicht offen,
 * wird sie als „NotAtIBKR“ angezeigt. Das Log selbst bleibt unverändert.
 * openOrderIds = null: IBKR-Stand unbekannt (nicht verbunden) → unverändert.
 */
export function legacyOrdersForDisplay(
  orders: readonly OrderRecord[],
  openOrderIds: ReadonlySet<number> | null,
): DisplayOrder[] {
  return orders.map((o) => {
    if (!openOrderIds || !OPEN_LIKE.has(o.status)) return o;
    const m = /^ORD-(\d+)$/.exec(o.id);
    if (m && openOrderIds.has(Number(m[1]))) return o;
    return {
      ...o,
      status: "NotAtIBKR",
      logStatus: o.status,
      hinweis: "Im Alt-Log offen, bei IBKR nicht offen — nicht mehr aktiv",
    };
  });
}
