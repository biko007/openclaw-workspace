/**
 * Option B: Nach −2 % NLV seit Vortagsschluss keine neuen Käufe — der Executor
 * fragt dann weder Kurs noch KI ab und meldet einmal „Tageslimit erreicht“.
 */
import { describe, it, expect, vi } from "vitest";

const { quote, vortag } = vi.hoisted(() => ({ quote: vi.fn(async () => null), vortag: { nlv: 1_000_000 } }));
vi.mock("yahoo-finance2", () => ({ default: class { quote = (...a: unknown[]) => quote(...(a as [])); } }));
vi.mock("../src/ai-decision.js", () => ({
  evaluateTrade: vi.fn(async () => ({ decision: "SKIP", confidence: 0, reasoning: "test" })),
  shouldExecuteTrade: vi.fn(() => false),
}));
vi.mock("../src/store.js", async (orig) => ({
  ...(await orig<typeof import("../src/store.js")>()),
  loadPreviousDayPerformance: () => ({ date: "2026-10-26", dailyPnl: 0, realizedPnl: 0, unrealizedPnl: 0, netLiquidation: vortag.nlv }),
  loadUniverse: () => ({ symbols: [{ symbol: "COP", currency: "USD", exchange: "SMART" }] }),
}));

import { OrderExecutor } from "../src/executor.js";

function executor(nlv: number) {
  const alerts = { sendAlert: vi.fn(async () => true), isActive: vi.fn(() => false), resolve: vi.fn(async () => {}) };
  const status = { mode: 3, connected: true, positions: [], cashBalance: 900_000, netLiquidation: nlv } as any;
  const ex = new OrderExecutor({ isConnected: () => true } as any, () => status, () => {}, {} as any, alerts as any);
  return { ex, alerts };
}
const kandidat = [{ symbol: "COP", strategy: "momentum", signal: "MOMENTUM_CONFIRMED", strength: 2, indicators: {}, timestamp: "2026-10-27T15:00:00Z" }] as any;

describe("Executor: Tageslimit", () => {
  it("−2,5 % seit Vortag: keine Kursabfrage, Meldung daily_loss_limit", async () => {
    quote.mockClear();
    const { ex, alerts } = executor(975_000);
    expect(await ex.executeAfterScan(kandidat)).toEqual([]);
    expect(quote).not.toHaveBeenCalled();
    expect(alerts.sendAlert).toHaveBeenCalledWith("daily_loss_limit", "WARN", expect.stringContaining("Tageslimit erreicht"));
  });

  it("−1 % seit Vortag: Prüfung läuft weiter bis zur Kandidatenbewertung", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-27T15:00:00Z"));
    quote.mockClear();
    const { ex, alerts } = executor(990_000);
    await ex.executeAfterScan(kandidat);
    expect(alerts.sendAlert).not.toHaveBeenCalledWith("daily_loss_limit", expect.anything(), expect.anything());
    expect(quote).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
