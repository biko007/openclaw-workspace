/**
 * Auftrag Option A (24.10.2026): unrealisierter Wert ohne Position, echter
 * Kurs bei Glattstellung, Anomalie nur für freigegebene BUYs, Alt-Orders in
 * /orders.
 */
import { describe, it, expect } from "vitest";
import {
  unrealizedPnlFor,
  positionKey,
  sentinelCloseValues,
  legacyOrdersForDisplay,
} from "../src/status-helpers.js";
import { approvedBuyCount, reportDeviations } from "../src/report-ledger.js";
import { CONFIDENCE_THRESHOLD } from "../src/ai-decision.js";
import type { OrderRecord } from "../src/store.js";

describe("unrealizedPnlFor", () => {
  it("ohne Position 0 — kein Altwert (vorher blieben +18,44 $ stehen)", () => {
    expect(unrealizedPnlFor([], 18.44, 18.44)).toBe(0);
    expect(unrealizedPnlFor([], null, 18.44)).toBe(0);
  });
  it("mit Position: Kontowert vor Positionssumme vor Altwert (unverändert)", () => {
    expect(unrealizedPnlFor([{ unrealizedPnl: 10 }], 25, 1)).toBe(25);
    expect(unrealizedPnlFor([{ unrealizedPnl: 10 }, { unrealizedPnl: 5 }], 0, 1)).toBe(15);
    expect(unrealizedPnlFor([{ unrealizedPnl: 0 }], null, 7)).toBe(7);
  });
});

describe("sentinelCloseValues", () => {
  const last = { quantity: 63, avgCost: 1015.62, marketPrice: 1025 };
  it("mit IBKR-Ausführungskurs: damit rechnen, nicht geschätzt", () => {
    const v = sentinelCloseValues(last, 1015.62, 1004);
    expect(v.estimated).toBe(false);
    expect(v.exitPrice).toBe(1004);
    expect(v.pnl).toBeCloseTo((1004 - 1015.62) * 63, 6);
    expect(v.pnl).toBeLessThan(0);
  });
  it("ohne Ausführungskurs: letzter Marktpreis, als geschätzt gekennzeichnet", () => {
    for (const fill of [null, 0]) {
      const v = sentinelCloseValues(last, 1015.62, fill);
      expect(v.estimated).toBe(true);
      expect(v.exitPrice).toBe(1025);
      expect(v.pnl).toBeCloseTo((1025 - 1015.62) * 63, 6);
    }
  });
  it("ohne Einstand: Basis avgCost", () => {
    expect(sentinelCloseValues(last, 0, 1020).pnl).toBeCloseTo((1020 - 1015.62) * 63, 6);
  });
});

describe("positionKey", () => {
  it("gleiche Position gleicher Schlüssel, neue Position (andere Menge) anderer", () => {
    const a = positionKey({ symbol: "SO", quantity: 300, avgCost: 94.25 });
    expect(positionKey({ symbol: "SO", quantity: 300, avgCost: 94.25 })).toBe(a);
    expect(positionKey({ symbol: "SO", quantity: 200, avgCost: 94.25 })).not.toBe(a);
  });
});

describe("Anomalie nur für freigegebene BUYs", () => {
  const base = {
    tradingLocked: false, guardianLocked: false, connected: true, reconnectAttempts: 0,
    activeAlerts: [], positionCount: 0, protectedCount: 0, hasClassification: true,
  };
  it("BUY unter der Schwelle (0,72/0,74) zählt nicht → keine Anomalie", () => {
    const d = [
      { decision: "BUY", confidence: 0.72 },
      { decision: "BUY", confidence: 0.74 },
      { decision: "SKIP", confidence: 0.9 },
    ];
    const n = approvedBuyCount(d, CONFIDENCE_THRESHOLD);
    expect(n).toBe(0);
    expect(reportDeviations({ ...base, buyDecisions: n, openedToday: 0 })).toEqual([]);
  });
  it("freigegebener BUY (≥ 0,75) ohne Eröffnung → Anomalie", () => {
    const n = approvedBuyCount([{ decision: "BUY", confidence: 0.75 }, { decision: "BUY", confidence: 0.8 }], CONFIDENCE_THRESHOLD);
    expect(n).toBe(2);
    expect(reportDeviations({ ...base, buyDecisions: n, openedToday: 0 }))
      .toEqual(["Anomalie: 2 freigegebene BUY-Entscheidung(en), 0 Eröffnungen"]);
  });
  it("freigegebener BUY mit Eröffnung → keine Anomalie", () => {
    expect(reportDeviations({ ...base, buyDecisions: 1, openedToday: 1 })).toEqual([]);
  });
});

