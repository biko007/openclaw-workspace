/**
 * Market hours module — determines whether relevant markets are open.
 * XETRA (DAX): Mo-Fr 09:00–17:30 Europe/Berlin
 * NYSE/NASDAQ: Mo-Fr 09:30–16:00 America/New_York
 * Each exchange is evaluated in its own time zone, so Sommer-/Winterzeit in
 * Europa und den USA (verschiedene Umstellungstage) stimmen automatisch.
 * Holiday calendar from IBKR liquidHours (populated at connect + daily 06:00 UTC).
 *
 * Auftrag Option A (24.10.2026): Executor und Scheduler hatten feste
 * UTC-Fenster ohne Wochentag — Scans, KI-Aufrufe und Orders auch am
 * Wochenende, und ab der Winterzeit eine Stunde vor Börsenöffnung.
 */

import { getCalendar, formatDateForExchange } from "./trading-calendar.js";

export type Exchange = "XETRA" | "NYSE";

interface ExchangeHours {
  label: string;
  tz: string;
  openHour: number;
  openMin: number;
  closeHour: number;
  closeMin: number;
}

const EXCHANGES: Record<Exchange, ExchangeHours> = {
  XETRA: { label: "XETRA", tz: "Europe/Berlin", openHour: 9, openMin: 0, closeHour: 17, closeMin: 30 },
  NYSE: { label: "NYSE/NASDAQ", tz: "America/New_York", openHour: 9, openMin: 30, closeHour: 16, closeMin: 0 },
};

const TZ = "Europe/Berlin";

function getLocalTime(tz: string, now?: Date): { hour: number; min: number; dayOfWeek: number } {
  const d = now ?? new Date();
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
      hour12: false,
    }).formatToParts(d);

    let hour = 0;
    let min = 0;
    let weekday = "";
    for (const p of parts) {
      if (p.type === "hour") hour = parseInt(p.value, 10);
      if (p.type === "minute") min = parseInt(p.value, 10);
      if (p.type === "weekday") weekday = p.value;
    }
    // Intl hour12=false can return 24 for midnight
    if (hour === 24) hour = 0;

    const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const dayOfWeek = dayMap[weekday] ?? d.getDay();

    return { hour, min, dayOfWeek };
  } catch {
    // Fallback: UTC — Wochenende bleibt erkannt, Uhrzeit nur grob
    return { hour: d.getUTCHours(), min: d.getUTCMinutes(), dayOfWeek: d.getUTCDay() };
  }
}

function getBerlinTime(now?: Date): { hour: number; min: number; dayOfWeek: number } {
  return getLocalTime(TZ, now);
}

/**
 * Today's session of an exchange in local minutes since midnight, or null if
 * the exchange does not trade that day (weekend, IBKR holiday).
 * The IBKR calendar may only narrow the regular hours (early close), never
 * widen them — its session times come from the SMART contract and are not
 * guaranteed to be the exchange's regular session.
 */
function sessionMinutes(ex: Exchange, now: Date): { open: number; close: number } | null {
  const h = EXCHANGES[ex];
  const { dayOfWeek } = getLocalTime(h.tz, now);
  if (dayOfWeek === 0 || dayOfWeek === 6) return null;

  let open = h.openHour * 60 + h.openMin;
  let close = h.closeHour * 60 + h.closeMin;

  const schedule = getCalendar().getSchedule(ex, formatDateForExchange(ex, now));
  if (schedule?.closed) return null;
  if (schedule && schedule.sessions.length > 0) {
    const toMin = (hhmm: string) => parseInt(hhmm.slice(0, 2), 10) * 60 + parseInt(hhmm.slice(2), 10);
    const calOpen = Math.min(...schedule.sessions.map((s) => toMin(s.openHHMM)));
    const calClose = Math.max(...schedule.sessions.map((s) => toMin(s.closeHHMM)));
    open = Math.max(open, calOpen);
    close = Math.min(close, calClose);
    if (close <= open) return null;
  }
  return { open, close };
}

/**
 * Clock of one exchange: open now, minutes since open, minutes until close.
 */
export function exchangeClock(ex: Exchange, now?: Date): { open: boolean; sinceOpen: number; toClose: number } {
  const d = now ?? new Date();
  const session = sessionMinutes(ex, d);
  if (!session) return { open: false, sinceOpen: -1, toClose: -1 };
  const { hour, min } = getLocalTime(EXCHANGES[ex].tz, d);
  const t = hour * 60 + min;
  const open = t >= session.open && t < session.close;
  return { open, sinceOpen: t - session.open, toClose: session.close - t };
}

