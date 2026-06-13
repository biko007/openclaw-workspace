import { describe, it, expect } from "vitest";
import { checkExitCoverage } from "../src/watchdog-metrics.js";
import { AlertManager } from "../src/alert-manager.js";
import type { ClassificationResult } from "../src/position-classifier.js";
import type { ExitState } from "../src/order-state-tracker.js";
import type { GuardianAlertCache } from "../src/position-guardian.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** No-op Telegram sender — captures sent messages for assertions. */
function createCaptureSender(): { sent: string[]; sender: (text: string) => Promise<void> } {
  const sent: string[] = [];
  return { sent, sender: async (text: string) => { sent.push(text); } };
}

function makeClassification(
  positions: { symbol: string; conId: number; positionQty: number; state: string }[],
): ClassificationResult {
  const stateCount: Record<string, number> = {};
  const classifiedPositions = positions.map((p) => {
    stateCount[p.state] = (stateCount[p.state] ?? 0) + 1;
    return {
      symbol: p.symbol,
      conId: p.conId,
      exchange: "SMART",
      currency: "USD",
      positionQty: p.positionQty,
      state: p.state as any,
      details: "",
    };
  });
  return {
    positions: classifiedPositions,
    orphans: [],
    legacyOwn: [],
    stateCount,
    foreignCount: 0,
  };
}

const ESCALATION_MS = 15 * 60 * 1000;

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("checkExitCoverage (E8a)", () => {

  it("qty_undercoverage WARN when stopQty < positionQty", async () => {
    const { sent, sender } = createCaptureSender();
    const alertManager = new AlertManager(sender);
    const cache: GuardianAlertCache = new Map();

    const classification = makeClassification([
      { symbol: "AAPL", conId: 265598, positionQty: 100, state: "protected" },
    ]);

    const exitStates: Record<number, ExitState> = {
      265598: {
        qty: 100,
        gen: 0,
        stopOrder: { orderRef: "OCAGENT|DUP|AAPL|265598|stop|0", status: "PreSubmitted" },
        tpOrder: { orderRef: "OCAGENT|DUP|AAPL|265598|tp|0", status: "PreSubmitted" },
        stopQty: 50,
        tpQty: 50,
      },
    };

    const result = await checkExitCoverage(
      classification,
      (conId) => exitStates[conId] ?? null,
      alertManager,
      cache,
      ESCALATION_MS,
    );

    expect(result.exitsIncomplete).toBe(0);
    expect(result.stopCoverage).toBe(0.5);
    expect(result.tpCoverage).toBe(0.5);
    expect(result.exitsLabel).toBe("1/1");

    // WARN should have been sent for qty_undercoverage
    expect(sent.length).toBe(1);
    expect(sent[0]).toContain("Qty Undercoverage");
    expect(sent[0]).toContain("50%");
    expect(cache.has("watchdog_qty_undercoverage")).toBe(true);
  });

  it("full coverage → no qty_undercoverage alert", async () => {
    const { sent, sender } = createCaptureSender();
    const alertManager = new AlertManager(sender);
    const cache: GuardianAlertCache = new Map();

    const classification = makeClassification([
      { symbol: "AAPL", conId: 265598, positionQty: 100, state: "protected" },
    ]);

    const exitStates: Record<number, ExitState> = {
      265598: {
        qty: 100,
        gen: 0,
        stopOrder: { orderRef: "OCAGENT|DUP|AAPL|265598|stop|0", status: "PreSubmitted" },
        tpOrder: { orderRef: "OCAGENT|DUP|AAPL|265598|tp|0", status: "PreSubmitted" },
        stopQty: 100,
        tpQty: 100,
      },
    };

    const result = await checkExitCoverage(
      classification,
      (conId) => exitStates[conId] ?? null,
      alertManager,
      cache,
      ESCALATION_MS,
    );

    expect(result.exitsIncomplete).toBe(0);
    expect(result.stopCoverage).toBe(1);
    expect(result.tpCoverage).toBe(1);
    expect(sent).toHaveLength(0);
    expect(cache.size).toBe(0);
  });

  it("exits_incomplete WARN when position not protected", async () => {
    const { sent, sender } = createCaptureSender();
    const alertManager = new AlertManager(sender);
    const cache: GuardianAlertCache = new Map();

    const classification = makeClassification([
      { symbol: "MSFT", conId: 272093, positionQty: 50, state: "missing_stop" },
    ]);

    const result = await checkExitCoverage(
      classification,
      () => null,
      alertManager,
      cache,
      ESCALATION_MS,
    );

    expect(result.exitsIncomplete).toBe(1);
    expect(result.exitsLabel).toBe("0/1");

    // WARN for exits_incomplete
    expect(sent.length).toBe(1);
    expect(sent[0]).toContain("Exit Coverage");
    expect(sent[0]).toContain("not fully protected");
    expect(cache.has("watchdog_exits_incomplete")).toBe(true);
  });

  it("recovery resolves alerts", async () => {
    const { sent, sender } = createCaptureSender();
    const alertManager = new AlertManager(sender);
    const cache: GuardianAlertCache = new Map();

    // Pre-seed: simulate a prior exits_incomplete alert that was sent
    cache.set("watchdog_exits_incomplete", { state: "exits_incomplete", alertedAt: Date.now() - 60_000 });
    // Also seed the alertManager state so resolve() sends a recovery message
    await alertManager.sendAlert("watchdog_exits_incomplete", "WARN", "prior alert");
    sent.length = 0; // clear the setup message

    const classification = makeClassification([
      { symbol: "AAPL", conId: 265598, positionQty: 100, state: "protected" },
    ]);

    const exitStates: Record<number, ExitState> = {
      265598: {
        qty: 100,
        gen: 0,
        stopOrder: { orderRef: "OCAGENT|DUP|AAPL|265598|stop|0", status: "PreSubmitted" },
        tpOrder: { orderRef: "OCAGENT|DUP|AAPL|265598|tp|0", status: "PreSubmitted" },
        stopQty: 100,
        tpQty: 100,
      },
    };

    const result = await checkExitCoverage(
      classification,
      (conId) => exitStates[conId] ?? null,
      alertManager,
      cache,
      ESCALATION_MS,
    );

    expect(result.exitsIncomplete).toBe(0);
    expect(result.stopCoverage).toBe(1);
    expect(result.tpCoverage).toBe(1);

    // guardianAlertCache should be cleared
    expect(cache.has("watchdog_exits_incomplete")).toBe(false);

    // AlertManager should have sent a RESOLVED message
    expect(sent.length).toBe(1);
    expect(sent[0]).toContain("Alert behoben");
  });
});
