import { readFileSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import { IBKRConnection } from "./ibkr.js";
import { UniverseManager } from "./universe-manager.js";
import { OrderExecutor } from "./executor.js";
import {
  loadStatus,
  saveStatus,
  defaultStatus,
  loadWatchlist,
  addToWatchlist,
  removeFromWatchlist,
  loadStrategies,
  loadOrders,
  recordDailyPerformance,
  loadUniverse,
  loadUniverseConfig,
  saveUniverseConfig,
  loadRecentScanResults,
  type TradingStatus,
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

// ── Polling ──

async function pollIBKR(): Promise<void> {
  const connected = ibkr.isConnected();
  const positions = connected ? await ibkr.reqPositions() : currentStatus.positions;
  const account = connected ? await ibkr.reqAccountSummary() : null;

  const hasFreshAccount = !!account?.received;
  const suspiciousZeroSnapshot =
    hasFreshAccount &&
    account!.netLiquidation === 0 &&
    account!.cashBalance === 0 &&
    positions.length > 0;

  currentStatus = {
    ...currentStatus,
    connected,
    paperMode: true,
    account: ibkr.getAccount() || currentStatus.account,
    positions,
    dailyPnl: hasFreshAccount ? account!.dailyPnl : currentStatus.dailyPnl,
    unrealizedPnl: hasFreshAccount ? account!.unrealizedPnl : currentStatus.unrealizedPnl,
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

app.get("/universe/top", (_req, res) => {
  const limit = Number((_req.query as any).limit) || 10;
  res.json(universeManager.getTopCandidates(limit));
});

// ── Startup ──

async function start(): Promise<void> {
  const labels: Record<number, string> = { 1: "Monitoring", 2: "Semi-Auto", 3: "Full-Auto" };
  console.log(`[trading-agent] Starting on ${BIND}:${PORT} — Mode ${currentStatus.mode} (${labels[currentStatus.mode] || "?"})`);

  // Connect to IBKR (non-blocking, graceful degradation)
  ibkr.on("state", (state: string) => {
    console.log(`[trading-agent] IBKR state: ${state}`);
  });

  try {
    await ibkr.connect();
  } catch (e) {
    console.log("[trading-agent] IBKR not available, running in disconnected mode");
  }

  // Initial poll
  await pollIBKR();

  // Start polling
  pollTimer = setInterval(() => {
    pollIBKR().catch((e) => console.error("[trading-agent] Poll error:", e));
  }, POLL_INTERVAL);

  // Wire auto-execution callback for scheduled scans
  universeManager.onMomentumScan = async (results) => {
    if (currentStatus.mode === 3 && results.length > 0) {
      const trades = await executor.executeAfterScan(results);
      if (trades.length > 0) {
        console.log(`[trading-agent] Scheduled auto-execution: ${trades.length} trades`);
      }
    }
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
