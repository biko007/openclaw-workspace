/**
 * Option B (Owner-Entscheidung 27.10.2026): Tageslimit 2 % der NLV,
 * KI-Levels nur bei Stop ≥ 1,0 % und CRV ≥ 1,5 — sonst Standardlevels.
 */
import { describe, it, expect, vi } from "vitest";
import { checkDailyLoss, chooseLevels } from "../src/risk-rules.js";

const R = { minRewardRisk: 1.5, minStopPercent: 1.0 };
const tick = (p: number) => Math.round(p * 100) / 100;

describe("Tageslimit", () => {
  const cfg = { enabled: true, maxLossPercent: 2 };
  it("blockt ab 2 % Rückgang gegenüber Vortagsschluss", () => {
    expect(checkDailyLoss(1_000_000, 980_000, cfg).blocked).toBe(true);
    expect(checkDailyLoss(1_000_000, 980_001, cfg).blocked).toBe(false);
    expect(checkDailyLoss(1_000_000, 1_010_000, cfg).blocked).toBe(false);
  });
  it("ohne Vortags-NLV kein Block, aber Grund genannt", () => {
    const r = checkDailyLoss(null, 975_000, cfg);
    expect(r.blocked).toBe(false);
    expect(r.reason).toContain("nicht prüfbar");
  });
  it("abgeschaltet: nie Block", () => {
    expect(checkDailyLoss(1_000_000, 900_000, { enabled: false, maxLossPercent: 2 }).blocked).toBe(false);
  });
});

describe("Levels", () => {
  it("gute KI-Levels werden übernommen", () => {
    const l = chooseLevels(100, { suggestedEntry: 100, suggestedStop: 98, suggestedTarget: 104 }, 3, R, tick);
    expect([l.source, l.stopPrice, l.takeProfitPrice]).toEqual(["ki", 98, 104]);
  });
  it("Stop enger als 1 % → Standardlevels −3 % / +6 %", () => {
    const l = chooseLevels(100, { suggestedEntry: 100, suggestedStop: 99.5, suggestedTarget: 105 }, 3, R, tick);
    expect([l.source, l.stopPrice, l.takeProfitPrice]).toEqual(["standard", 97, 106]);
    expect(l.reason).toContain("Stop zu eng");
  });
  it("CRV unter 1,5 → Standardlevels (typischer Fall: Median 0,92)", () => {
    const l = chooseLevels(100, { suggestedEntry: 100, suggestedStop: 98.5, suggestedTarget: 101.4 }, 3, R, tick);
    expect(l.source).toBe("standard");
    expect(l.reason).toContain("CRV zu klein");
  });
  it("ohne oder mit unstimmigen KI-Levels → Standardlevels", () => {
    expect(chooseLevels(100, {}, 3, R, tick).source).toBe("standard");
    expect(chooseLevels(100, { suggestedEntry: 100, suggestedStop: 101, suggestedTarget: 104 }, 3, R, tick).reason).toContain("unstimmig");
  });
});

describe("Konfiguration", () => {
  it("Vorgaben: Tageslimit an (2 %), Levelregeln 1,5 / 1,0 %; ältere strategies.json schaltet sie nicht ab", async () => {
    vi.resetModules();
    vi.doMock("node:fs", async (orig) => {
      const fs = await orig<typeof import("node:fs")>();
      return { ...fs, readFileSync: ((p: any, ...r: any[]) => String(p).endsWith("strategies.json")
        ? JSON.stringify({ maxOpenPositions: 5, dailyLossLimit: { maxLossPercent: 3 } }) : (fs.readFileSync as any)(p, ...r)) as any };
    });
    const { loadStrategies } = await import("../src/store.js");
    const s = loadStrategies();
    expect(s.maxOpenPositions).toBe(5);
    expect(s.dailyLossLimit).toEqual({ enabled: true, maxLossPercent: 3 });
    expect(s.levelRules).toEqual({ minRewardRisk: 1.5, minStopPercent: 1.0 });
    expect(s.momentum.stopLossPercent).toBe(3);
    vi.doUnmock("node:fs");
  });
});
