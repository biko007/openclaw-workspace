/**
 * Börsenzeiten je Börse in deren Zeitzone (Auftrag Option A, 24.10.2026).
 * Vorher feste UTC-Fenster ohne Wochentag: Scans, KI-Aufrufe und Orders am
 * Wochenende, und ab 26.10.2026 (XETRA) bzw. 02.11.2026 (NYSE) eine Stunde
 * vor Börsenöffnung.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/indicators.js", async (orig) => ({
  ...(await orig<typeof import("../src/indicators.js")>()),
  isMarketSafe: vi.fn(async () => ({ safe: false, reason: "test stop" })),
}));

import {
  isExchangeOpen,
  isMarketOpen,
  exchangeClock,
  tradingWindowsUtc,
  tradingWindowsLabel,
} from "../src/market-hours.js";
import { getCalendar } from "../src/trading-calendar.js";
import { isMarketSafe } from "../src/indicators.js";
import { UniverseManager } from "../src/universe-manager.js";

const at = (iso: string) => new Date(iso);

beforeEach(() => {
  (globalThis as any).__tradingCalendar = undefined;
});

describe("Wochenende", () => {
  it("Sa 24.10. und So 25.10.2026: keine Börse offen, auch zu Handelszeiten", () => {
    for (const iso of ["2026-10-24T09:00:00Z", "2026-10-24T14:00:00Z", "2026-10-25T08:30:00Z", "2026-10-25T15:00:00Z"]) {
      expect(isMarketOpen(at(iso))).toBe(false);
      expect(isExchangeOpen("XETRA", at(iso))).toBe(false);
      expect(isExchangeOpen("NYSE", at(iso))).toBe(false);
    }
  });

  it("Fenster für Sa/So: beide geschlossen", () => {
    expect(tradingWindowsUtc("2026-10-24")).toEqual({ XETRA: null, NYSE: null });
    expect(tradingWindowsUtc("2026-10-25")).toEqual({ XETRA: null, NYSE: null });
  });
});

describe("XETRA Sommer-/Winterzeit", () => {
  it("Fr 23.10.2026 (Sommerzeit): 07:00–15:30 UTC", () => {
    expect(isExchangeOpen("XETRA", at("2026-10-23T06:59:00Z"))).toBe(false);
    expect(isExchangeOpen("XETRA", at("2026-10-23T07:00:00Z"))).toBe(true);
    expect(isExchangeOpen("XETRA", at("2026-10-23T15:29:00Z"))).toBe(true);
    expect(isExchangeOpen("XETRA", at("2026-10-23T15:30:00Z"))).toBe(false);
  });

  it("Mo 26.10.2026 (Winterzeit): 08:00–16:30 UTC — 07:00 UTC ist geschlossen", () => {
    expect(isExchangeOpen("XETRA", at("2026-10-26T07:00:00Z"))).toBe(false);
    expect(isExchangeOpen("XETRA", at("2026-10-26T07:59:00Z"))).toBe(false);
    expect(isExchangeOpen("XETRA", at("2026-10-26T08:00:00Z"))).toBe(true);
    expect(isExchangeOpen("XETRA", at("2026-10-26T16:29:00Z"))).toBe(true);
    expect(isExchangeOpen("XETRA", at("2026-10-26T16:30:00Z"))).toBe(false);
  });
});

describe("NYSE: US-Umstellung erst am 01.11.2026", () => {
  it("Mo 26.10.2026 (USA noch Sommerzeit): 13:30–20:00 UTC", () => {
    expect(isExchangeOpen("NYSE", at("2026-10-26T13:29:00Z"))).toBe(false);
    expect(isExchangeOpen("NYSE", at("2026-10-26T13:30:00Z"))).toBe(true);
    expect(isExchangeOpen("NYSE", at("2026-10-26T19:59:00Z"))).toBe(true);
    expect(isExchangeOpen("NYSE", at("2026-10-26T20:00:00Z"))).toBe(false);
  });

  it("Mo 02.11.2026 (Winterzeit): 14:30–21:00 UTC — 13:30 UTC ist geschlossen", () => {
    expect(isExchangeOpen("NYSE", at("2026-11-02T13:30:00Z"))).toBe(false);
    expect(isExchangeOpen("NYSE", at("2026-11-02T14:29:00Z"))).toBe(false);
    expect(isExchangeOpen("NYSE", at("2026-11-02T14:30:00Z"))).toBe(true);
    expect(isExchangeOpen("NYSE", at("2026-11-02T20:59:00Z"))).toBe(true);
    expect(isExchangeOpen("NYSE", at("2026-11-02T21:00:00Z"))).toBe(false);
  });

  it("tradingWindowsUtc: 26.10. und 02.11.2026", () => {
    expect(tradingWindowsUtc("2026-10-26")).toEqual({
      XETRA: { openUtc: "2026-10-26T08:00:00.000Z", closeUtc: "2026-10-26T16:30:00.000Z" },
      NYSE: { openUtc: "2026-10-26T13:30:00.000Z", closeUtc: "2026-10-26T20:00:00.000Z" },
    });
    expect(tradingWindowsUtc("2026-11-02")).toEqual({
      XETRA: { openUtc: "2026-11-02T08:00:00.000Z", closeUtc: "2026-11-02T16:30:00.000Z" },
      NYSE: { openUtc: "2026-11-02T14:30:00.000Z", closeUtc: "2026-11-02T21:00:00.000Z" },
    });
    expect(tradingWindowsLabel("2026-10-26")).toBe("2026-10-26: XETRA 08:00–16:30 UTC, NYSE 13:30–20:00 UTC");
  });
});

describe("IBKR-Kalender", () => {
  it("Feiertag CLOSED: Börse geschlossen", () => {
    getCalendar().update("XETRA", "20261224:CLOSED");
    expect(isExchangeOpen("XETRA", at("2026-12-24T10:00:00Z"))).toBe(false);
    expect(tradingWindowsUtc("2026-12-24").XETRA).toBeNull();
  });

  it("verkürzter Handelstag: Schluss nach Kalender", () => {
    getCalendar().update("NYSE", "20261127:0930-20261127:1300");
    expect(isExchangeOpen("NYSE", at("2026-11-27T17:59:00Z"))).toBe(true);
    expect(isExchangeOpen("NYSE", at("2026-11-27T18:00:00Z"))).toBe(false);
  });

  it("Kalender kann das reguläre Fenster nur verkürzen, nie verlängern", () => {
    getCalendar().update("XETRA", "20261026:0800-20261026:2200");
    expect(isExchangeOpen("XETRA", at("2026-10-26T07:30:00Z"))).toBe(false); // 08:30 Berlin
    expect(isExchangeOpen("XETRA", at("2026-10-26T17:00:00Z"))).toBe(false); // 18:00 Berlin
    expect(isExchangeOpen("XETRA", at("2026-10-26T08:00:00Z"))).toBe(true);
  });
});

describe("exchangeClock", () => {
  it("Minuten seit Öffnung und bis Schluss", () => {
    expect(exchangeClock("XETRA", at("2026-10-26T08:10:00Z"))).toEqual({ open: true, sinceOpen: 10, toClose: 500 });
    expect(exchangeClock("NYSE", at("2026-10-24T15:00:00Z")).open).toBe(false);
  });
});

describe("isMarketSafe: Schutzfenster relativ zur Börsenzeit", () => {
  afterEach(() => vi.useRealTimers());
  const safeAt = async (iso: string) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at(iso));
    const real = await vi.importActual<typeof import("../src/indicators.js")>("../src/indicators.js");
    return real.isMarketSafe();
  };

  it("XETRA Winterzeit: erste 15 min ab 08:00 UTC, letzte 30 min vor 16:30 UTC", async () => {
    expect((await safeAt("2026-10-26T08:05:00Z")).reason).toMatch(/First 15min after EU open/);
    expect((await safeAt("2026-10-26T16:10:00Z")).reason).toMatch(/Last 30min before EU close/);
  });

  it("NYSE Winterzeit: erste 15 min ab 14:30 UTC, letzte 30 min vor 21:00 UTC", async () => {
    expect((await safeAt("2026-11-02T14:35:00Z")).reason).toMatch(/First 15min after US open/);
    expect((await safeAt("2026-11-02T20:45:00Z")).reason).toMatch(/Last 30min before US close/);
  });
});

describe("Scheduler: am Wochenende kein Universe-Build, kein Scan", () => {
  afterEach(() => vi.useRealTimers());

  const tickAt = async (iso: string) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at(iso));
    const um = new UniverseManager({} as any);
    const build = vi.spyOn(um, "buildActiveUniverse").mockResolvedValue({ symbols: [] } as any);
    const scan = vi.spyOn(um, "scanMomentum").mockResolvedValue([]);
    vi.mocked(isMarketSafe).mockClear();
    await (um as any).tick();
    return { build: build.mock.calls.length, safety: vi.mocked(isMarketSafe).mock.calls.length, scan: scan.mock.calls.length };
  };

  it("Sa 24.10.2026 07:00 und 14:00 UTC: nichts", async () => {
    expect(await tickAt("2026-10-24T07:00:00Z")).toEqual({ build: 0, safety: 0, scan: 0 });
    expect(await tickAt("2026-10-24T14:00:00Z")).toEqual({ build: 0, safety: 0, scan: 0 });
  });

  it("So 25.10.2026 15:00 UTC: nichts", async () => {
    expect(await tickAt("2026-10-25T15:00:00Z")).toEqual({ build: 0, safety: 0, scan: 0 });
  });

  it("Mo 26.10.2026 07:30 UTC: Build ja (Handelstag), aber kein Scan vor XETRA 08:00 UTC", async () => {
    expect(await tickAt("2026-10-26T07:30:00Z")).toEqual({ build: 1, safety: 0, scan: 0 });
  });

  it("Mo 26.10.2026 08:20 UTC: Scan-Pfad läuft (Sicherheitsprüfung wird gefragt)", async () => {
    expect((await tickAt("2026-10-26T08:20:00Z")).safety).toBe(1);
  });
});
