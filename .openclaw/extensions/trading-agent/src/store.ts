import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { Position } from "./ibkr.js";

const BASE = join(
  process.env.HOME || "/home/biko",
  ".openclaw/workspace/artifacts/personal/trading",
);

export interface TradingStatus {
  mode: 1 | 2 | 3;
  connected: boolean;
  paperMode: boolean;
  account: string;
  positions: Position[];
  dailyPnl: number;
  unrealizedPnl: number;
  realizedPnl: number;
  netLiquidation: number;
  cashBalance: number;
  timestamp: string;
}

export interface WatchlistItem {
  symbol: string;
  exchange: string;
  currency: string;
  addedAt: string;
  lastPrice?: number;
  lastUpdate?: string;
}

export interface StrategyEntry {
  enabled: boolean;
  maxPositionSizePercent: number;
  stopLossPercent: number;
}

export interface StrategyConfig {
  momentum: StrategyEntry;
  meanReversion: StrategyEntry;
  newsTrading: StrategyEntry;
  maxOpenPositions: number;
  dailyLossLimit: { enabled: boolean; maxLossPercent: number };
}

export interface OrderRecord {
  id: string;
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  price: number;
  status: string;           // Submitted, Filled, Cancelled, Inactive, PreSubmitted, Stopped, TargetHit
  timestamp: string;
  fillPrice?: number;
  fillTimestamp?: string;
  parentOrderId?: string;   // links stop/target to their entry order
  orderType?: string;       // LMT, STP, MKT
  ocaGroup?: string;        // OCA group name for linked stop/target
}

