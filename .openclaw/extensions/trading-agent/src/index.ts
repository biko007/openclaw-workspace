import { readFileSync } from "node:fs";
import { join } from "node:path";
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(execCb);
import express from "express";
import YahooFinance from "yahoo-finance2";
import { IBKRConnection, type Position, type ExitFillInfo, type SyncSnapshot } from "./ibkr.js";
import { DurableEventLog, OrderStateTracker } from "./order-state-tracker.js";
import { classifyPositions, type ClassificationResult } from "./position-classifier.js";
import {
  runGuardianCycle,
  reconcileOpenIntents,
  checkFallbackClose,
  type GuardianConfig,
  type GuardianAlertCache,
  type QuoteSnapshot,
} from "./position-guardian.js";
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
import { isMarketOpen, marketStatusLabel, isTradingDay } from "./market-hours.js";
import { AlertManager } from "./alert-manager.js";
import { checkExitCoverage } from "./watchdog-metrics.js";
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
} from "./store.js";

const PORT = 18793;
const BIND = "127.0.0.1";
const POLL_INTERVAL = 30_000;

// ── Telegram notification ──

function loadTelegramConfig(): { botToken: string; chatId: string } {
  let botToken = process.env.TELEGRAM_BOT_TOKEN || '';
  if (!botToken) {
    try {
      const cfgPath = join(process.env.HOME || "/home/biko", ".openclaw/openclaw.json");
      const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
      const raw = cfg?.channels?.telegram?.botToken;
      if (typeof raw === 'string') botToken = raw;
      else if (raw?.source === 'env' && raw?.id) botToken = process.env[raw.id] || '';
    } catch { /* ignore */ }
  }
  const chatId = process.env.TELEGRAM_CHAT_ID || "133260792";
  return { botToken, chatId };
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

const EVENT_LOG_PATH = join(
  process.env.HOME || "/home/biko",
  ".openclaw/workspace/artifacts/personal/trading/orders-v2.jsonl",
);
const eventLog = new DurableEventLog(EVENT_LOG_PATH);
const tracker = new OrderStateTracker(eventLog);

const universeManager = new UniverseManager(ibkr);
const alertManager = new AlertManager(sendTelegramNotification);
const executor = new OrderExecutor(ibkr, () => currentStatus, sendTelegramNotification, tracker, alertManager);
let currentStatus: TradingStatus = loadStatus();
let pollTimer: ReturnType<typeof setInterval> | null = null;
let previousPositionSymbols = new Map<string, Position>(); // track for close detection
let lastReportDay = currentStatus.lastReportDay ?? -1;
let lastHealthCheckDay = currentStatus.lastHealthCheckDay ?? -1;
let lastEarningsRefreshDay = currentStatus.lastEarningsRefreshDay ?? -1;
const loggedLegacyOrders = new Set<number>(); // E3b: dedupe legacy-own logs
const notifiedExitFills = new Set<string>(); // R3: dedup exit-fill Telegram by orderRef

// Suppress individual trade event notifications (default: true = send)
// Set TRADE_EVENT_TELEGRAM=false in env to receive only daily summaries
const TRADE_EVENT_TELEGRAM = (process.env.TRADE_EVENT_TELEGRAM ?? "true").toLowerCase() !== "false";
console.log(`[trading-agent] TRADE_EVENT_TELEGRAM=${TRADE_EVENT_TELEGRAM}`);

// ── Guardian state (E4) ──
const GUARDIAN_CONFIG: GuardianConfig = {
  fallbackMode: (process.env.GUARDIAN_FALLBACK_MODE as "market_close" | "alert_only") || "market_close",
  maxRetriesPerHour: 2,
  quoteMaxAgeSec: 90,
};
const guardianRetryTracker = new Map<string, { count: number; windowStart: number }>();
const guardianSymbolLocks = new Map<string, Promise<void>>();
const guardianQuoteCache = new Map<number, QuoteSnapshot>();
const guardianAlertCache: GuardianAlertCache = new Map();
let lastClassification: ClassificationResult | null = null;
let lastSyncSnapshot: SyncSnapshot | null = null;
let classificationCycleCount = 0; // E6: first-cycle grace — alerts suppressed on cycle 1

// ── Watchdog state ──
const WATCHDOG_EXITS_ESCALATION = 15 * 60 * 1000; // 15 min WARN→CRITICAL
const WATCHDOG_INTERVAL = 5 * 60 * 1000; // 5 minutes
let watchdogTimer: ReturnType<typeof setInterval> | null = null;
let consecutiveWatchdogFailures = 0;
let lastGatewayRestart = 0; // timestamp ms
const GATEWAY_RESTART_COOLDOWN = 60 * 60 * 1000; // 1 hour
let lastMarketOpenState: boolean | null = null; // track open→closed transitions
let marketOpenedAt = 0; // timestamp ms when market last transitioned to open
const SCAN_GRACE_PERIOD = 20 * 60 * 1000; // 20 min grace after market open (covers 15min safety + scan duration)
let consecutiveStaleCycles = 0; // R2: debounce scan_stale alerts
const SCAN_STALE_DEBOUNCE = 3; // require N consecutive stale observations before alerting

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
  if (utcHour === 18 && lastReportDay !== utcDay && isTradingDay()) {
    lastReportDay = utcDay;
    currentStatus.lastReportDay = lastReportDay;
    saveStatus(currentStatus);
    sendDailyReport().catch((e) =>
      console.log("[trading-agent] Daily report error:", e instanceof Error ? e.message : e),
    );
  }

  // ── Daily Health Check at 08:00 UTC ──
  if (utcHour === 8 && lastHealthCheckDay !== utcDay && isTradingDay()) {
    lastHealthCheckDay = utcDay;
    currentStatus.lastHealthCheckDay = lastHealthCheckDay;
    saveStatus(currentStatus);
    sendHealthCheck().catch((e) =>
      console.log("[trading-agent] Health check error:", e instanceof Error ? e.message : e),
    );
  }

  // ── Daily Earnings Cache Refresh at 06:00 UTC ──
  if (utcHour === 6 && lastEarningsRefreshDay !== utcDay) {
    lastEarningsRefreshDay = utcDay;
    currentStatus.lastEarningsRefreshDay = lastEarningsRefreshDay;
    saveStatus(currentStatus);
    refreshEarningsCache().catch((e) =>
      console.log("[earnings] Daily refresh error:", e instanceof Error ? e.message : e),
    );
  }

  // ── Guardian: Quote cache refresh + Fallback-Close check (E4) ──
  if (connected && lastClassification && lastSyncSnapshot) {
    const legacyConIds = new Set<number>();
    for (const lo of lastClassification.legacyOwn) {
      legacyConIds.add(lo.conId);
    }

    for (const cp of lastClassification.positions) {
      if (cp.state !== "protected") {
        try {
          const quote = await ibkr.getQuoteSnapshot(cp.symbol, cp.conId, cp.exchange, cp.currency);
          if (quote) guardianQuoteCache.set(cp.conId, quote);
        } catch { /* ignore */ }
      }
    }

    // Fallback close check with cached classification
    if (!ibkr.guardianLocked && !ibkr.syncInProgress && !tracker.tradingLocked) {
      for (const cp of lastClassification.positions) {
        if (cp.state === "protected" || cp.state === "foreign_involved" ||
            cp.state === "unreconstructable" || legacyConIds.has(cp.conId)) continue;
        try {
          await checkFallbackClose(cp, lastSyncSnapshot, ibkr, tracker, alertManager,
            GUARDIAN_CONFIG, guardianQuoteCache, guardianSymbolLocks);
        } catch (e) {
          console.error(`[guardian] Fallback check error for ${cp.symbol}:`, e instanceof Error ? e.message : e);
        }
      }
    }
  }
}

