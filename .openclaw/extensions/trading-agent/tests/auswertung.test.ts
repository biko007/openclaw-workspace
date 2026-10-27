/**
 * Option B: Ergebnis je Abschluss aus IBKR-Ausführungen (orders-v2) und Monatsauswertung.
 */
import { describe, it, expect } from "vitest";
import { auswerten } from "../src/auswertung.js";

const ref = (intent: string, leg: string, gen = 0) => `OCAGENT|DUP514636|${intent}|1|${leg}|${gen}`;
const sub = (intent: string, symbol: string, currency = "USD", timestamp = "2026-07-01T13:00:00Z") =>
  ({ type: "order_submitted", timestamp, orderRef: ref(intent, "entry"), symbol, currency });
let n = 0;
const fill = (intent: string, leg: string, ts: string, shares: number, price: number, side = leg === "entry" ? "BOT" : "SLD") =>
  ({ type: "order_filled", timestamp: ts, orderRef: ref(intent, leg), execId: `e${++n}.01`, execIdBase: `e${n}`, shares, price, side });

describe("Abschlüsse aus Ausführungen", () => {
  it("Teilausführungen summiert; Gewinn, Ausstiegsgrund, Levelquelle", () => {
    const ev = [sub("NKE-260701-01", "NKE"), fill("NKE-260701-01", "entry", "2026-07-01T13:31:00Z", 1000, 42),
      fill("NKE-260701-01", "entry", "2026-07-01T13:31:01Z", 355, 42.4),
      fill("NKE-260701-01", "tp", "2026-07-02T15:00:00Z", 1355, 44)];
    const a = auswerten(ev, [], [{ tradeIntentId: "NKE-260701-01", levelSource: "standard" }]);
    expect(a.abschluesse).toHaveLength(1);
    const x = a.abschluesse[0];
    expect([x.quantity, x.exitReason, x.levelSource, x.estimated]).toEqual([1355, "tp", "standard", false]);
    expect(x.pnl).toBeCloseTo(1355 * 44 - (1000 * 42 + 355 * 42.4), 1);
  });

  it("IBKR-Korrektur (gleiche execIdBase, höherer Suffix) ersetzt die alte Ausführung", () => {
    const ev = [sub("V-260729-01", "V"), fill("V-260729-01", "entry", "2026-07-29T14:00:00Z", 100, 300),
      { type: "order_filled", timestamp: "2026-07-29T19:00:00Z", orderRef: ref("V-260729-01", "tp"), execId: "x.01", execIdBase: "x", shares: 100, price: 305 },
      { type: "order_filled", timestamp: "2026-07-29T19:00:01Z", orderRef: ref("V-260729-01", "tp"), execId: "x.02", execIdBase: "x", shares: 100, price: 306 }];
    expect(auswerten(ev, [], []).abschluesse[0].pnl).toBe(600);
  });

  it("Ausstieg unter der Kennung einer älteren Position desselben Symbols wird zugeordnet (AIG 08.10.)", () => {
    const ev = [sub("AIG-260929-03", "AIG"), fill("AIG-260929-03", "entry", "2026-09-29T17:21:00Z", 870, 74.37),
      fill("AIG-260929-03", "tp", "2026-10-08T16:00:00Z", 550, 76.5), fill("AIG-260615-01", "tp", "2026-10-08T16:11:00Z", 320, 76.5)];
    const a = auswerten(ev, [], []);
    expect(a.offen).toEqual([]);
    expect(a.ohneEinstand).toBe(0);
    expect(a.abschluesse[0].pnl).toBeCloseTo(870 * (76.5 - 74.37), 1);
  });

  it("Altposition ohne Einstieg wird nicht gewertet, aber genannt; verschwundene Position ebenso", () => {
    const ev = [fill("DUK-260612-01", "stop", "2026-08-10T14:00:00Z", 200, 110),
      sub("MSFT-261001-01", "MSFT"), fill("MSFT-261001-01", "entry", "2026-10-01T14:00:00Z", 10, 400)];
    const a = auswerten(ev, [], [], undefined, []);
    expect(a.abschluesse).toEqual([]);
    expect(a.ohneEinstand).toBe(1);
    expect(a.offen[0].beiIbkr).toBe(false);
    expect(a.hinweise.join(" ")).toContain("ohne Einstieg");
    expect(a.hinweise.join(" ")).toContain("MSFT");
  });

  it("Glattstellung in der TWS: position_closed als geschätzt", () => {
    const ev = [sub("GILD-260701-01", "GILD"), fill("GILD-260701-01", "entry", "2026-07-01T14:00:00Z", 100, 120),
      { type: "position_closed", timestamp: "2026-07-07T13:31:00Z", symbol: "GILD", exitPrice: 130, source: "sentinel", estimated: true }];
    const x = auswerten(ev, [], []).abschluesse[0];
    expect([x.exitReason, x.estimated, x.pnl]).toEqual(["glattgestellt", true, 1000]);
  });
});

describe("Monatsauswertung", () => {
  it("Trefferquote, Durchschnitt, größter Gewinn/Verlust, je Währung", () => {
    const ev = [sub("A-260801-01", "A"), fill("A-260801-01", "entry", "2026-08-01T14:00:00Z", 10, 100), fill("A-260801-01", "tp", "2026-08-02T14:00:00Z", 10, 110),
      sub("B-260801-01", "B"), fill("B-260801-01", "entry", "2026-08-03T14:00:00Z", 10, 100), fill("B-260801-01", "stop", "2026-08-04T14:00:00Z", 10, 97),
      sub("C-260801-01", "C", "EUR"), fill("C-260801-01", "entry", "2026-08-05T08:00:00Z", 10, 50), fill("C-260801-01", "stop", "2026-08-06T08:00:00Z", 10, 48)];
    const m = auswerten(ev, [], []).monate.find((x) => x.monat === "2026-08")!;
    expect([m.abschluesse, m.gewinner, m.verlierer]).toEqual([3, 1, 2]);
    expect(m.trefferquote).toBeCloseTo(33.33, 1);
    expect(m.realisiert).toEqual({ USD: 70, EUR: -20 });
    expect(m.groessterVerlust).toEqual({ symbol: "B", pnl: -30, currency: "USD" });
    expect(m.jeAusstieg).toEqual({ tp: 1, stop: 2 });
  });

  it("Zinsanteil nur an Tagen ohne Position (aus Haltezeiten, nicht aus unrealizedPnl)", () => {
    const ev = [sub("X-261005-01", "X", "USD", "2026-10-05T13:59:00Z"), fill("X-261005-01", "entry", "2026-10-05T14:00:00Z", 10, 100), fill("X-261005-01", "tp", "2026-10-06T14:00:00Z", 10, 106)];
    const perf = [
      { date: "2026-10-03", unrealizedPnl: 480, netLiquidation: 1000 },
      { date: "2026-10-04", unrealizedPnl: 480, netLiquidation: 1040 },
      { date: "2026-10-05", unrealizedPnl: 0, netLiquidation: 1100 },
      { date: "2026-10-06", unrealizedPnl: 0, netLiquidation: 1200 },
      { date: "2026-10-07", unrealizedPnl: 0, netLiquidation: 1245 },
      { date: "2026-10-08", unrealizedPnl: 0, netLiquidation: 1290 },
    ];
    /* Vor dem ersten Ereignis (05.10.) nichts werten; 05./06. belegt; nur 07.→08. ist frei. */
    const m = auswerten(ev, perf, []).monate.find((x) => x.monat === "2026-10")!;
    expect([m.ohnePositionTage, m.ohnePositionNlv]).toEqual([1, 45]);
  });
});
