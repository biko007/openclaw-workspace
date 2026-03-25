import express from "express";
import { IBKRConnection } from "./ibkr.js";
import { UniverseManager } from "./universe-manager.js";
import {
  loadStatus,
  saveStatus,
  defaultStatus,
  loadWatchlist,
  addToWatchlist,
  removeFromWatchlist,
  loadStrategies,
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

const ibkr = new IBKRConnection();
const universeManager = new UniverseManager(ibkr);
let currentStatus: TradingStatus = defaultStatus();
let pollTimer: ReturnType<typeof setInterval> | null = null;

// ── Polling ──

async function pollIBKR(): Promise<void> {
  const connected = ibkr.isConnected();
  const positions = connected ? await ibkr.reqPositions() : [];
  const account = connected ? await ibkr.reqAccountSummary() : {
    netLiquidation: 0,
    cashBalance: 0,
    unrealizedPnl: 0,
    realizedPnl: 0,
    dailyPnl: 0,
  };

  currentStatus = {
    mode: 1,
    connected,
    paperMode: true,
    account: ibkr.getAccount(),
    positions,
    dailyPnl: account.dailyPnl,
    unrealizedPnl: account.unrealizedPnl,
    realizedPnl: account.realizedPnl,
    netLiquidation: account.netLiquidation,
    cashBalance: account.cashBalance,
    timestamp: new Date().toISOString(),
  };

  saveStatus(currentStatus);
  recordDailyPerformance(currentStatus);
}

// ── Express ──

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true, connected: ibkr.isConnected() });
});

app.get("/status", (_req, res) => {
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

app.post("/universe/scan", async (_req, res) => {
  try {
    const data = await universeManager.buildActiveUniverse();
    const momentum = await universeManager.scanMomentum();
    const meanRev = await universeManager.scanMeanReversion();
    res.json({
      universe: data.symbols.length,
      momentum: momentum.length,
      meanReversion: meanRev.length,
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get("/universe/top", (_req, res) => {
  const limit = Number((_req.query as any).limit) || 10;
  res.json(universeManager.getTopCandidates(limit));
});

// ── Startup ──

async function start(): Promise<void> {
  console.log(`[trading-agent] Starting on ${BIND}:${PORT}...`);

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