// ── Position Close Notification ──

async function notifyPositionClosed(symbol: string, lastKnown: Position): Promise<void> {
  // Dual-source: try tracker first (E5 entries), fall back to legacy orders.jsonl
  let entryPrice = lastKnown.avgCost;
  let entryTime: string | undefined;
  let closeReason = "Manuell";

  // Tracker source: scan for entry-leg order_submitted events matching this symbol
  let trackerFound = false;
  if (lastSyncSnapshot) {
    const pos = lastSyncSnapshot.positions.find((p) => p.symbol === symbol);
    if (pos) {
      const refs = tracker.getOrderRefsForConId(pos.conId);
      for (const ref of refs) {
        const submitted = tracker.getSubmittedEvent(ref);
        if (submitted && submitted.action === "BUY") {
          entryPrice = submitted.limitPrice ?? lastKnown.avgCost;
          entryTime = submitted.timestamp;
          // Check for fill price
          const fillEvents = tracker.getEventsForOrder(ref);
          for (const ev of fillEvents) {
            if (ev.type === "order_filled") {
              entryPrice = (ev as any).avgPrice ?? entryPrice;
            }
          }
          trackerFound = true;
          break;
        }
      }
    }
  }

  // Legacy fallback for pre-E5 entries
  if (!trackerFound) {
    const orders = loadOrders();
    const entryOrder = orders
      .filter((o) => o.symbol === symbol && o.side === "BUY" && o.status === "Filled")
      .pop();
    entryPrice = entryOrder?.fillPrice || entryOrder?.price || lastKnown.avgCost;
    entryTime = entryOrder?.fillTimestamp || entryOrder?.timestamp;

    const exitOrders = orders.filter(
      (o) => o.symbol === symbol && o.side === "SELL" && (o.status === "Filled" || o.status === "Stopped" || o.status === "TargetHit"),
    );
    const lastExit = exitOrders.pop();
    if (lastExit?.orderType === "STP") closeReason = "Stop-Loss";
    else if (lastExit?.orderType === "LMT" && lastExit.parentOrderId) closeReason = "Take-Profit";
  }

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
  if (TRADE_EVENT_TELEGRAM) await sendTelegramNotification(msg);
}

