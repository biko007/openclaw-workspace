import { describe, it, expect, beforeEach } from "vitest";
import {
  parseLiquidHours,
  formatDateForExchange,
  TradingCalendar,
  getCalendar,
} from "../src/trading-calendar.js";
import { isTradingDay } from "../src/market-hours.js";

describe("parseLiquidHours", () => {
  it("parses a normal trading day (v970+ format with closing date)", () => {
    const result = parseLiquidHours("20260707:0930-20260707:1600");
    expect(result.size).toBe(1);
    const day = result.get("20260707");
    expect(day).toEqual({
      closed: false,
      sessions: [{ openHHMM: "0930", closeHHMM: "1600" }],
    });
  });

  it("parses a CLOSED day", () => {
    const result = parseLiquidHours("20260704:CLOSED");
    expect(result.size).toBe(1);
    const day = result.get("20260704");
    expect(day).toEqual({ closed: true, sessions: [] });
  });

  it("parses a half-day (early close)", () => {
    const result = parseLiquidHours("20261127:0930-20261127:1300");
    const day = result.get("20261127");
    expect(day).toEqual({
      closed: false,
      sessions: [{ openHHMM: "0930", closeHHMM: "1300" }],
    });
  });

  it("parses a multi-day string with normal, closed, and half-day", () => {
    const raw =
      "20260703:0930-20260703:1600;20260704:CLOSED;20260706:0930-20260706:1300;20260707:0930-20260707:1600";
    const result = parseLiquidHours(raw);
    expect(result.size).toBe(4);
    expect(result.get("20260703")?.closed).toBe(false);
    expect(result.get("20260704")?.closed).toBe(true);
    expect(result.get("20260706")?.sessions[0].closeHHMM).toBe("1300");
    expect(result.get("20260707")?.sessions[0].closeHHMM).toBe("1600");
  });

  it("parses legacy format (without closing date)", () => {
    const result = parseLiquidHours("20260703:0930-1600;20260704:CLOSED");
    expect(result.size).toBe(2);
    const day = result.get("20260703");
    expect(day).toEqual({
      closed: false,
      sessions: [{ openHHMM: "0930", closeHHMM: "1600" }],
    });
    expect(result.get("20260704")?.closed).toBe(true);
  });

  it("handles empty/null input", () => {
    expect(parseLiquidHours("").size).toBe(0);
    expect(parseLiquidHours("  ").size).toBe(0);
  });
});

describe("TradingCalendar", () => {
  let cal: TradingCalendar;

  beforeEach(() => {
    cal = new TradingCalendar();
  });

  it("isClosedOn returns true for a holiday", () => {
    cal.update("NYSE", "20260703:0930-20260703:1600;20260704:CLOSED;20260707:0930-20260707:1600");
    expect(cal.isClosedOn("NYSE", "20260704")).toBe(true);
  });

  it("isClosedOn returns false for a normal trading day", () => {
    cal.update("NYSE", "20260703:0930-20260703:1600;20260704:CLOSED;20260707:0930-20260707:1600");
    expect(cal.isClosedOn("NYSE", "20260703")).toBe(false);
  });

  it("isClosedOn returns null for unknown date", () => {
    cal.update("NYSE", "20260703:0930-20260703:1600");
    expect(cal.isClosedOn("NYSE", "20261225")).toBeNull();
  });

  it("isClosedOn returns null for unknown exchange", () => {
    cal.update("NYSE", "20260703:0930-20260703:1600");
    expect(cal.isClosedOn("XETRA", "20260703")).toBeNull();
  });

  it("getSchedule returns full day info", () => {
    cal.update("NYSE", "20261127:0930-20261127:1300");
    const sched = cal.getSchedule("NYSE", "20261127");
    expect(sched).toEqual({
      closed: false,
      sessions: [{ openHHMM: "0930", closeHHMM: "1300" }],
    });
  });
});

