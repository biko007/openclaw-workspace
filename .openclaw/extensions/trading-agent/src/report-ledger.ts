/**
 * report-ledger — Meldungsdisziplin (2026-09-18)
 *
 * Die täglichen Prüfungen (Health-Check 08:00 UTC, Trading-Report 18:00 UTC)
 * laufen unverändert weiter. Ihr Ergebnis wird hier persistiert statt
 * bedingungslos nach Telegram geschickt: Telegram nur noch bei Abweichung.
 * Die Wochen-Zusammenfassung (Mo 08:00 Berlin) holt sich executive-agent
 * über GET /weekly-stats.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";

const LEDGER_FILE = join(
  process.env.HOME || "/home/biko",
  ".openclaw/workspace/artifacts/personal/trading/report-ledger.json",
);

const RETENTION_DAYS = 60;

export interface HealthEntry {
  ok: boolean;
  deviations: string[];
  connected: boolean;
  reconnectAttempts: number;
  schedulerRunning: boolean;
  watchdogFailures: number;
}

export interface ReportEntry {
  ok: boolean;
  deviations: string[];
  trades: number;
  exits: number;
  dailyPnl: number;
  netLiquidation: number;
  buyDecisions: number;
}

export interface LedgerDay {
  date: string; // YYYY-MM-DD (UTC)
  health?: HealthEntry;
  report?: ReportEntry;
}

export interface WeeklyStats {
  from: string;
  to: string;
  healthGreen: number;
  healthTotal: number;
  trades: number;
  exits: number;
  pnl: number;
  netLiquidation: number | null;
  deviations: string[]; // "YYYY-MM-DD: <text>"
}

// ── Abweichungs-Erkennung (pure, testbar) ──────────────────────────────────

export interface HealthInputs {
  connected: boolean;
  reconnectAttempts: number;
  schedulerRunning: boolean;
  watchdogFailures: number;
}

/** Abweichungen des täglichen Trading-Health-Checks. Leer = alles OK. */
export function healthDeviations(i: HealthInputs): string[] {
  const out: string[] = [];
  if (!i.connected) out.push("IBKR disconnected");
  if (i.reconnectAttempts > 0) out.push(`Reconnect-Versuche: ${i.reconnectAttempts}`);
  if (!i.schedulerRunning) out.push("Universe-Scheduler gestoppt");
  if (i.watchdogFailures > 0) out.push(`Watchdog rot (${i.watchdogFailures} Failures)`);
  return out;
}

export interface ReportInputs {
  tradingLocked: boolean;
  guardianLocked: boolean;
  connected: boolean;
  reconnectAttempts: number;
  activeAlerts: string[];
  positionCount: number;
  protectedCount: number;
  hasClassification: boolean;
  buyDecisions: number;
  openedToday: number;
}

/** Abweichungen des täglichen Trading-Reports. Leer = alles OK. */
export function reportDeviations(i: ReportInputs): string[] {
  const out: string[] = [];
  if (i.tradingLocked) out.push("Trading gesperrt (Event-Log korrupt)");
  if (i.guardianLocked) out.push("Guardian gesperrt");
  if (!i.connected) out.push("IBKR disconnected");
  if (i.reconnectAttempts > 0) out.push(`Reconnect-Versuche: ${i.reconnectAttempts}`);
  if (i.activeAlerts.length > 0) out.push(`Offene Alerts: ${i.activeAlerts.join(", ")}`);
  if (i.hasClassification) {
    const uncovered = i.positionCount - i.protectedCount;
    if (uncovered > 0) out.push(`${uncovered} offene Position(en) ohne Exit-Coverage`);
  }
  // Anomalie: KI entscheidet BUY, es wird aber keine Position eröffnet
  // (bekannter 3-BUY/0-Eröffnungen-Fall)
  if (i.buyDecisions > 0 && i.openedToday === 0) {
    out.push(`Anomalie: ${i.buyDecisions} BUY-Entscheidung(en), 0 Eröffnungen`);
  }
  return out;
}

function loadLedger(): LedgerDay[] {
  try {
    const raw = JSON.parse(readFileSync(LEDGER_FILE, "utf-8"));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function saveLedger(days: LedgerDay[]): void {
  const trimmed = days
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-RETENTION_DAYS);
  mkdirSync(dirname(LEDGER_FILE), { recursive: true });
  const tmp = `${LEDGER_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(trimmed, null, 2), "utf-8");
  renameSync(tmp, LEDGER_FILE);
}

export function recordHealth(date: string, entry: HealthEntry): void {
  const days = loadLedger();
  const day = days.find((d) => d.date === date);
  if (day) day.health = entry;
  else days.push({ date, health: entry });
  saveLedger(days);
}

export function recordReport(date: string, entry: ReportEntry): void {
  const days = loadLedger();
  const day = days.find((d) => d.date === date);
  if (day) day.report = entry;
  else days.push({ date, report: entry });
  saveLedger(days);
}

/** Aggregiert die letzten 7 Tage (inkl. `todayISO`). */
export function weeklyStats(todayISO?: string): WeeklyStats {
  const to = todayISO ?? new Date().toISOString().slice(0, 10);
  const from = new Date(new Date(`${to}T00:00:00Z`).getTime() - 6 * 86_400_000)
    .toISOString()
    .slice(0, 10);

  const window = loadLedger().filter((d) => d.date >= from && d.date <= to);

  let healthGreen = 0;
  let healthTotal = 0;
  let trades = 0;
  let exits = 0;
  let pnl = 0;
  let netLiquidation: number | null = null;
  const deviations: string[] = [];

  for (const d of window.sort((a, b) => a.date.localeCompare(b.date))) {
    if (d.health) {
      healthTotal++;
      if (d.health.ok) healthGreen++;
      for (const dev of d.health.deviations) deviations.push(`${d.date}: ${dev}`);
    }
    if (d.report) {
      trades += d.report.trades;
      exits += d.report.exits;
      pnl += d.report.dailyPnl;
      if (Number.isFinite(d.report.netLiquidation)) netLiquidation = d.report.netLiquidation;
      for (const dev of d.report.deviations) deviations.push(`${d.date}: ${dev}`);
    }
  }

  return { from, to, healthGreen, healthTotal, trades, exits, pnl, netLiquidation, deviations };
}