/**
 * Returns true if the given exchange is open right now (weekday, holiday,
 * local regular hours incl. DST).
 */
export function isExchangeOpen(ex: Exchange, now?: Date): boolean {
  return exchangeClock(ex, now).open;
}

/** Offset of a time zone to UTC in minutes at the given instant. */
function tzOffsetMin(tz: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(at);
  const get = (t: string) => parseInt(parts.find((p) => p.type === t)?.value ?? "0", 10);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"));
  return Math.round((asUtc - at.getTime()) / 60_000);
}

/** Local wall-clock time of a date (YYYY-MM-DD) in tz → UTC instant. */
function zonedToUtc(dateStr: string, minutes: number, tz: string): Date {
  const [y, m, d] = dateStr.split("-").map((x) => parseInt(x, 10));
  const guess = Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60);
  let utc = guess - tzOffsetMin(tz, new Date(guess)) * 60_000;
  // Second pass for the hours around a DST switch
  utc = guess - tzOffsetMin(tz, new Date(utc)) * 60_000;
  return new Date(utc);
}

/**
 * Trading windows of both exchanges for a calendar date (YYYY-MM-DD) in UTC.
 * null = no session that day. For log and /market-hours (verification).
 */
export function tradingWindowsUtc(dateStr: string): Record<Exchange, { openUtc: string; closeUtc: string } | null> {
  const out = {} as Record<Exchange, { openUtc: string; closeUtc: string } | null>;
  for (const ex of Object.keys(EXCHANGES) as Exchange[]) {
    const tz = EXCHANGES[ex].tz;
    // Noon local time of that date — safely inside the day for weekday/calendar lookup
    const noon = zonedToUtc(dateStr, 12 * 60, tz);
    const session = sessionMinutes(ex, noon);
    out[ex] = session
      ? {
          openUtc: zonedToUtc(dateStr, session.open, tz).toISOString(),
          closeUtc: zonedToUtc(dateStr, session.close, tz).toISOString(),
        }
      : null;
  }
  return out;
}

/** One log line with today's windows in UTC, e.g. for start and daily refresh. */
export function tradingWindowsLabel(dateStr: string): string {
  const w = tradingWindowsUtc(dateStr);
  const fmt = (x: { openUtc: string; closeUtc: string } | null) =>
    x ? `${x.openUtc.slice(11, 16)}–${x.closeUtc.slice(11, 16)} UTC` : "geschlossen";
  return `${dateStr}: XETRA ${fmt(w.XETRA)}, NYSE ${fmt(w.NYSE)}`;
}

/**
 * Returns true if at least one relevant market is currently open.
 */
export function isMarketOpen(now?: Date): boolean {
  return isExchangeOpen("XETRA", now) || isExchangeOpen("NYSE", now);
}

/**
 * Returns a human-readable market status string for logging.
 */
export function marketStatusLabel(now?: Date): string {
  const { hour, min, dayOfWeek } = getBerlinTime(now);
  const timeStr = `${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
  const days = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
  const dayStr = days[dayOfWeek] || "?";

  if (dayOfWeek === 0 || dayOfWeek === 6) {
    return `${dayStr} ${timeStr} (Wochenende — Markt geschlossen)`;
  }

  const openMarkets = (Object.keys(EXCHANGES) as Exchange[])
    .filter((ex) => isExchangeOpen(ex, now))
    .map((ex) => EXCHANGES[ex].label);

  if (openMarkets.length > 0) {
    return `${dayStr} ${timeStr} (Markt offen: ${openMarkets.join(", ")})`;
  }
  return `${dayStr} ${timeStr} (Markt geschlossen)`;
}

/**
 * Returns true if at least one relevant market trades today.
 * Checks IBKR holiday calendar first; falls back to weekday check if no data.
 */
export function isTradingDay(now?: Date): boolean {
  const d = now ?? new Date();
  const { dayOfWeek } = getBerlinTime(d);

  // Weekend — independent of calendar
  if (dayOfWeek === 0 || dayOfWeek === 6) return false;

  // Calendar check: both exchanges CLOSED → not a trading day
  const cal = getCalendar();
  const nyseDate = formatDateForExchange("NYSE", d);
  const xetraDate = formatDateForExchange("XETRA", d);
  const nyseClosed = cal.isClosedOn("NYSE", nyseDate);
  const xetraClosed = cal.isClosedOn("XETRA", xetraDate);

  // Only skip if BOTH are known AND BOTH are CLOSED
  if (nyseClosed === true && xetraClosed === true) return false;

  // At least one exchange open, or no calendar data → treat as trading day
  return true;
}