// ── Daily Trading Report ──

async function sendDailyReport(): Promise<void> {
  const status = currentStatus;
  const orders = loadOrders();
  const today = new Date().toISOString().slice(0, 10);

  // E6: Merge tracker fills with legacy orders for today's trades
  const trackerEntries = tracker.getRecentFills({ sinceDays: 1, leg: "entry" });
  const trackerExits = tracker.getRecentFills({ sinceDays: 1 })
    .filter((t) => t.side === "SELL");

  // Today's trades (legacy + tracker, deduped by symbol+timestamp)
  const legacyTodayEntries = orders.filter(
    (o) => o.timestamp.startsWith(today) && o.side === "BUY" && o.status === "Filled",
  );
  const trackerTodayEntries = trackerEntries.filter(
    (t) => t.timestamp.startsWith(today) && t.side === "BUY",
  );
  // Dedup: tracker entries that don't match any legacy entry by symbol+date
  const legacyEntryKeys = new Set(legacyTodayEntries.map((o) => `${o.symbol}|${o.timestamp.slice(0, 16)}`));
  const uniqueTrackerEntries = trackerTodayEntries.filter(
    (t) => !legacyEntryKeys.has(`${t.symbol}|${t.timestamp.slice(0, 16)}`),
  );
  const todayOrderCount = legacyTodayEntries.length + uniqueTrackerEntries.length;

  // Today's closed positions (legacy + tracker SELL fills)
  const todayOrders = legacyTodayEntries;
  const legacyTodayExits = orders.filter(
    (o) => o.timestamp.startsWith(today) && o.side === "SELL" &&
      (o.status === "Filled" || o.status === "Stopped" || o.status === "TargetHit"),
  );
  const trackerTodayExits = trackerExits.filter((t) => t.timestamp.startsWith(today));
  const legacyExitKeys = new Set(legacyTodayExits.map((o) => `${o.symbol}|${o.timestamp.slice(0, 16)}`));
  const uniqueTrackerExits = trackerTodayExits.filter(
    (t) => !legacyExitKeys.has(`${t.symbol}|${t.timestamp.slice(0, 16)}`),
  );
  const todayExitCount = legacyTodayExits.length + uniqueTrackerExits.length;
  const todayExits = [...legacyTodayExits, ...uniqueTrackerExits];

  // Win/Loss from closed trades
  let wins = 0;
  let losses = 0;
  for (const exit of todayExits) {
    // Find matching entry (legacy first, then tracker)
    const entry = orders.find(
      (o) => o.symbol === exit.symbol && o.side === "BUY" && o.status === "Filled" &&
        o.timestamp < exit.timestamp,
    ) ?? trackerEntries.find(
      (t) => t.symbol === exit.symbol && t.side === "BUY" &&
        t.timestamp < exit.timestamp,
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
    `Trades heute: ${todayOrderCount} eröffnet, ${todayExitCount} geschlossen`,
    todayExits.length > 0 ? `Ergebnis: ${wins}W / ${losses}L` : "",
    `Tages-P&L: ${pnlSign}$${status.dailyPnl.toFixed(2)}`,
    ``,
    bestPos ? `Beste offene Position: ${bestPos}` : "",
    worstPos ? `Schlechteste offene: ${worstPos}` : "",
    ``,
    `Offene Positionen: ${status.positions.length}`,
    lastClassification ? `Exit-Coverage: ${lastClassification.stateCount["protected"] ?? 0}/${lastClassification.positions.length}` : "",
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
  const marketOpen = isMarketOpen();
  const connected = ibkr.isConnected();

  // Log market state transitions and track open timestamp
  if (lastMarketOpenState !== null && lastMarketOpenState !== marketOpen) {
    console.log(`[watchdog] Markt ${marketOpen ? "geöffnet" : "geschlossen"} — ${marketStatusLabel()}`);
    if (marketOpen) {
      marketOpenedAt = Date.now();
    }
  }
  lastMarketOpenState = marketOpen;

  // Check 1: IBKR connected?
  if (!connected) {
    await alertManager.sendAlert("ibkr_disconnect", "CRITICAL", [
      `⚠️ *Trading Agent Watchdog*`,
      ``,
      `IBKR disconnected`,
      `State: ${ibkr.state}`,
      `Reconnect-Versuche: ${ibkr.reconnectAttempts}`,
    ].join("\n"));

    // Auto-reconnect
    try {
      console.log("[watchdog] Triggering reconnect...");
      await ibkr.connect();
    } catch (e) {
      console.log("[watchdog] Reconnect failed:", e instanceof Error ? e.message : e);
    }

    consecutiveWatchdogFailures++;

    // Gateway restart after sustained disconnect
    if (consecutiveWatchdogFailures >= 3 && ibkr.reconnectAttempts >= 3) {
      const restarted = await restartGateway();
      if (restarted) {
        await alertManager.sendAlert("gateway_restart", "CRITICAL",
          "🔄 *IB Gateway restarted* — waiting for reconnect...");
      }
    }
  } else {
    if (alertManager.isActive("ibkr_disconnect")) {
      await alertManager.resolve("ibkr_disconnect");
    }
  }

  // Check 2: Scan stale — ONLY during market hours, with grace period after open
  // R2: Debounced — only alert after SCAN_STALE_DEBOUNCE consecutive stale observations
  const inGracePeriod = marketOpenedAt > 0 && (Date.now() - marketOpenedAt) < SCAN_GRACE_PERIOD;
  if (marketOpen && !inGracePeriod && lastScanResult.timestamp) {
    const scanAge = Date.now() - new Date(lastScanResult.timestamp).getTime();
    if (scanAge > 10 * 60 * 1000) {
      consecutiveStaleCycles++;
      if (consecutiveStaleCycles >= SCAN_STALE_DEBOUNCE) {
        await alertManager.sendAlert("scan_stale", "WARN", [
          `⚠️ *Trading Agent Watchdog*`,
          ``,
          `Letzter Scan veraltet (${Math.round(scanAge / 60_000)}min, ${consecutiveStaleCycles} Zyklen)`,
          `Scheduler: ${universeManager.isScheduleRunning() ? "läuft" : "gestoppt"}`,
        ].join("\n"));
      }
    } else {
      consecutiveStaleCycles = 0;
      if (alertManager.isActive("scan_stale")) {
        await alertManager.resolve("scan_stale");
      }
    }
  } else if (marketOpen && inGracePeriod) {
    // Grace period after market open — safety window blocks scans, don't alert
    consecutiveStaleCycles = 0;
    if (alertManager.isActive("scan_stale")) {
      await alertManager.resolve("scan_stale");
    }
  } else if (!marketOpen && alertManager.isActive("scan_stale")) {
    consecutiveStaleCycles = 0;
    // Market closed — silently clear scan_stale without recovery message
    // (resolve would send a Telegram message, we just want silence)
  }

  // Check 3: Scheduler running?
  if (!universeManager.isScheduleRunning()) {
    await alertManager.sendAlert("scheduler_stopped", "WARN", [
      `⚠️ *Trading Agent Watchdog*`,
      ``,
      `Universe Scheduler gestoppt`,
    ].join("\n"));
  } else {
    if (alertManager.isActive("scheduler_stopped")) {
      await alertManager.resolve("scheduler_stopped");
    }
  }

  // Check 4: Exit coverage (E6 — exits_incomplete + qty undercoverage)
  // Skip on first cycle — classification may be based on incomplete openOrder stream
  let exitsLabel = "?/?";
  if (lastClassification && classificationCycleCount > 1) {
    const coverage = await checkExitCoverage(
      lastClassification,
      (conId) => tracker.getExitState(conId),
      alertManager,
      guardianAlertCache,
      WATCHDOG_EXITS_ESCALATION,
    );
    exitsLabel = coverage.exitsLabel;
  }

  // Track consecutive failures for gateway restart logic
  const hasProblems = !connected || (!universeManager.isScheduleRunning());
  if (!hasProblems) {
    if (consecutiveWatchdogFailures > 0) {
      console.log(`[watchdog] All checks passed — recovered after ${consecutiveWatchdogFailures} failures`);
    }
    consecutiveWatchdogFailures = 0;
  }

  console.log(`[watchdog] OK — connected=${connected} scheduler=${universeManager.isScheduleRunning()} market=${marketOpen ? "open" : "closed"} exits=${exitsLabel}`);
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
  res.json({ ok: true, service: "trading-agent", connected: ibkr.isConnected(), uptime: process.uptime() });
});

app.get("/ready", (_req, res) => {
  const connected = ibkr.isConnected();
  res.json({ ok: connected, service: "trading-agent", connected });
});

app.get("/version", (_req, res) => {
  res.json({ service: "trading-agent", node: process.version, uptime: process.uptime() });
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

// Deprecated: orders.jsonl is legacy read-only from E5.
// New order events go to orders-v2.jsonl via OrderStateTracker.
app.get("/orders", (_req, res) => {
  res.setHeader("X-Deprecated", "Use tracker events");
  const limit = Number((_req.query as any).limit) || 20;
  const orders = loadOrders();
  res.json(orders.slice(-limit));
});

app.post("/close/:symbol", async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();

  // Find position
  const pos = currentStatus.positions.find((p) => p.symbol === symbol);
  if (!pos) {
    res.status(404).json({ error: `No open position for ${symbol}` });
    return;
  }

  if (!ibkr.isConnected()) {
    res.status(503).json({ error: "IBKR not connected" });
    return;
  }

  try {
    // Use position's exchange/currency — hardcode SMART/USD prevented closing XETRA positions
    const result = await ibkr.placeMarketSell({
      symbol,
      exchange: pos.exchange || "SMART",
      currency: pos.currency || "USD",
      quantity: pos.quantity,
    });

    // Note: placeMarketSell generates orderStatus events picked up by
    // permanent listeners. For untagged manual closes, the position
    // sentinel (pollIBKR close detection) handles notification.

    // Calculate P&L
    const fillPrice = result.fillPrice || 0;
    const pnl = (fillPrice - pos.avgCost) * pos.quantity;
    const pnlPct = pos.avgCost > 0 ? ((fillPrice - pos.avgCost) / pos.avgCost) * 100 : 0;
    const pnlSign = pnl >= 0 ? "+" : "";
    const emoji = pnl >= 0 ? "✅" : "❌";

    // Telegram notification
    const msg = [
      `${emoji} *Position geschlossen*`,
      ``,
      `*${symbol}* — Market Order`,
      `Entry: $${pos.avgCost.toFixed(2)} → Exit: $${fillPrice.toFixed(2)}`,
      `P&L: ${pnlSign}$${pnl.toFixed(2)} (${pnlSign}${pnlPct.toFixed(1)}%)`,
      `Menge: ${pos.quantity} Stk`,
    ].join("\n");

    if (TRADE_EVENT_TELEGRAM) sendTelegramNotification(msg).catch(() => {});

    console.log(`[trading-agent] Closed ${symbol}: ${pos.quantity} @ $${fillPrice.toFixed(2)} | P&L: ${pnlSign}$${pnl.toFixed(2)}`);

    res.json({ symbol, quantity: pos.quantity, fillPrice, pnl, avgCost: pos.avgCost });
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    console.error(`[trading-agent] Close ${symbol} failed:`, errMsg);
    res.status(500).json({ error: errMsg });
  }
});

app.get("/decisions", (_req, res) => {
  const limit = Number((_req.query as any).limit) || 20;
  res.json(loadRecentDecisions(limit));
});

app.get("/universe/top", (_req, res) => {
  const limit = Number((_req.query as any).limit) || 10;
  res.json(universeManager.getTopCandidates(limit));
});

// ── Debug Endpoint ──

app.get("/debug/scan", (_req, res) => {
  const stats = universeManager.lastDebugStats;
  if (!stats) {
    res.json({ error: "No scan data yet — wait for next scan cycle" });
    return;
  }
  res.json(stats);
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

// ── Classification (E3b) + Guardian (E4) ──

async function runClassificationAndGuardian(snapshot: SyncSnapshot): Promise<void> {
  classificationCycleCount++;
  const classification = classifyPositions(snapshot, tracker, ibkr.getAccount());

  // One-time legacy-own log (deduped by orderId)
  for (const lo of classification.legacyOwn) {
    if (!loggedLegacyOrders.has(lo.orderId)) {
      console.log(
        `[reconcile] Legacy-own order: ${lo.symbol}#${lo.orderId} ` +
        `(clientId=${lo.clientId}, ${lo.orderType} qty=${lo.totalQuantity})`,
      );
      loggedLegacyOrders.add(lo.orderId);
    }
  }

  // Reconcile log per spec: one line per run
  console.log(
    `[reconcile] positions=${classification.positions.length} ` +
    `protected=${classification.stateCount["protected"] ?? 0} ` +
    `states=${JSON.stringify(classification.stateCount)} ` +
    `orphans=[${classification.orphans.map((o) => o.orderRef).join(",")}] ` +
    `foreign=[${classification.foreignCount}]`,
  );

  // Cache for fallback-close between sync barriers
  lastClassification = classification;
  lastSyncSnapshot = snapshot;

  // Guardian gating
  if (ibkr.guardianLocked || ibkr.syncInProgress || tracker.tradingLocked) {
    console.log(`[guardian] Skipped: guardianLocked=${ibkr.guardianLocked} syncInProgress=${ibkr.syncInProgress} tradingLocked=${tracker.tradingLocked}`);
    return;
  }

  // Run guardian cycle
  try {
    const actions = await runGuardianCycle(
      classification, snapshot, ibkr, tracker, alertManager,
      GUARDIAN_CONFIG, guardianRetryTracker, guardianSymbolLocks, guardianQuoteCache,
      guardianAlertCache, classificationCycleCount,
    );
    const actionSummary = actions.filter((a) => a.type !== "noop");
    if (actionSummary.length > 0) {
      console.log(`[guardian] Actions: ${actionSummary.map((a) => `${a.symbol}:${a.type}`).join(", ")}`);
    } else {
      console.log("[guardian] No actions needed");
    }
  } catch (e) {
    console.error("[guardian] Cycle error:", e instanceof Error ? e.message : e);
  }
}

// ── Startup ──

async function start(): Promise<void> {
  const labels: Record<number, string> = { 1: "Monitoring", 2: "Semi-Auto", 3: "Full-Auto" };
  console.log(`[trading-agent] Starting on ${BIND}:${PORT} — Mode ${currentStatus.mode} (${labels[currentStatus.mode] || "?"})`);

  // Connect to IBKR (non-blocking, graceful degradation)
  ibkr.on("state", (state: string) => {
    console.log(`[trading-agent] IBKR state: ${state}`);
  });

  // Wire reconnect events — sync barrier with 60s cooldown (E3a) + classification (E3b)
  ibkr.on("reconnected", async () => {
    console.log("[trading-agent] IBKR reconnected — running sync barrier");
    consecutiveWatchdogFailures = 0;
    classificationCycleCount = 0; // E6: reset grace — openOrder stream incomplete after reconnect
    try {
      const snapshot = await ibkr.runSyncBarrier({ isReconnect: true });
      console.log(`[trading-agent] Reconnect sync: ${snapshot.ownOrders.length} own, ${snapshot.foreignOrders.length} foreign`);
      await runClassificationAndGuardian(snapshot);
    } catch (e) {
      console.warn("[trading-agent] Sync barrier failed on reconnect:", e instanceof Error ? e.message : e);
    }
    pollIBKR().catch((e) => console.error("[trading-agent] Post-reconnect poll error:", e));
  });

  ibkr.on("reconnectFailed", (attempt: number) => {
    console.log(`[trading-agent] IBKR reconnect failed (attempt ${attempt})`);
  });

  // Exit-fill Telegram notification (R3: dedup by orderRef)
  ibkr.on("exitFill", async (info: ExitFillInfo) => {
    if (notifiedExitFills.has(info.orderRef)) return;
    notifiedExitFills.add(info.orderRef);
    const legLabel = info.leg === "stop" ? "Stop-Loss" : "Take-Profit";
    let pnlLine = "";
    if (info.entryPrice && info.entryPrice > 0) {
      const pnl = (info.fillPrice - info.entryPrice) * info.quantity;
      const pnlPct = ((info.fillPrice - info.entryPrice) / info.entryPrice) * 100;
      const sign = pnl >= 0 ? "+" : "";
      pnlLine = `\nP&L (est.): ${sign}$${pnl.toFixed(2)} (${sign}${pnlPct.toFixed(1)}%)`;
    }
    const msg = [
      `*Exit-Fill*`,
      `*${info.symbol}* — ${legLabel}`,
      `Fill: $${info.fillPrice.toFixed(2)} | Qty: ${info.quantity}`,
      pnlLine,
    ].filter(Boolean).join("\n");
    if (TRADE_EVENT_TELEGRAM) await sendTelegramNotification(msg);
  });

  // Rebuild tracker from durable log
  const rebuildResult = tracker.rebuild();
  if (rebuildResult.tradingLocked) {
    console.error("[trading-agent] CRITICAL: Trading locked — corrupted event log");
    await sendTelegramNotification("CRITICAL: Trading locked — corrupted event log. Manual intervention required.");
  }
  if (rebuildResult.openIntents.length > 0) {
    console.warn(`[trading-agent] WARN: ${rebuildResult.openIntents.length} open intents found at startup`);
  }
  if (rebuildResult.quarantinedLine) {
    console.warn("[trading-agent] WARN: Quarantined corrupt last line from event log");
  }

  // Wire tracker to IBKR connection
  ibkr.setTracker(tracker);

  // Arm sequencer with highest known orderId from log
  const allOrderIds: number[] = [];
  const logResult = eventLog.loadEvents();
  for (const ev of logResult.events) {
    if (ev.orderId && ev.orderId > 0) {
      allOrderIds.push(ev.orderId);
    }
  }
  if (allOrderIds.length > 0) {
    ibkr.sequencer.arm(Math.max(...allOrderIds));
  }

  try {
    await ibkr.connect();
    // Wait for actual TCP connection (connect() resolves before connected event)
    if (!ibkr.isConnected()) {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => { cleanup(); reject(new Error("timeout")); }, 10_000);
        const onState = (state: string) => {
          if (state === "connected") { cleanup(); resolve(); }
          if (state === "error") { cleanup(); reject(new Error("connection error")); }
        };
        const cleanup = () => { clearTimeout(timeout); ibkr.removeListener("state", onState); };
        ibkr.on("state", onState);
      });
    }
  } catch (e) {
    console.log("[trading-agent] IBKR not available, running in disconnected mode");
  }

  // Initial sync barrier (E3a) + classification (E3b)
  if (ibkr.isConnected()) {
    try {
      const snapshot = await ibkr.runSyncBarrier({ isReconnect: false });
      console.log(
        `[trading-agent] Sync barrier: ${snapshot.ownOrders.length} own, ` +
        `${snapshot.foreignOrders.length} foreign, ${snapshot.positions.length} positions`,
      );
      // E4: reconcile open intents from previous session before guardian
      const openIntents = tracker.getOpenIntents();
      if (openIntents.length > 0) {
        reconcileOpenIntents(openIntents, snapshot, tracker);
      }
      await runClassificationAndGuardian(snapshot);
    } catch (e) {
      console.warn("[trading-agent] Sync barrier failed at startup:", e instanceof Error ? e.message : e);
    }
  }

  // Poll for account summary + Yahoo enrichment
  await pollIBKR();
  console.log(`[trading-agent] Initial sync: ${currentStatus.positions.length} positions, cash $${currentStatus.cashBalance.toFixed(0)}, net $${currentStatus.netLiquidation.toFixed(0)}`);
  console.log(`[trading-agent] Market: ${marketStatusLabel()}`);

  // Initial earnings cache refresh
  refreshEarningsCache().catch((e) =>
    console.log("[earnings] Initial refresh error:", e instanceof Error ? e.message : e),
  );

  // Start polling
  pollTimer = setInterval(() => {
    pollIBKR().catch((e) => console.error("[trading-agent] Poll error:", e));
  }, POLL_INTERVAL);

  // If market is already open at startup, set grace period to avoid stale-scan false alarm
  if (isMarketOpen()) {
    marketOpenedAt = Date.now();
    console.log("[watchdog] Market already open at startup — grace period active");
  }

  // Start watchdog (every 5 minutes)
  watchdogTimer = setInterval(() => {
    watchdogTick().catch((e) => console.error("[watchdog] Error:", e));
  }, WATCHDOG_INTERVAL);
  console.log("[watchdog] Started (interval: 5min)");

  // Periodic sync barrier — 5 min cycle, independent of pollIBKR (E3a + E3b)
  // Collects orders + positions only (no exec backfill on periodic runs)
  const SYNC_BARRIER_INTERVAL = 5 * 60_000;
  setInterval(async () => {
    if (!ibkr.isConnected() || ibkr.syncInProgress) return;
    try {
      const snapshot = await ibkr.runSyncBarrier({ isReconnect: false });
      await runClassificationAndGuardian(snapshot);
    } catch (e) {
      console.warn("[sync] Periodic sync error:", e instanceof Error ? e.message : e);
    }
  }, SYNC_BARRIER_INTERVAL);

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