describe("formatDateForExchange", () => {
  it("formats date for NYSE (US/Eastern)", () => {
    // 2026-07-04 12:00 UTC → Jul 4 in US/Eastern (UTC-4 in summer)
    const d = new Date("2026-07-04T12:00:00Z");
    const result = formatDateForExchange("NYSE", d);
    expect(result).toBe("20260704");
  });

  it("formats date for XETRA (Europe/Berlin)", () => {
    // 2026-07-04 12:00 UTC → Jul 4 in Berlin (UTC+2 in summer)
    const d = new Date("2026-07-04T12:00:00Z");
    const result = formatDateForExchange("XETRA", d);
    expect(result).toBe("20260704");
  });

  it("handles date boundary correctly for NYSE", () => {
    // 2026-07-05 03:00 UTC → still Jul 4 in US/Eastern (UTC-4)
    const d = new Date("2026-07-05T03:00:00Z");
    const result = formatDateForExchange("NYSE", d);
    expect(result).toBe("20260704");
  });

  it("falls back to UTC for unknown exchange", () => {
    const d = new Date("2026-07-04T12:00:00Z");
    const result = formatDateForExchange("UNKNOWN", d);
    expect(result).toBe("20260704");
  });
});

describe("isTradingDay with calendar", () => {
  beforeEach(() => {
    // Reset the globalThis calendar
    (globalThis as any).__tradingCalendar = new TradingCalendar();
  });

  it("returns false on weekend (regardless of calendar)", () => {
    // 2026-07-04 is a Saturday — wait, let me check...
    // 2026-07-05 is a Sunday
    const sunday = new Date("2026-07-05T12:00:00Z");
    expect(isTradingDay(sunday)).toBe(false);
  });

  it("returns true on weekday when no calendar data (fallback)", () => {
    // 2026-07-06 is a Monday
    const monday = new Date("2026-07-06T12:00:00Z");
    expect(isTradingDay(monday)).toBe(true);
  });

  it("returns false when both exchanges are CLOSED", () => {
    const cal = getCalendar();
    // Dec 25, 2026 is a Friday — Christmas
    cal.update("NYSE", "20261225:CLOSED");
    cal.update("XETRA", "20261225:CLOSED");
    const christmas = new Date("2026-12-25T12:00:00Z");
    expect(isTradingDay(christmas)).toBe(false);
  });

  it("returns true when only NYSE is CLOSED (XETRA open)", () => {
    const cal = getCalendar();
    // Jul 4, 2026 is a Saturday, so let's use a hypothetical weekday holiday
    // Use Jul 3, 2026 (Friday) as a hypothetical NYSE-only holiday
    cal.update("NYSE", "20260703:CLOSED");
    cal.update("XETRA", "20260703:0900-20260703:1730");
    const jul3 = new Date("2026-07-03T12:00:00Z");
    expect(isTradingDay(jul3)).toBe(true);
  });

  it("returns true on a half-day (exchange is open, just shorter)", () => {
    const cal = getCalendar();
    // Black Friday 2026 — Nov 27 is a Friday
    cal.update("NYSE", "20261127:0930-20261127:1300");
    cal.update("XETRA", "20261127:0900-20261127:1730");
    const blackFriday = new Date("2026-11-27T12:00:00Z");
    expect(isTradingDay(blackFriday)).toBe(true);
  });

  it("returns true when only one exchange has data and it is open", () => {
    const cal = getCalendar();
    // Only NYSE data, no XETRA data → XETRA returns null → fallback true
    cal.update("NYSE", "20260706:0930-20260706:1600");
    const monday = new Date("2026-07-06T12:00:00Z");
    expect(isTradingDay(monday)).toBe(true);
  });

  it("returns true when only one exchange has data and it is CLOSED", () => {
    const cal = getCalendar();
    // NYSE CLOSED but no XETRA data → can't confirm both closed → true (conservative)
    cal.update("NYSE", "20260703:CLOSED");
    const jul3 = new Date("2026-07-03T12:00:00Z");
    expect(isTradingDay(jul3)).toBe(true);
  });
});
