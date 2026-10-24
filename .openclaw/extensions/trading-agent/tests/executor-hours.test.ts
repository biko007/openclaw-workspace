/**
 * Börsenprüfung im Executor (Auftrag Option A, 24.10.2026): vor Kursabfrage,
 * KI-Aufruf und Order muss die Börse des Symbols offen sein. Vorher galten
 * feste UTC-Fenster ohne Wochentag — am Sa 17.10.2026 gingen 21 Orders raus.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

const { quote } = vi.hoisted(() => ({ quote: vi.fn(async () => null) }));
vi.mock("yahoo-finance2", () => ({ default: class { quote = (...a: unknown[]) => quote(...(a as [])); } }));
vi.mock("../src/ai-decision.js", () => ({
  evaluateTrade: vi.fn(async () => ({ decision: "SKIP", confidence: 0, reasoning: "test" })),
  shouldExecuteTrade: vi.fn(() => false),
}));
vi.mock("../src/store.js", async (orig) => ({
  ...(await orig<typeof import("../src/store.js")>()),
  loadUniverse: () => ({ symbols: [
    { symbol: "SAP", currency: "EUR", exchange: "IBIS" },
    { symbol: "COP", currency: "USD", exchange: "SMART" },
  ] }),
}));

import { OrderExecutor } from "../src/executor.js";
import { evaluateTrade } from "../src/ai-decision.js";

afterEach(() => vi.useRealTimers());

async function versuch(symbol: string, iso: string) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
  quote.mockClear();
  vi.mocked(evaluateTrade).mockClear();
  const ex = new OrderExecutor({} as any, () => ({} as any), async () => {}, {} as any, {} as any);
  const r = await (ex as any).executeSingleOrder(
    { symbol, strategy: "momentum", strength: 1, indicators: {}, timestamp: iso },
    10_000, 3, { totalEvaluated: 0, errors: [] },
  );
  return { result: r, quotes: quote.mock.calls.length, ki: vi.mocked(evaluateTrade).mock.calls.length };
}

describe("Executor: Börse des Symbols muss offen sein", () => {
  it("Sa 24.10.2026: weder XETRA- noch NYSE-Symbol — keine Kursabfrage, keine KI", async () => {
    expect(await versuch("SAP", "2026-10-24T10:00:00Z")).toEqual({ result: null, quotes: 0, ki: 0 });
    expect(await versuch("COP", "2026-10-24T15:00:00Z")).toEqual({ result: null, quotes: 0, ki: 0 });
  });

  it("Mo 26.10.2026 07:30 UTC (alte Lücke): XETRA noch zu", async () => {
    expect((await versuch("SAP", "2026-10-26T07:30:00Z")).quotes).toBe(0);
  });

  it("Mo 26.10.2026 08:30 UTC: XETRA offen → Prüfung passiert, NYSE-Symbol noch nicht", async () => {
    expect((await versuch("SAP", "2026-10-26T08:30:00Z")).quotes).toBe(1);
    expect((await versuch("COP", "2026-10-26T08:30:00Z")).quotes).toBe(0);
  });

  it("Mo 02.11.2026: NYSE erst ab 14:30 UTC", async () => {
    expect((await versuch("COP", "2026-11-02T14:00:00Z")).quotes).toBe(0);
    expect((await versuch("COP", "2026-11-02T14:45:00Z")).quotes).toBe(1);
  });
});
