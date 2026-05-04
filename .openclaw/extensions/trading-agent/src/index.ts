import { readFileSync } from "node:fs";
import { join } from "node:path";
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(execCb);
import express from "express";
import YahooFinance from "yahoo-finance2";
import { IBKRConnection, type Position } from "./ibkr.js";
import { UniverseManager } from "./universe-manager.js";
import { OrderExecutor } from "./executor.js";
import {
  refreshEarningsCache,
  getEarningsToday,
  getBlockedSymbols,
  getPostEarningsSymbols,
  daysUntilEarnings,
  hasEarningsSoon,
} from "./earnings-calendar.js";
import {
  loadStatus,
  saveStatus,
  defaultStatus,
  loadWatchlist,
  addToWatchlist,
  removeFromWatchlist,
  loadStrategies,
  loadOrders,
  loadPerformance,
  recordDailyPerformance,
  loadUniverse,
  loadUniverseConfig,
  saveUniverseConfig,
  loadRecentScanResults,
  loadRecentDecisions,
  loadEarningsCache,
  type TradingStatus,
  type OrderRecord,
} from "./store.js";

const PORT = 18793;
const BIND = "127.0.0.1";
const POLL_INTERVAL = 30_000;

// ── Telegram notification ──

function loadTelegramConfig(): { botToken: string; chatId: string } {
  try {
    const cfgPath = join(process.env.HOME || "/home/biko", ".openclaw/openclaw.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    const botToken = cfg?.channels?.telegram?.botToken || "";
    // Chat ID from health settings or env
    const chatId = process.env.TELEGRAM_CHAT_ID || "133260792";
    return { botToken, chatId };
  } catch {
    return { botToken: "", chatId: "" };
  }
}

const telegramCfg = loadTelegramConfig();

async function sendTelegramNotification(text: string): Promise<void> {
  if (!telegramCfg.botToken || !telegramCfg.chatId) {
    console.log("[trading-agent] No Telegram config, notification skipped");
    return;
  }
  try {
    const resp = await fetch(`https://api.telegram.org/bot${telegramCfg.botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: telegramCfg.chatId,
        text,
        parse_mode: "Markdown",
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      console.log(`[trading-agent] Telegram send failed: ${resp.status}`);
    }
  } catch (e) {
    console.log("[trading-agent] Telegram error:", e instanceof Error ? e.message : e);
  }
}

// ── Setup ──

const ibkr = new IBKRConnection();
const universeManager = new UniverseManager(ibkr);
const executor = new OrderExecutor(ibkr, () => currentStatus, sendTelegramNotification);
let currentStatus: TradingStatus = loadStatus();
let pollTimer: ReturnType<typeof setInterval> | null = null;
let previousPositionSymbols = new Map<string, Position>(); // track for close detection
let lastReportDay = -1; // track daily report
let lastHealthCheckDay = -1; // track daily health check
let lastEarningsRefreshDay = -1; // track daily earnings cache refresh

// ── Watchdog state ──
const WATCHDOG_INTERVAL = 5 * 60 * 1000; // 5 minutes
let watchdogTimer: ReturnType<typeof setInterval> | null = null;
let consecutiveWatchdogFailures = 0;
let lastGatewayRestart = 0; // timestamp ms
const GATEWAY_RESTART_COOLDOWN = 60 * 60 * 1000; // 1 hour

// ── Yahoo Finance for position pricing ──

const yahooFinance = new YahooFinance({
  validation: { logErrors: false },
  suppressNotices: ["yahooSurvey"],
});

async function enrichPositionsWithPrices(positions: Position[]): Promise<Position[]> {
  if (positions.length === 0) return positions;

  // Build yahoo tickers
  const universe = loadUniverse();
  const tickerMap = new Map<string, string>(); // yahoo ticker → original symbol
  for (const p of positions) {
    const uSym = universe.symbols.find((s) => s.symbol === p.symbol);
    const ticker = uSym?.currency === "EUR" ? `${p.symbol}.DE` : p.symbol;
    tickerMap.set(ticker, p.symbol);
  }

  const tickers = Array.from(tickerMap.keys());
  try {
    const results: any = await yahooFinance.quote(tickers);
    const arr: any[] = Array.isArray(results) ? results : [results];
    const priceMap = new Map<string, number>();
    for (const q of arr) {
      if (!q?.symbol) continue;
      const origSymbol = tickerMap.get(q.symbol) || q.symbol.replace(/\.DE$/, "");
      const price: number = q.regularMarketPrice ?? 0;
      if (price > 0) priceMap.set(origSymbol, price);
    }

    return positions.map((p) => {
      const mktPrice = priceMap.get(p.symbol);
      if (mktPrice && mktPrice > 0) {
        return {
          ...p,
          marketPrice: mktPrice,
          marketValue: mktPrice * p.quantity,
          unrealizedPnl: (mktPrice - p.avgCost) * p.quantity,
        };
      }
      return p;
    });
  } catch (e) {
    console.log("[trading-agent] Yahoo price enrichment error:", e instanceof Error ? e.message : e);
    return positions;
  }
}

// ── Polling ──

async function pollIBKR(): Promise<void> {
  const connected = ibkr.isConnected();
  let positions = connected ? await ibkr.reqPositions() : currentStatus.positions;
  const account = connected ? await ibkr.reqAccountSummary() : null;

  // Enrich positions with Yahoo Finance prices if IBKR returns zero prices
  const needsEnrichment = positions.length > 0 && positions.some((p) => p.marketPrice === 0);
  if (needsEnrichment) {
    positions = await enrichPositionsWithPrices(positions);
  }

  const hasFreshAccount = !!account?.received;
  const suspiciousZeroSnapshot =
    hasFreshAccount &&
    account!.netLiquidation === 0 &&
    account!.cashBalance === 0 &&
    positions.length > 0;

  // Compute unrealized P&L from enriched positions as fallback
  const positionPnl = positions.reduce((sum, p) => sum + p.unrealizedPnl, 0);

  currentStatus = {
    ...currentStatus,
    connected,
    paperMode: true,
    account: ibkr.getAccount() || currentStatus.account,
    positions,
    dailyPnl: hasFreshAccount ? account!.dailyPnl : currentStatus.dailyPnl,
    unrealizedPnl: hasFreshAccount && account!.unrealizedPnl !== 0
      ? account!.unrealizedPnl
      : positionPnl || currentStatus.unrealizedPnl,
    realizedPnl: hasFreshAccount ? account!.realizedPnl : currentStatus.realizedPnl,
    netLiquidation:
      hasFreshAccount && !suspiciousZeroSnapshot
        ? account!.netLiquidation
        : currentStatus.netLiquidation,
    cashBalance:
      hasFreshAccount && !suspiciousZeroSnapshot
        ? account!.cashBalance
        : currentStatus.cashBalance,
    timestamp: new Date().toISOString(),
  };

  saveStatus(currentStatus);
  if (connected) recordDailyPerformance(currentStatus);

  // ── Position Close Detection ──
  if (connected && previousPositionSymbols.size > 0) {
    const currentSymbols = new Set(positions.map((p) => p.symbol));
    for (const [symbol, prevPos] of previousPositionSymbols) {
      if (!currentSymbols.has(symbol)) {
        // Position closed — send notification
        notifyPositionClosed(symbol, prevPos).catch((e) =>
          console.log("[trading-agent] Close notification error:", e instanceof Error ? e.message : e),
        );
      }
    }
  }
  // Update tracked positions
  previousPositionSymbols = new Map(positions.map((p) => [p.symbol, p]));

  // ── Daily Report at 18:00 UTC ──
  const now = new Date();
  const utcHour = now.getUTCHours();
  const utcDay = now.getUTCDate();
  if (utcHour === 18 && lastReportDay !== utcDay) {
    lastReportDay = utcDay;
    sendDailyReport().catch((e) =>
      console.log("[trading-agent] Daily report error:", e instanceof Error ? e.message : e),
    );
  }

  // ── Daily Health Check at 08:00 UTC ──
  if (utcHour === 8 && lastHealthCheckDay !== utcDay) {
    lastHealthCheckDay = utcDay;
    sendHealthCheck().catch((e) =>
      console.log("[trading-agent] Health check error:", e instanceof Error ? e.message : e),
    );
  }

  // ── Daily Earnings Cache Refresh at 06:00 UTC ──
  if (utcHour === 6 && lastEarningsRefreshDay !== utcDay) {
    lastEarningsRefreshDay = utcDay;
    refreshEarningsCache().catch((e) =>
      console.log("[earnings] Daily refresh error:", e instanceof Error ? e.message : e),
    );
  }
}

// ── Position Close Notification ──

async function notifyPositionClosed(symbol: string, lastKnown: Position): Promise<void> {
  // Find entry order for this symbol
  const orders = loadOrders();
  const entryOrder = orders
    .filter((o) => o.symbol === symbol && o.side === "BUY" && o.status === "Filled")
    .pop(); // most recent BUY fill

  const entryPrice = entryOrder?.fillPrice || entryOrder?.price || lastKnown.avgCost;
  const entryTime = entryOrder?.fillTimestamp || entryOrder?.timestamp;

  // Determine close reason from exit orders
  const exitOrders = orders.filter(
    (o) => o.symbol === symbol && o.side === "SELL" && (o.status === "Filled" || o.status === "Stopped" || o.status === "TargetHit"),
  );
  const lastExit = exitOrders.pop();

  let closeReason = "Manuell";
  if (lastExit?.orderType === "STP") closeReason = "Stop-Loss";
  else if (lastExit?.orderType === "LMT" && lastExit.parentOrderId) closeReason = "Take-Profit";

  // P&L calculation
  const pnl = lastKnown.unrealizedPnl || (lastKnown.marketPrice - lastKnown.avgCost) * lastKnown.quantity;
  const pnlPct = entryPrice > 0 ? ((lastKnown.marketPrice - entryPrice) / entryPrice) * 100 : 0;

  // Hold duration
  let holdDuration = "";
  if (entryTime) {
    const diffMs = Date.now() - new Date(entryTime).getTime();
    const hours = Math.floor(diffMs / (1000 * 60 * 60));
    const mins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
    holdDuration = hours > 24
      ? `${Math.floor(hours / 24)}d ${hours % 24}h`
      : `${hours}h ${mins}m`;
  }

  const pnlSign = pnl >= 0 ? "+" : "";
  const emoji = pnl >= 0 ? "✅" : "❌";

  const msg = [
    `${emoji} *Trade geschlossen*`,
    ``,
    `*${symbol}* — ${closeReason}`,
    `Entry: $${entryPrice.toFixed(2)} → Exit: $${lastKnown.marketPrice.toFixed(2)}`,
    `P&L: ${pnlSign}$${pnl.toFixed(2)} (${pnlSign}${pnlPct.toFixed(1)}%)`,
    holdDuration ? `Haltedauer: ${holdDuration}` : "",
    `Menge: ${lastKnown.quantity} Stk`,
  ].filter(Boolean).join("\n");

  console.log(`[trading-agent] Position closed: ${symbol} | P&L: ${pnlSign}$${pnl.toFixed(2)} | ${closeReason}`);
  await sendTelegramNotification(msg);
}

// ── Daily Trading Report ──

async function sendDailyReport(): Promise<void> {
  const status = currentStatus;
  const orders = loadOrders();
  const today = new Date().toISOString().slice(0, 10);

  // Today's trades
  const todayOrders = orders.filter(
    (o) => o.timestamp.startsWith(today) && o.side === "BUY" && o.status === "Filled",
  );

  // Today's closed positions (SELL fills)
  const todayExits = orders.filter(
    (o) => o.timestamp.startsWith(today) && o.side === "SELL" &&
      (o.status === "Filled" || o.status === "Stopped" || o.status === "TargetHit"),
  );

  // Win/Loss from closed trades
  let wins = 0;
  let losses = 0;
  for (const exit of todayExits) {
    // Find matching entry
    const entry = orders.find(
      (o) => o.symbol === exit.symbol && o.side === "BUY" && o.status === "Filled" &&
        o.timestamp < exit.timestamp,
    );
    if (entry) {
      const entryPrice = entry.fillPrice || entry.price;
      const exitPrice = exit.fillPrice || exit.price;
      if (exitPrice > entryPrice) wins++;
      else losses++;
    }
  }

  // Best/worst current position
  let bestPos = "";
  let worstPos = "";
  if (status.positions.length > 0) {
    const sorted = [...status.positions].sort((a, b) => b.unrealizedPnl - a.unrealizedPnl);
    const best = sorted[0];
    const worst = sorted[sorted.length - 1];
    bestPos = `${best.symbol}: +$${best.unrealizedPnl.toFixed(2)}`;
    worstPos = `${worst.symbol}: $${worst.unrealizedPnl.toFixed(2)}`;
  }

  // 30-day stats
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const recentOrders = orders.filter((o) => o.timestamp >= thirtyDaysAgo);
  const recentEntries = recentOrders.filter((o) => o.side === "BUY" && o.status === "Filled");
  const recentExits = recentOrders.filter(
    (o) => o.side === "SELL" && (o.status === "Filled" || o.status === "Stopped" || o.status === "TargetHit"),
  );

  let totalWins30d = 0;
  let totalTrades30d = 0;
  for (const exit of recentExits) {
    const entry = recentOrders.find(
      (o) => o.symbol === exit.symbol && o.side === "BUY" && o.status === "Filled" &&
        o.timestamp < exit.timestamp,
    );
    if (entry) {
      totalTrades30d++;
      const entryP = entry.fillPrice || entry.price;
      const exitP = exit.fillPrice || exit.price;
      if (exitP > entryP) totalWins30d++;
    }
  }
  const winRate30d = totalTrades30d > 0 ? ((totalWins30d / totalTrades30d) * 100).toFixed(0) : "—";

  // Monthly P&L from performance data
  const monthPerf = loadPerformance(now.getFullYear(), now.getMonth() + 1);
  const monthPnl = monthPerf.reduce((sum, e) => sum + e.dailyPnl, 0);

  // Decisions today
  const decisions = loadRecentDecisions(100).filter((d) => d.timestamp.startsWith(today));
  const buyDecisions = decisions.filter((d) => d.decision === "BUY").length;
  const skipDecisions = decisions.filter((d) => d.decision === "SKIP").length;

  const pnlSign = status.dailyPnl >= 0 ? "+" : "";

  const msg = [
    `📊 *Täglicher Trading-Report*`,
    ``,
    `*${today}*`,
    ``,
    `Trades heute: ${todayOrders.length} eröffnet, ${todayExits.length} geschlossen`,
    todayExits.length > 0 ? `Ergebnis: ${wins}W / ${losses}L` : "",
    `Tages-P&L: ${pnlSign}$${status.dailyPnl.toFixed(2)}`,
    ``,
    bestPos ? `Beste Position: ${bestPos}` : "",
    worstPos ? `Schlechteste: ${worstPos}` : "",
    ``,
    `Offene Positionen: ${status.positions.length}`,
    `Net Liquidation: $${status.netLiquidation.toFixed(0)}`,
    ``,
    `*30-Tage-Statistik:*`,
    `Win-Rate: ${winRate30d}% (${totalTrades30d} Trades)`,
    `Monats-P&L: ${monthPnl >= 0 ? "+" : ""}$${monthPnl.toFixed(2)}`,
    ``,
    decisions.length > 0 ? `KI-Entscheidungen heute: ${buyDecisions} BUY / ${skipDecisions} SKIP` : "",
  ].filter(Boolean).join("\n");

  console.log(`[trading-agent] Sending daily report for ${today}`);
  await sendTelegramNotification(msg);
}

// ── Watchdog ──

async function restartGateway(): Promise<boolean> {
  const now = Date.now();
  if (now - lastGatewayRestart < GATEWAY_RESTART_COOLDOWN) {
    console.log("[watchdog] Gateway restart skipped — cooldown active");
    return false;
  }
  lastGatewayRestart = now;

  // Try user-level systemctl first, then sudo
  for (const cmd of [
    "systemctl --user restart ibgateway.service",
    "sudo systemctl restart ibgateway.service",
  ]) {
    try {
      console.log(`[watchdog] Attempting: ${cmd}`);
      await execAsync(cmd, { timeout: 30_000 });
      console.log("[watchdog] Gateway restart succeeded");
      return true;
    } catch (e) {
      console.log(`[watchdog] ${cmd} failed:`, e instanceof Error ? e.message : e);
    }
  }
  return false;
}

async function watchdogTick(): Promise<void> {
  const problems: string[] = [];

  // Check 1: IBKR connected?
  const connected = ibkr.isConnected();
  if (!connected) {
    problems.push(`IBKR disconnected (reconnect attempts: ${ibkr.reconnectAttempts})`);
  }

  // Check 2: Last scan < 10 minutes?
  if (lastScanResult.timestamp) {
    const scanAge = Date.now() - new Date(lastScanResult.timestamp).getTime();
    if (scanAge > 10 * 60 * 1000) {
      problems.push(`Last scan stale (${Math.round(scanAge / 60_000)}min ago)`);
    }
  }

  // Check 3: Scheduler still running?
  if (!universeManager.isScheduleRunning()) {
    problems.push("Universe scheduler stopped");
  }

  if (problems.length === 0) {
    if (consecutiveWatchdogFailures > 0) {
      console.log("[watchdog] All checks passed — recovered after " + consecutiveWatchdogFailures + " failures");
    }
    consecutiveWatchdogFailures = 0;
    console.log("[watchdog] OK — connected=" + connected + " scheduler=" + universeManager.isScheduleRunning());
    return;
  }

  consecutiveWatchdogFailures++;
  console.log(`[watchdog] Problems (${consecutiveWatchdogFailures}x): ${problems.join("; ")}`);

  // Auto-reconnect if disconnected
  if (!connected) {
    try {
      console.log("[watchdog] Triggering reconnect...");
      await ibkr.connect();
    } catch (e) {
      console.log("[watchdog] Reconnect failed:", e instanceof Error ? e.message : e);
    }
  }

  // After 3 consecutive failures: alert + gateway restart
  if (consecutiveWatchdogFailures >= 3) {
    const msg = [
      `⚠️ *Trading Agent Watchdog Alert*`,
      ``,
      `${consecutiveWatchdogFailures} consecutive failures:`,
      ...problems.map((p) => `• ${p}`),
      ``,
      `IBKR state: ${ibkr.state}`,
      `Reconnect attempts: ${ibkr.reconnectAttempts}`,
    ].join("\n");

    await sendTelegramNotification(msg);

    // Gateway restart after 3 failed IBKR reconnects
    if (!connected && ibkr.reconnectAttempts >= 3) {
      const restarted = await restartGateway();
      if (restarted) {
        await sendTelegramNotification("🔄 *IB Gateway restarted* — waiting for reconnect...");
      }
    }
  }
}

// ── Health Check ──

async function sendHealthCheck(): Promise<void> {
  const status = currentStatus;
  const connected = ibkr.isConnected();

  const scanAge = lastScanResult.timestamp
    ? Math.round((Date.now() - new Date(lastScanResult.timestamp).getTime()) / 60_000) + "min ago"
    : "never";

  const positionLines = status.positions.length > 0
    ? status.positions.map((p) => {
        const pnlSign = p.unrealizedPnl >= 0 ? "+" : "";
        return `  ${p.symbol}: ${p.quantity} Stk | ${pnlSign}$${p.unrealizedPnl.toFixed(2)}`;
      }).join("\n")
    : "  Keine offenen Positionen";

  const msg = [
    `🏥 *Täglicher Health-Check*`,
    ``,
    `*IBKR:* ${connected ? "✅ Connected" : "❌ Disconnected"}`,
    `Reconnect-Versuche: ${ibkr.reconnectAttempts}`,
    ``,
    `*Letzter Scan:* ${scanAge}`,
    `Ergebnis: ${lastScanResult.universe} Universe, ${lastScanResult.momentum} Momentum, ${lastScanResult.meanReversion} MeanRev`,
    ``,
    `*Positionen:*`,
    positionLines,
    ``,
    `*Watchdog:* ${consecutiveWatchdogFailures === 0 ? "✅ OK" : `⚠️ ${consecutiveWatchdogFailures} Failures`}`,
    `Scheduler: ${universeManager.isScheduleRunning() ? "✅ Running" : "❌ Stopped"}`,
    `Net Liquidation: $${status.netLiquidation.toFixed(0)}`,
  ].join("\n");

  console.log("[trading-agent] Sending daily health check");
  await sendTelegramNotification(msg);
}

// ── Express ──

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true, connected: ibkr.isConnected() });
});

app.get("/status", (_req, res) => {
  // Always return live connection state
  currentStatus.connected = ibkr.isConnected();
  res.json(currentStatus);
});

app.get("/watchlist", (_req, res) => {
  res.json(loadWatchlist());
});

app.post("/watchlist", (req, res) => {
  const { symbol, exchange, currency } = req.body || {};
  if (!symbol) {
    res.status(400).json({ error: "symbol required" });
    return;
  }
  const list = addToWatchlist({
    symbol: String(symbol).toUpperCase(),
    exchange: String(exchange || "SMART"),
    currency: String(currency || "USD"),
  });
  res.json(list);
});

app.delete("/watchlist/:symbol", (req, res) => {
  const list = removeFromWatchlist(req.params.symbol.toUpperCase());
  res.json(list);
});

app.get("/strategies", (_req, res) => {
  res.json(loadStrategies());
});

app.get("/mode", (_req, res) => {
  res.json({ mode: currentStatus.mode });
});

app.post("/mode", (req, res) => {
  const mode = Number(req.body?.mode);
  if (![1, 2, 3].includes(mode)) {
    res.status(400).json({ error: "mode must be 1, 2, or 3" });
    return;
  }
  currentStatus.mode = mode as 1 | 2 | 3;
  saveStatus(currentStatus);
  const labels: Record<number, string> = { 1: "Monitoring", 2: "Semi-Auto", 3: "Full-Auto" };
  res.json({ mode, label: labels[mode] });
});

// ── Universe Endpoints ──

app.get("/universe", (_req, res) => {
  res.json(loadUniverse());
});

app.get("/universe/config", (_req, res) => {
  res.json(loadUniverseConfig());
});

app.put("/universe/config", (req, res) => {
  const current = loadUniverseConfig();
  const body = req.body || {};
  if (body.indices) {
    for (const [key, val] of Object.entries(body.indices)) {
      if (current.indices[key] && typeof val === "object" && val !== null) {
        Object.assign(current.indices[key], val);
      }
    }
  }
  if (body.sectors) {
    Object.assign(current.sectors, body.sectors);
  }
  if (body.liquidityFilter) {
    Object.assign(current.liquidityFilter, body.liquidityFilter);
  }
  if (typeof body.maxUniverseSize === "number") {
    current.maxUniverseSize = body.maxUniverseSize;
  }
  saveUniverseConfig(current);
  res.json(current);
});

app.get("/universe/scan", (_req, res) => {
  res.json(loadRecentScanResults(50));
});

let scanRunning = false;
let lastScanResult = { universe: 0, momentum: 0, meanReversion: 0, timestamp: "", status: "idle" };

app.post("/universe/scan", (_req, res) => {
  if (scanRunning) {
    res.json({ ...lastScanResult, status: "running", message: "Scan läuft bereits" });
    return;
  }
  scanRunning = true;
  lastScanResult = { universe: 0, momentum: 0, meanReversion: 0, timestamp: new Date().toISOString(), status: "running" };
  res.json({ ...lastScanResult, message: "Scan gestartet" });

  (async () => {
    try {
      const data = await universeManager.buildActiveUniverse();
      const momentum = await universeManager.scanMomentum();
      const meanRev = await universeManager.scanMeanReversion();
      lastScanResult = {
        universe: data.symbols.length,
        momentum: momentum.length,
        meanReversion: meanRev.length,
        timestamp: new Date().toISOString(),
        status: "done",
      };
      console.log(`[trading-agent] Scan complete: ${data.symbols.length} symbols, ${momentum.length} momentum, ${meanRev.length} meanRev`);

      // Auto-execute if mode 3
      if (currentStatus.mode === 3 && momentum.length > 0) {
        const trades = await executor.executeAfterScan(momentum);
        if (trades.length > 0) {
          console.log(`[trading-agent] Auto-executed ${trades.length} trades`);
        }
      }
    } catch (e) {
      lastScanResult = { universe: 0, momentum: 0, meanReversion: 0, timestamp: new Date().toISOString(), status: "error" };
      console.error("[trading-agent] Scan error:", e);
    } finally {
      scanRunning = false;
    }
  })();
});

app.get("/universe/scan/status", (_req, res) => {
  res.json({ ...lastScanResult, status: scanRunning ? "running" : lastScanResult.status });
});

app.get("/orders", (_req, res) => {
  const limit = Number((_req.query as any).limit) || 20;
  const orders = loadOrders();
  res.json(orders.slice(-limit));
});

app.get("/decisions", (_req, res) => {
  const limit = Number((_req.query as any).limit) || 20;
  res.json(loadRecentDecisions(limit));
});

app.get("/universe/top", (_req, res) => {
  const limit = Number((_req.query as any).limit) || 10;
  res.json(universeManager.getTopCandidates(limit));
});

// ── Earnings Endpoints ──

app.get("/earnings", (_req, res) => {
  const cache = loadEarningsCache();
  const cacheAge = cache.lastUpdate
    ? Math.round((Date.now() - new Date(cache.lastUpdate).getTime()) / 60_000)
    : null;
  res.json({
    today: getEarningsToday(),
    blocked: getBlockedSymbols(),
    postEarnings: getPostEarningsSymbols(),
    cacheAge: cacheAge !== null ? `${cacheAge}min` : "never",
    lastUpdate: cache.lastUpdate || null,
    totalEntries: cache.entries.length,
  });
});

app.get("/earnings/:symbol", (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const days = daysUntilEarnings(symbol);
  const isBlocked = hasEarningsSoon(symbol);
  const cache = loadEarningsCache();
  const entry = cache.entries.find((e) => e.symbol === symbol);
  res.json({
    symbol,
    earningsDate: entry?.earningsDate || null,
    timing: entry?.timing || null,
    daysUntil: days,
    blocked: isBlocked,
  });
});

app.post("/earnings/refresh", (_req, res) => {
  res.json({ message: "Earnings refresh gestartet" });
  refreshEarningsCache().catch((e) =>
    console.log("[earnings] Manual refresh error:", e instanceof Error ? e.message : e),
  );
});

// ── Startup ──

async function start(): Promise<void> {
  const labels: Record<number, string> = { 1: "Monitoring", 2: "Semi-Auto", 3: "Full-Auto" };
  console.log(`[trading-agent] Starting on ${BIND}:${PORT} — Mode ${currentStatus.mode} (${labels[currentStatus.mode] || "?"})`);

  // Connect to IBKR (non-blocking, graceful degradation)
  ibkr.on("state", (state: string) => {
    console.log(`[trading-agent] IBKR state: ${state}`);
  });

  // Wire reconnect events
  ibkr.on("reconnected", () => {
    console.log("[trading-agent] IBKR reconnected — resyncing positions");
    consecutiveWatchdogFailures = 0;
    pollIBKR().catch((e) => console.error("[trading-agent] Post-reconnect poll error:", e));
  });

  ibkr.on("reconnectFailed", (attempt: number) => {
    console.log(`[trading-agent] IBKR reconnect failed (attempt ${attempt})`);
  });

  try {
    await ibkr.connect();
  } catch (e) {
    console.log("[trading-agent] IBKR not available, running in disconnected mode");
  }

  // Initial poll — sync positions from IBKR before any trading
  await pollIBKR();
  console.log(`[trading-agent] Initial sync: ${currentStatus.positions.length} positions, cash $${currentStatus.cashBalance.toFixed(0)}, net $${currentStatus.netLiquidation.toFixed(0)}`);

  // Initial earnings cache refresh
  refreshEarningsCache().catch((e) =>
    console.log("[earnings] Initial refresh error:", e instanceof Error ? e.message : e),
  );

  // Start polling
  pollTimer = setInterval(() => {
    pollIBKR().catch((e) => console.error("[trading-agent] Poll error:", e));
  }, POLL_INTERVAL);

  // Start watchdog (every 5 minutes)
  watchdogTimer = setInterval(() => {
    watchdogTick().catch((e) => console.error("[watchdog] Error:", e));
  }, WATCHDOG_INTERVAL);
  console.log("[watchdog] Started (interval: 5min)");

  // Wire auto-execution callback for scheduled scans
  universeManager.onMomentumScan = async (results) => {
    if (currentStatus.mode === 3 && results.length > 0) {
      const trades = await executor.executeAfterScan(results);
      if (trades.length > 0) {
        console.log(`[trading-agent] Scheduled auto-execution: ${trades.length} trades`);
      }
    }
  };

  // Track scheduled scan results for health check
  universeManager.onScanComplete = (info) => {
    const universe = loadUniverse();
    lastScanResult = {
      universe: universe.symbols.length,
      momentum: info.momentum,
      meanReversion: info.meanReversion,
      timestamp: new Date().toISOString(),
      status: "done",
    };
  };

  // Start universe manager schedule
  universeManager.startSchedule();

  // Start HTTP server
  app.listen(PORT, BIND, () => {
    console.log(`[trading-agent] HTTP listening on ${BIND}:${PORT}`);
  });
}

// ── Graceful shutdown ──

function shutdown(): void {
  console.log("[trading-agent] Shutting down...");
  if (watchdogTimer) clearInterval(watchdogTimer);
  universeManager.stopSchedule();
  if (pollTimer) clearInterval(pollTimer);
  ibkr.disconnect();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

start().catch((e) => {
  console.error("[trading-agent] Fatal:", e);
  process.exit(1);
});
