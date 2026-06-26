import { describe, it, expect } from "vitest";
import { AlertManager } from "../src/alert-manager.js";
import { checkExitCoverage } from "../src/watchdog-metrics.js";
import type { ClassificationResult } from "../src/position-classifier.js";
import type { ExitState } from "../src/order-state-tracker.js";
import type { GuardianAlertCache } from "../src/position-guardian.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

// ─── R4a: resolve() only sends recovery if Telegram was pushed ──────────────

describe("AlertManager — R4a resolve gate", () => {

  it("resolve sends recovery when alert was actually sent", async () => {
    const { sent, sender } = createCaptureSender();
    const am = new AlertManager(sender);

    // WARN gets sent (first time, dedup window not active)
    await am.sendAlert("test_key", "WARN", "problem detected");
    expect(sent).toHaveLength(1);

    // resolve → should send recovery
    await am.resolve("test_key");
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain("Alert behoben");
  });

  it("resolve does NOT send recovery when alert was suppressed (dedup window)", async () => {
    const { sent, sender } = createCaptureSender();
    const am = new AlertManager(sender);

    // First WARN gets sent
    await am.sendAlert("test_key", "WARN", "problem 1");
    expect(sent).toHaveLength(1);
    // Resolve it
    await am.resolve("test_key");
    expect(sent).toHaveLength(2); // recovery sent
    sent.length = 0;

    // Re-trigger within dedup window — suppressed, no Telegram
    await am.sendAlert("test_key", "WARN", "problem 2");
    expect(sent).toHaveLength(0); // suppressed

    // Resolve — no recovery should be sent (nothing was pushed)
    await am.resolve("test_key");
    expect(sent).toHaveLength(0);
  });

  it("resolve sends recovery for CRITICAL (always sent)", async () => {
    const { sent, sender } = createCaptureSender();
    const am = new AlertManager(sender);

    await am.sendAlert("crit_key", "CRITICAL", "critical issue");
    expect(sent).toHaveLength(1);

    await am.resolve("crit_key");
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain("Alert behoben");
  });
});

// ─── R4b: qty_undercoverage grace window ────────────────────────────────────

describe("checkExitCoverage — R4b qty_undercoverage grace", () => {

  it("first observation of undercoverage does NOT alert (grace window)", async () => {
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

    await checkExitCoverage(
      classification,
      (conId) => exitStates[conId] ?? null,
      alertManager,
      cache,
      ESCALATION_MS,
    );

    // Grace: no alert yet, but cache entry created with alertedAt=0
    expect(sent).toHaveLength(0);
    expect(cache.has("watchdog_qty_undercoverage")).toBe(true);
    expect(cache.get("watchdog_qty_undercoverage")!.alertedAt).toBe(0);
  });

  it("alerts after grace window expires (persistent undercoverage)", async () => {
    const { sent, sender } = createCaptureSender();
    const alertManager = new AlertManager(sender);
    const cache: GuardianAlertCache = new Map();

    // Pre-seed: first seen 100s ago (> 90s grace)
    cache.set("watchdog_qty_undercoverage", {
      state: "qty_undercoverage",
      alertedAt: 0,
      firstSeenAt: Date.now() - 100_000,
    });

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

    await checkExitCoverage(
      classification,
      (conId) => exitStates[conId] ?? null,
      alertManager,
      cache,
      ESCALATION_MS,
    );

    // Grace expired → WARN sent
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Qty Undercoverage");
    expect(cache.get("watchdog_qty_undercoverage")!.alertedAt).toBeGreaterThan(0);
  });

  it("transient that clears within grace → zero messages", async () => {
    const { sent, sender } = createCaptureSender();
    const alertManager = new AlertManager(sender);
    const cache: GuardianAlertCache = new Map();

    // Pre-seed: first seen 30s ago (< 90s grace), not yet alerted
    cache.set("watchdog_qty_undercoverage", {
      state: "qty_undercoverage",
      alertedAt: 0,
      firstSeenAt: Date.now() - 30_000,
    });

    // Now call with full coverage (transient resolved)
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

    await checkExitCoverage(
      classification,
      (conId) => exitStates[conId] ?? null,
      alertManager,
      cache,
      ESCALATION_MS,
    );

    // Transient cleared before grace → no alert, no recovery, cache cleared
    expect(sent).toHaveLength(0);
    expect(cache.has("watchdog_qty_undercoverage")).toBe(false);
  });
});

// ─── R1: Fail-loud on AI eval errors ────────────────────────────────────────

describe("R1 — AI eval fail-loud alert", () => {

  it("ai_eval_failing alert fires when evalError count exceeds threshold", async () => {
    const { sent, sender } = createCaptureSender();
    const alertManager = new AlertManager(sender);

    // Simulate: 3 out of 4 evaluations failed
    const totalEvaluated = 4;
    const evalErrors = [
      { symbol: "AAPL", detail: "Anthropic API 404: model not found" },
      { symbol: "MSFT", detail: "Anthropic API 404: model not found" },
      { symbol: "GOOG", detail: "Anthropic API 404: model not found" },
    ];

    // Threshold check: >= 3 errors OR >= 50%
    if (totalEvaluated > 0 && (evalErrors.length >= 3 || evalErrors.length / totalEvaluated >= 0.5)) {
      const sample = evalErrors[0]?.detail || "unknown";
      await alertManager.sendAlert("ai_eval_failing", "WARN", [
        `\u26a0\ufe0f *KI-Eval Fehler*`,
        ``,
        `${evalErrors.length}/${totalEvaluated} Bewertungen fehlgeschlagen`,
        `Beispiel: ${sample}`,
      ].join("\n"));
    }

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("KI-Eval Fehler");
    expect(sent[0]).toContain("3/4");
    expect(sent[0]).toContain("404");
  });

  it("no alert when all evaluations succeed", async () => {
    const { sent, sender } = createCaptureSender();
    const alertManager = new AlertManager(sender);

    const totalEvaluated = 5;
    const evalErrors: { symbol: string; detail: string }[] = [];

    if (totalEvaluated > 0 && (evalErrors.length >= 3 || evalErrors.length / totalEvaluated >= 0.5)) {
      await alertManager.sendAlert("ai_eval_failing", "WARN", "should not fire");
    } else if (totalEvaluated > 0 && evalErrors.length === 0) {
      if (alertManager.isActive("ai_eval_failing")) {
        await alertManager.resolve("ai_eval_failing");
      }
    }

    expect(sent).toHaveLength(0);
  });

  it("resolve fires after clean cycle following previous alert", async () => {
    const { sent, sender } = createCaptureSender();
    const alertManager = new AlertManager(sender);

    // First: alert fires
    await alertManager.sendAlert("ai_eval_failing", "WARN", "3/4 failed");
    expect(sent).toHaveLength(1);

    // Then: clean cycle — resolve
    if (alertManager.isActive("ai_eval_failing")) {
      await alertManager.resolve("ai_eval_failing");
    }

    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain("Alert behoben");
  });
});
