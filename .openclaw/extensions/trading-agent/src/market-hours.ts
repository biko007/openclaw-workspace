/**
 * Market hours module — determines whether relevant markets are open.
 * XETRA (DAX): Mo-Fr 09:00–17:30 Europe/Berlin
 * NYSE/NASDAQ: Mo-Fr 15:30–22:00 Europe/Berlin (auto-adjusts for DST)
 * No holiday calendar — holidays treated as open (harmless: scan runs, finds nothing).
 */

const TZ = "Europe/Berlin";

interface TimeSlot {
  label: string;
  openHour: number;
  openMin: number;
  closeHour: number;
  closeMin: number;
}

const MARKETS: TimeSlot[] = [
  { label: "XETRA", openHour: 9, openMin: 0, closeHour: 17, closeMin: 30 },
  { label: "NYSE/NASDAQ", openHour: 15, openMin: 30, closeHour: 22, closeMin: 0 },
];

function getBerlinTime(now?: Date): { hour: number; min: number; dayOfWeek: number } {
  const d = now ?? new Date();
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: TZ,
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
    // Fallback: UTC+2 approximation
    const utcH = d.getUTCHours();
    const utcM = d.getUTCMinutes();
    const berlinH = (utcH + 2) % 24;
    return { hour: berlinH, min: utcM, dayOfWeek: d.getDay() };
  }
}

/**
 * Returns true if at least one relevant market is currently open.
 */
export function isMarketOpen(now?: Date): boolean {
  const { hour, min, dayOfWeek } = getBerlinTime(now);

  // Weekend
  if (dayOfWeek === 0 || dayOfWeek === 6) return false;

  const timeVal = hour * 60 + min;

  for (const m of MARKETS) {
    const open = m.openHour * 60 + m.openMin;
    const close = m.closeHour * 60 + m.closeMin;
    if (timeVal >= open && timeVal < close) return true;
  }

  return false;
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

  const open = isMarketOpen(now);
  const openMarkets: string[] = [];
  const timeVal = hour * 60 + min;
  for (const m of MARKETS) {
    const o = m.openHour * 60 + m.openMin;
    const c = m.closeHour * 60 + m.closeMin;
    if (timeVal >= o && timeVal < c) openMarkets.push(m.label);
  }

  if (open) {
    return `${dayStr} ${timeStr} (Markt offen: ${openMarkets.join(", ")})`;
  }
  return `${dayStr} ${timeStr} (Markt geschlossen)`;
}