describe("legacyOrdersForDisplay", () => {
  const o = (id: string, status: string): OrderRecord =>
    ({ id, symbol: "COP", side: "SELL", quantity: 394, price: 115.5, status, timestamp: "2026-06-12T16:36:14.986Z" });

  it("offener Status, bei IBKR nicht offen → NotAtIBKR, Originalstatus erhalten", () => {
    const [a] = legacyOrdersForDisplay([o("ORD-4912", "Submitted")], new Set([1, 2]));
    expect(a.status).toBe("NotAtIBKR");
    expect(a.logStatus).toBe("Submitted");
  });
  it("bei IBKR offen → unverändert", () => {
    const [a] = legacyOrdersForDisplay([o("ORD-4912", "Submitted")], new Set([4912]));
    expect(a.status).toBe("Submitted");
  });
  it("abgeschlossene Status und unbekannter IBKR-Stand → unverändert", () => {
    expect(legacyOrdersForDisplay([o("ORD-1", "Filled")], new Set())[0].status).toBe("Filled");
    expect(legacyOrdersForDisplay([o("ORD-1", "PreSubmitted")], null)[0].status).toBe("PreSubmitted");
  });
  it("Eingabe wird nicht verändert", () => {
    const input = [o("ORD-4912", "Submitted")];
    legacyOrdersForDisplay(input, new Set());
    expect(input[0].status).toBe("Submitted");
  });
});

import { parseExecTimeUtc, IBKRConnection } from "../src/ibkr.js";

describe("IBKR-Ausführungskurs für die Glattstellung (Review 24.10.2026)", () => {
  it("parseExecTimeUtc: UTC-Formate ja, fremde Zeitzone nein", () => {
    expect(parseExecTimeUtc("20261024-14:05:03")).toBe(Date.UTC(2026, 9, 24, 14, 5, 3));
    expect(parseExecTimeUtc("20261024  14:05:03 UTC")).toBe(Date.UTC(2026, 9, 24, 14, 5, 3));
    expect(parseExecTimeUtc("20261024 14:05:03 US/Eastern")).toBeNull();
    expect(parseExecTimeUtc("")).toBeNull();
    expect(parseExecTimeUtc(undefined)).toBeNull();
  });

  it("recentSellPrice: nur SLD im Zeitfenster, nach Stück gewichtet, Korrektur ersetzt", () => {
    const ib = new IBKRConnection() as any;
    const now = Date.now();
    ib._rememberExec("RHM", { execId: "a.01", side: "SLD", shares: 40, price: 1000 }, now);
    ib._rememberExec("RHM", { execId: "b.01", side: "SLD", shares: 20, price: 1010 }, now);
    ib._rememberExec("RHM", { execId: "b.02", side: "SLD", shares: 23, price: 1010 }, now); // Korrektur von b
    ib._rememberExec("RHM", { execId: "c.01", side: "BOT", shares: 63, price: 900 }, now);
    ib._rememberExec("RHM", { execId: "d.01", side: "SLD", shares: 63, price: 500 }, now - 4 * 3600_000); // alt
    expect(ib.recentSellPrice("RHM", 15 * 60_000)).toBeCloseTo((40 * 1000 + 23 * 1010) / 63, 6);
    expect(ib.recentSellPrice("SAP", 15 * 60_000)).toBeNull();
  });
});
