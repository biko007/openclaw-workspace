/**
 * Trading calendar — parses IBKR liquidHours/tradingHours into a day-level
 * schedule and provides synchronous holiday lookups for isTradingDay().
 *
 * Cache is per-exchange, stored in globalThis. Fail-safe: missing data
 * returns null (caller falls back to weekday check).
 */

export interface DaySchedule {
  closed: boolean;
  sessions: { openHHMM: string; closeHHMM: string }[];
}

interface ExchangeCalendar {
  days: Map<string, DaySchedule>;
  updatedAt: number; // Date.now() at last update
}

const EXCHANGE_TZ: Record<string, string> = {
  NYSE: "America/New_York",
  XETRA: "Europe/Berlin",
};

/** TTL for cached calendar data (25 hours). */
const CALENDAR_TTL_MS = 25 * 60 * 60 * 1000;

/**
 * Parse IBKR liquidHours/tradingHours string into per-day schedules.
 *
 * TWS v970+ format (with closing date):
 *   20260703:0930-20260703:1600;20260704:CLOSED;20260707:0930-20260707:1600
 *
 * Legacy format (without closing date, comma for multi-session):
 *   20260703:0930-1600,1830-2200;20260704:CLOSED
 */
export function parseLiquidHours(raw: string): Map<string, DaySchedule> {
  const result = new Map<string, DaySchedule>();
  if (!raw || !raw.trim()) return result;

  const segments = raw.split(";");
  for (const seg of segments) {
    const trimmed = seg.trim();
    if (!trimmed) continue;

    // CLOSED day: "20260704:CLOSED"
    if (trimmed.endsWith(":CLOSED")) {
      const dateStr = trimmed.slice(0, 8);
      if (/^\d{8}$/.test(dateStr)) {
        result.set(dateStr, { closed: true, sessions: [] });
      }
      continue;
    }

    // Session day — may contain commas for multiple sessions
    // v970+: "20260703:0930-20260703:1600"
    // Legacy: "20260703:0930-1600" or "20260703:0930-1600,1830-2200"
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx < 0) continue;

    const dateStr = trimmed.slice(0, 8);
    if (!/^\d{8}$/.test(dateStr)) continue;

    const rest = trimmed.slice(colonIdx + 1);
    const sessionParts = rest.split(",");
    const sessions: { openHHMM: string; closeHHMM: string }[] = [];

    for (const sp of sessionParts) {
      const dashIdx = sp.indexOf("-");
      if (dashIdx < 0) continue;

      const openPart = sp.slice(0, dashIdx).trim();
      const closePart = sp.slice(dashIdx + 1).trim();

      // v970+: openPart = "0930" or "20260703:0930"; closePart = "20260703:1600" or "1600"
      const openHHMM = openPart.length > 4 ? openPart.slice(-4) : openPart;
      const closeHHMM = closePart.length > 4 ? closePart.slice(-4) : closePart;

      if (/^\d{4}$/.test(openHHMM) && /^\d{4}$/.test(closeHHMM)) {
        sessions.push({ openHHMM, closeHHMM });
      }
    }

    result.set(dateStr, { closed: false, sessions });
  }

  return result;
}

/**
 * Format a Date as YYYYMMDD in the given exchange's local timezone.
 */
export function formatDateForExchange(exchange: string, now: Date): string {
  const tz = EXCHANGE_TZ[exchange];
  if (!tz) {
    // Unknown exchange — use UTC
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, "0");
    const d = String(now.getUTCDate()).padStart(2, "0");
    return `${y}${m}${d}`;
  }

  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);

    let year = "";
    let month = "";
    let day = "";
    for (const p of parts) {
      if (p.type === "year") year = p.value;
      if (p.type === "month") month = p.value;
      if (p.type === "day") day = p.value;
    }
    return `${year}${month}${day}`;
  } catch {
    // Fallback: UTC
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, "0");
    const d = String(now.getUTCDate()).padStart(2, "0");
    return `${y}${m}${d}`;
  }
}

export class TradingCalendar {
  private exchanges = new Map<string, ExchangeCalendar>();

  /** Update calendar data for an exchange from IBKR liquidHours string. */
  update(exchange: string, liquidHoursRaw: string): void {
    const days = parseLiquidHours(liquidHoursRaw);
    this.exchanges.set(exchange, { days, updatedAt: Date.now() });
  }

  /**
   * Check if an exchange is closed on a given date (YYYYMMDD).
   * Returns true if CLOSED, false if open, null if no data (or stale).
   */
  isClosedOn(exchange: string, dateStr: string): boolean | null {
    const cal = this.exchanges.get(exchange);
    if (!cal) return null;

    // Stale check — data older than TTL
    if (Date.now() - cal.updatedAt > CALENDAR_TTL_MS) return null;

    const schedule = cal.days.get(dateStr);
    if (!schedule) return null;

    return schedule.closed;
  }

  /** Get the full schedule for a date. */
  getSchedule(exchange: string, dateStr: string): DaySchedule | null {
    const cal = this.exchanges.get(exchange);
    if (!cal) return null;
    if (Date.now() - cal.updatedAt > CALENDAR_TTL_MS) return null;
    return cal.days.get(dateStr) ?? null;
  }
}

/** Singleton accessor via globalThis. */
export function getCalendar(): TradingCalendar {
  const g = globalThis as any;
  if (!g.__tradingCalendar) {
    g.__tradingCalendar = new TradingCalendar();
  }
  return g.__tradingCalendar;
}
