import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  appendDecision,
  loadRecentDecisions,
  loadOrders,
  type DecisionRecord,
  type ScanResult,
} from "./store.js";
import type { OrderStateTracker } from "./order-state-tracker.js";

// ── API Key ──

function readAnthropicKey(): string {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  try {
    const envPath = join(process.env.HOME || "/home/biko", ".config/openclaw/env");
    const content = readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      if (line.startsWith("#") || !line.includes("=")) continue;
      const eq = line.indexOf("=");
      const key = line.slice(0, eq).trim();
      const val = line.slice(eq + 1).trim();
      if (key === "ANTHROPIC_API_KEY" && val) return val;
    }
  } catch {}
  return "";
}

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

// ── Claude API Call ──

async function callClaude(prompt: string): Promise<string> {
  const apiKey = readAnthropicKey();
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 512,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${err}`);
  }

  const data: any = await res.json();
  return data?.content?.[0]?.text || "";
}

// ── Trade Evaluation ──

export interface TradeDecision {
  decision: "BUY" | "SKIP";
  confidence: number;
  reasoning: string;
  suggestedEntry?: number;
  suggestedStop?: number;
  suggestedTarget?: number;
}

export async function evaluateTrade(
  candidate: ScanResult,
  currentPrice: number,
  sectorPerformance?: string,
  earningsInfo?: string,
  tracker?: OrderStateTracker,
): Promise<TradeDecision> {
  // Build context from trade history for this symbol (legacy + tracker)
  const legacyOrders = loadOrders()
    .filter((o) => o.symbol === candidate.symbol)
    .slice(-5)
    .map((o) => ({
      line: `${o.side} ${o.quantity} @ $${o.price.toFixed(2)} (${o.status}, ${o.timestamp.slice(0, 10)})`,
      ts: o.timestamp,
    }));

  const trackerOrders = tracker
    ? tracker.getRecentFills({ symbol: candidate.symbol, leg: "entry" })
        .slice(0, 5)
        .map((t) => ({
          line: `${t.side} ${t.quantity} @ $${(t.fillPrice ?? t.price).toFixed(2)} (${t.status}, ${t.timestamp.slice(0, 10)})`,
          ts: t.timestamp,
        }))
    : [];

  // Merge, dedup by timestamp, take last 5
  const seen = new Set<string>();
  const merged = [...legacyOrders, ...trackerOrders]
    .filter((e) => { if (seen.has(e.ts)) return false; seen.add(e.ts); return true; })
    .sort((a, b) => a.ts.localeCompare(b.ts))
    .slice(-5);

  const tradeHistory = merged.length > 0
    ? merged.map((e) => e.line).join("\n")
    : "Keine bisherigen Trades für dieses Symbol.";

  // Build recent AI decisions for context
  const recentDecisions = loadRecentDecisions(10)
    .filter((d) => d.timestamp > new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());

  const recentDecisionsSummary = recentDecisions.length > 0
    ? recentDecisions.map((d) =>
        `${d.symbol}: ${d.decision} (confidence: ${d.confidence.toFixed(2)}) - ${d.reasoning}`
      ).join("\n")
    : "Keine Entscheidungen in den letzten 24h.";

  const ind = candidate.indicators;

  // Volume context: expected ratio depends on time of day
  const now = new Date();
  const utcH = now.getUTCHours();
  const utcM = now.getUTCMinutes();
  const minutesSinceUSOpen = (utcH - 13) * 60 + (utcM - 30); // NYSE opens 13:30 UTC
  const tradingMinutesTotal = 390; // 6.5h trading day
  const expectedRatio = minutesSinceUSOpen > 0
    ? Math.min(minutesSinceUSOpen / tradingMinutesTotal, 1.0)
    : 0;
  const volRatio = ind?.volumeRatio ?? 0;
  const adjustedVolRatio = expectedRatio > 0 ? volRatio / expectedRatio : volRatio;

  const volumeContext = expectedRatio > 0 && expectedRatio < 0.8
    ? `Volume Ratio (vs Tages-Durchschnitt): ${volRatio.toFixed(2)} — WICHTIG: Es sind erst ${(expectedRatio * 100).toFixed(0)}% des Handelstages vergangen. Erwarteter Ratio zu diesem Zeitpunkt: ~${expectedRatio.toFixed(2)}. Tageszeit-bereinigter Ratio: ${adjustedVolRatio.toFixed(2)} (>1.0 = überdurchschnittlich für diese Uhrzeit)`
    : `Volume Ratio (vs Tages-Durchschnitt): ${volRatio.toFixed(2)}`;

  const indicatorText = ind
    ? [
        `RSI(14): ${ind.rsi?.toFixed(1) ?? "n/a"}`,
        `EMA9: ${ind.ema9?.toFixed(2) ?? "n/a"}`,
        `EMA21: ${ind.ema21?.toFixed(2) ?? "n/a"}`,
        `BB Upper: ${ind.bb_upper?.toFixed(2) ?? "n/a"}`,
        `BB Lower: ${ind.bb_lower?.toFixed(2) ?? "n/a"}`,
        `VWAP: ${ind.vwap?.toFixed(2) ?? "n/a"}`,
        volumeContext,
      ].join("\n")
    : "Keine Indikator-Daten verfügbar.";

  const prompt = `Du bist ein erfahrener quantitativer Trader. Analysiere den folgenden Trade-Kandidaten und entscheide, ob ein Kauf sinnvoll ist.

## Kandidat
Symbol: ${candidate.symbol}
Signal: ${candidate.signal}
Signal-Stärke: ${candidate.strength}
Aktueller Kurs: $${currentPrice.toFixed(2)}

## Technische Indikatoren
${indicatorText}

## Sektor-Performance
${sectorPerformance || "Nicht verfügbar"}

## Earnings
${earningsInfo || "Keine anstehenden Earnings bekannt"}

## Trade-Historie für ${candidate.symbol}
${tradeHistory}

## Letzte KI-Entscheidungen (24h)
${recentDecisionsSummary}

## Aufgabe
Bewerte diesen Trade-Kandidaten. Berücksichtige:
1. Technische Signalstärke und Indikator-Konsistenz
2. Risiko-Ertrags-Verhältnis
3. Aktuelle Marktbedingungen
4. Ob wir bereits ähnliche Positionen haben
5. Earnings-Risiko (Gap-Risiko vor Quartalszahlen)

WICHTIG zum Volumen: Der Volume Ratio vergleicht bisheriges Tagesvolumen mit dem vollen 10-Tages-Durchschnitt. Früh am Tag (z.B. 30min nach Open) ist ein Ratio von 0.15-0.30 völlig normal. Nutze den tageszeit-bereinigten Ratio als Maßstab — ein bereinigter Ratio >1.0 bedeutet überdurchschnittliches Volumen für diese Uhrzeit. Lehne NICHT allein wegen niedrigem Raw-Ratio ab.

Antworte NUR mit validem JSON in diesem Format:
{
  "decision": "BUY" oder "SKIP",
  "confidence": 0.0 bis 1.0,
  "reasoning": "Begründung in maximal 2 Sätzen",
  "suggestedEntry": Einstiegskurs,
  "suggestedStop": Stop-Loss-Kurs,
  "suggestedTarget": Kursziel
}`;

  try {
    const response = await callClaude(prompt);

    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.log(`[ai-decision] No JSON in response for ${candidate.symbol}:`, response.slice(0, 200));
      return { decision: "SKIP", confidence: 0, reasoning: "KI-Antwort konnte nicht geparst werden" };
    }

    const parsed = JSON.parse(jsonMatch[0]) as TradeDecision;

    // Validate and clamp confidence
    parsed.confidence = Math.max(0, Math.min(1, parsed.confidence || 0));
    parsed.decision = parsed.decision === "BUY" ? "BUY" : "SKIP";

    // Log the decision
    const record: DecisionRecord = {
      id: `DEC-${Date.now()}`,
      symbol: candidate.symbol,
      signal: candidate.signal,
      decision: parsed.decision,
      confidence: parsed.confidence,
      reasoning: parsed.reasoning || "",
      suggestedEntry: parsed.suggestedEntry,
      suggestedStop: parsed.suggestedStop,
      suggestedTarget: parsed.suggestedTarget,
      indicators: candidate.indicators,
      price: currentPrice,
      timestamp: new Date().toISOString(),
    };
    appendDecision(record);

    console.log(`[ai-decision] ${candidate.symbol}: ${parsed.decision} (confidence: ${parsed.confidence.toFixed(2)}) — ${parsed.reasoning}`);

    return parsed;
  } catch (e) {
    console.log(`[ai-decision] Error evaluating ${candidate.symbol}:`, e instanceof Error ? e.message : e);

    // Log failed evaluation
    appendDecision({
      id: `DEC-${Date.now()}`,
      symbol: candidate.symbol,
      signal: candidate.signal,
      decision: "SKIP",
      confidence: 0,
      reasoning: `KI-Fehler: ${e instanceof Error ? e.message : String(e)}`,
      indicators: candidate.indicators,
      price: currentPrice,
      timestamp: new Date().toISOString(),
    });

    return { decision: "SKIP", confidence: 0, reasoning: "KI-Bewertung fehlgeschlagen" };
  }
}

// ── Confidence Threshold ──

export const CONFIDENCE_THRESHOLD = 0.75;

export function shouldExecuteTrade(decision: TradeDecision): boolean {
  return decision.decision === "BUY" && decision.confidence >= CONFIDENCE_THRESHOLD;
}