export interface PerformanceEntry {
  date: string;
  dailyPnl: number;
  realizedPnl: number;
  unrealizedPnl: number;
  netLiquidation: number;
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(path: string, data: unknown): void {
  ensureDir(join(path, ".."));
  // Atomic write: write to temp file then rename to prevent corruption on crash
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  renameSync(tmp, path);
}

// ── Status ──

const STATUS_PATH = join(BASE, "status.json");

export function loadStatus(): TradingStatus {
  const defaults = defaultStatus();
  const loaded = readJson<Partial<TradingStatus>>(STATUS_PATH, {});
  const merged = { ...defaults, ...loaded };
  // Validate mode
  if (![1, 2, 3].includes(merged.mode)) merged.mode = 1;
  console.log(`[trading-agent] loadStatus: mode=${merged.mode} from ${existsSync(STATUS_PATH) ? 'status.json' : 'defaults'}`);
  return merged as TradingStatus;
}

export function saveStatus(status: TradingStatus): void {
  writeJson(STATUS_PATH, status);
}

export function defaultStatus(): TradingStatus {
  return {
    mode: 1,
    connected: false,
    paperMode: true,
    account: "",
    positions: [],
    dailyPnl: 0,
    unrealizedPnl: 0,
    realizedPnl: 0,
    netLiquidation: 0,
    cashBalance: 0,
    timestamp: new Date().toISOString(),
  };
}

// ── Watchlist ──

const WATCHLIST_PATH = join(BASE, "watchlist.json");

export function loadWatchlist(): WatchlistItem[] {
  return readJson<WatchlistItem[]>(WATCHLIST_PATH, []);
}

export function saveWatchlist(items: WatchlistItem[]): void {
  writeJson(WATCHLIST_PATH, items);
}

export function addToWatchlist(item: Omit<WatchlistItem, "addedAt">): WatchlistItem[] {
  const list = loadWatchlist();
  if (list.some((w) => w.symbol === item.symbol)) return list;
  const entry: WatchlistItem = { ...item, addedAt: new Date().toISOString() };
  list.push(entry);
  saveWatchlist(list);
  return list;
}

export function removeFromWatchlist(symbol: string): WatchlistItem[] {
  const list = loadWatchlist().filter((w) => w.symbol !== symbol);
  saveWatchlist(list);
  return list;
}

// ── Strategies ──

const STRATEGIES_PATH = join(BASE, "strategies.json");

const DEFAULT_STRATEGIES: StrategyConfig = {
  momentum: { enabled: true, maxPositionSizePercent: 20, stopLossPercent: 3 },
  meanReversion: { enabled: true, maxPositionSizePercent: 20, stopLossPercent: 3 },
  newsTrading: { enabled: true, maxPositionSizePercent: 20, stopLossPercent: 3 },
  maxOpenPositions: 10,
  dailyLossLimit: { enabled: false, maxLossPercent: 5 },
};

export function loadStrategies(): StrategyConfig {
  return readJson<StrategyConfig>(STRATEGIES_PATH, DEFAULT_STRATEGIES);
}

export function saveStrategies(config: StrategyConfig): void {
  writeJson(STRATEGIES_PATH, config);
}

// ── Orders ──

const ORDERS_PATH = join(BASE, "orders.jsonl");

export function appendOrder(order: OrderRecord): void {
  ensureDir(BASE);
  appendFileSync(ORDERS_PATH, JSON.stringify(order) + "\n", "utf8");
}

export function loadOrders(): OrderRecord[] {
  try {
    const lines = readFileSync(ORDERS_PATH, "utf8").trim().split("\n").filter(Boolean);
    return lines.map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

export function updateOrder(id: string, updates: Partial<OrderRecord>): void {
  const orders = loadOrders();
  const idx = orders.findIndex((o) => o.id === id);
  if (idx === -1) return;
  orders[idx] = { ...orders[idx], ...updates };
  ensureDir(BASE);
  const tmp = ORDERS_PATH + ".tmp";
  writeFileSync(tmp, orders.map((o) => JSON.stringify(o)).join("\n") + "\n", "utf8");
  renameSync(tmp, ORDERS_PATH);
}

// ── Performance ──

function perfPath(year: number, month: number): string {
  return join(BASE, "performance", `${year}-${String(month).padStart(2, "0")}.json`);
}

export function loadPerformance(year: number, month: number): PerformanceEntry[] {
  return readJson<PerformanceEntry[]>(perfPath(year, month), []);
}

export function savePerformance(
  year: number,
  month: number,
  entries: PerformanceEntry[],
): void {
  writeJson(perfPath(year, month), entries);
}

export function recordDailyPerformance(status: TradingStatus): void {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const dateStr = now.toISOString().slice(0, 10);
  const entries = loadPerformance(year, month);
  const existing = entries.findIndex((e) => e.date === dateStr);
  const entry: PerformanceEntry = {
    date: dateStr,
    dailyPnl: status.dailyPnl,
    realizedPnl: status.realizedPnl,
    unrealizedPnl: status.unrealizedPnl,
    netLiquidation: status.netLiquidation,
  };
  if (existing >= 0) {
    entries[existing] = entry;
  } else {
    entries.push(entry);
  }
  savePerformance(year, month, entries);
}

// ── Universe ──

export interface UniverseSymbol {
  symbol: string;
  exchange: string;
  currency: string;
  marketCap: number;
  avgVolume: number;
  sector?: string;
  index: string;
}

export interface UniverseConfig {
  indices: Record<string, { enabled: boolean; exchange: string; currency: string }>;
  sectors: Record<string, boolean>;
  liquidityFilter: { minAvgVolume: number; minMarketCap: number; maxSpreadPercent: number };
  maxUniverseSize: number;
}

export interface ScanResult {
  symbol: string;
  signal: string;
  strength: number;
  timestamp: string;
}

export interface UniverseData {
  symbols: UniverseSymbol[];
  lastBuild: string;
  totalScanned: number;
}

const UNIVERSE_PATH = join(BASE, "universe.json");
const UNIVERSE_CONFIG_PATH = join(BASE, "universe-config.json");
const SCAN_RESULTS_PATH = join(BASE, "scan-results.jsonl");

const DEFAULT_UNIVERSE_CONFIG: UniverseConfig = {
  indices: {
    DAX40: { enabled: true, exchange: "IBIS", currency: "EUR" },
    MDAX: { enabled: false, exchange: "IBIS", currency: "EUR" },
    SP500: { enabled: true, exchange: "SMART", currency: "USD" },
    NASDAQ100: { enabled: false, exchange: "SMART", currency: "USD" },
  },
  sectors: {},
  liquidityFilter: {
    minAvgVolume: 100_000,
    minMarketCap: 1_000_000_000,
    maxSpreadPercent: 1.0,
  },
  maxUniverseSize: 150,
};

export function loadUniverse(): UniverseData {
  return readJson<UniverseData>(UNIVERSE_PATH, { symbols: [], lastBuild: "", totalScanned: 0 });
}

export function saveUniverse(data: UniverseData): void {
  writeJson(UNIVERSE_PATH, data);
}

export function loadUniverseConfig(): UniverseConfig {
  return readJson<UniverseConfig>(UNIVERSE_CONFIG_PATH, DEFAULT_UNIVERSE_CONFIG);
}

export function saveUniverseConfig(config: UniverseConfig): void {
  writeJson(UNIVERSE_CONFIG_PATH, config);
}

export function appendScanResult(result: ScanResult): void {
  ensureDir(BASE);
  appendFileSync(SCAN_RESULTS_PATH, JSON.stringify(result) + "\n", "utf8");
}

export function loadRecentScanResults(limit = 50): ScanResult[] {
  try {
    const lines = readFileSync(SCAN_RESULTS_PATH, "utf8").trim().split("\n").filter(Boolean);
    return lines.slice(-limit).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

export function formatUniverseText(data: UniverseData): string {
  if (data.symbols.length === 0) return "Universum ist leer. Noch kein Scan durchgeführt.";
  const byIndex: Record<string, number> = {};
  for (const s of data.symbols) {
    byIndex[s.index] = (byIndex[s.index] || 0) + 1;
  }
  const indexLines = Object.entries(byIndex).map(([idx, cnt]) => `  ${idx}: ${cnt}`);
  return [
    `🌐 *Aktives Universum*`,
    ``,
    `Gesamt: ${data.symbols.length} Symbole`,
    ...indexLines,
    ``,
    `Letzter Build: ${data.lastBuild || "—"}`,
  ].join("\n");
}

export function formatScanResultsText(results: ScanResult[]): string {
  if (results.length === 0) return "Keine Scan-Ergebnisse vorhanden.";
  const lines = results.slice(-10).map(
    (r) => `${r.symbol} | ${r.signal} | Stärke: ${r.strength.toFixed(1)} | ${r.timestamp.slice(11, 19)}`,
  );
  return ["📡 *Scan-Ergebnisse*", "", ...lines].join("\n");
}

// ── Formatters ──

function fmtNum(n: number, decimals = 2): string {
  return n.toLocaleString("de-DE", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function pnlSign(n: number): string {
  return n >= 0 ? `+${fmtNum(n)}` : fmtNum(n);
}

export function formatStatusText(s: TradingStatus): string {
  const modeLabel = s.mode === 1 ? "Monitoring" : s.mode === 2 ? "Semi-Auto" : "Full-Auto";
  return [
    `📈 *Trading Status*`,
    ``,
    `Modus: ${s.mode} — ${modeLabel}`,
    `Verbindung: ${s.connected ? "Verbunden" : "Nicht verbunden"}`,
    `Paper-Modus: ${s.paperMode ? "Ja" : "Nein"}`,
    `Konto: ${s.account || "—"}`,
    ``,
    `Net Liquidation: ${fmtNum(s.netLiquidation)} $`,
    `Cash: ${fmtNum(s.cashBalance)} $`,
    `Tages-P&L: ${pnlSign(s.dailyPnl)} $`,
    `Unrealisiert P&L: ${pnlSign(s.unrealizedPnl)} $`,
    `Realisiert P&L: ${pnlSign(s.realizedPnl)} $`,
    ``,
    `Positionen: ${s.positions.length}`,
    `Stand: ${s.timestamp}`,
  ].join("\n");
}

export function formatPositionsText(positions: Position[]): string {
  if (positions.length === 0) return "Keine offenen Positionen.";
  const lines = positions.map((p) =>
    `${p.symbol} | ${p.quantity} @ ${fmtNum(p.avgCost)} | Markt: ${fmtNum(p.marketPrice)} | P&L: ${pnlSign(p.unrealizedPnl)}`,
  );
  return ["📊 *Positionen*", "", ...lines].join("\n");
}

export function formatWatchlistText(items: WatchlistItem[]): string {
  if (items.length === 0) return "Watchlist ist leer.";
  const lines = items.map(
    (w) =>
      `${w.symbol} (${w.exchange}/${w.currency})${w.lastPrice ? ` — ${fmtNum(w.lastPrice)}` : ""}`,
  );
  return ["👁 *Watchlist*", "", ...lines].join("\n");
}

export function formatPerformanceText(): string {
  const now = new Date();
  const entries = loadPerformance(now.getFullYear(), now.getMonth() + 1);
  if (entries.length === 0) return "Keine Performance-Daten für diesen Monat.";

  const today = entries[entries.length - 1];
  const weekAgo = new Date(now);
  weekAgo.setDate(weekAgo.getDate() - 7);
  const weekEntries = entries.filter((e) => e.date >= weekAgo.toISOString().slice(0, 10));
  const weekPnl = weekEntries.reduce((sum, e) => sum + e.dailyPnl, 0);
  const monthPnl = entries.reduce((sum, e) => sum + e.dailyPnl, 0);

  return [
    `📊 *Performance*`,
    ``,
    `Heute: ${pnlSign(today.dailyPnl)} $`,
    `Woche (${weekEntries.length}d): ${pnlSign(weekPnl)} $`,
    `Monat (${entries.length}d): ${pnlSign(monthPnl)} $`,
    `Net Liquidation: ${fmtNum(today.netLiquidation)} $`,
  ].join("\n");
}
