/**
 * risk-rules — Tageslimit und Mindestanforderungen an Stop und Ziel
 * (Option B, Owner-Entscheidung 27.10.2026).
 *
 * Tageslimit: Ist die NLV gegenüber dem Vortagsschluss um mehr als
 * `maxLossPercent` gefallen, werden keine neuen Käufe mehr platziert.
 * Ausstiege (Stop, Ziel, Guardian) laufen unverändert weiter. Gemessen wird
 * an der NLV, weil das Paper-Konto als DailyPnL immer 0 meldet.
 *
 * Levels: Die KI-Levels gelten nur, wenn der Stop mindestens `minStopPercent`
 * unter dem Einstieg liegt und das Chance-Risiko-Verhältnis mindestens
 * `minRewardRisk` beträgt. Sonst gelten die Standardlevels (Stop −stopLoss %,
 * Ziel +2 × stopLoss %). Auswertung 27.10.2026: Von 115 Kaufsignalen ≥ 0,75
 * hatten die KI-Levels ein mittleres CRV von 0,92.
 */

export interface DailyLossConfig {
  enabled: boolean;
  maxLossPercent: number;
}

export interface LevelRules {
  minRewardRisk: number;
  minStopPercent: number;
}

export interface DailyLossCheck {
  blocked: boolean;
  /** Verlust seit Vortagsschluss in $ (positiv = Verlust); null ohne Vergleichswert. */
  lossUsd: number | null;
  limitUsd: number | null;
  reason: string;
}

export function checkDailyLoss(
  previousNlv: number | null | undefined,
  currentNlv: number | null | undefined,
  cfg: DailyLossConfig,
): DailyLossCheck {
  if (!cfg.enabled) return { blocked: false, lossUsd: null, limitUsd: null, reason: "Tageslimit aus" };
  if (!previousNlv || !Number.isFinite(previousNlv) || previousNlv <= 0 || !currentNlv || !Number.isFinite(currentNlv) || currentNlv <= 0) {
    /* Ohne Vergleichswert kein Block — aber sichtbar im Log, damit es auffällt. */
    return { blocked: false, lossUsd: null, limitUsd: null, reason: "Tageslimit nicht prüfbar (Vortags-NLV oder NLV fehlt)" };
  }
  const lossUsd = previousNlv - currentNlv;
  const limitUsd = previousNlv * (cfg.maxLossPercent / 100);
  const blocked = lossUsd >= limitUsd;
  return {
    blocked,
    lossUsd,
    limitUsd,
    reason: blocked
      ? `Tageslimit erreicht: −${lossUsd.toFixed(0)} $ seit Vortag (Grenze ${cfg.maxLossPercent} % = ${limitUsd.toFixed(0)} $)`
      : `Tageslimit frei: ${lossUsd >= 0 ? "−" : "+"}${Math.abs(lossUsd).toFixed(0)} $ seit Vortag (Grenze ${limitUsd.toFixed(0)} $)`,
  };
}

export interface Levels {
  limitPrice: number;
  stopPrice: number;
  takeProfitPrice: number;
  source: "ki" | "standard";
  reason: string;
}

export interface AiLevels {
  suggestedEntry?: number;
  suggestedStop?: number;
  suggestedTarget?: number;
}

export function chooseLevels(
  currentPrice: number,
  ai: AiLevels,
  stopLossPercent: number,
  rules: LevelRules,
  roundTick: (p: number) => number,
): Levels {
  const standard = (reason: string): Levels => ({
    limitPrice: roundTick(currentPrice * 1.001),
    stopPrice: roundTick(currentPrice * (1 - stopLossPercent / 100)),
    takeProfitPrice: roundTick(currentPrice * (1 + (stopLossPercent * 2) / 100)),
    source: "standard",
    reason,
  });
  if (!ai.suggestedEntry || !ai.suggestedStop || !ai.suggestedTarget) return standard("KI ohne Levels");
  const entry = roundTick(ai.suggestedEntry);
  const stop = roundTick(ai.suggestedStop);
  const target = roundTick(ai.suggestedTarget);
  if (!(stop < entry && target > entry)) return standard("KI-Levels unstimmig");
  const stopPercent = ((entry - stop) / entry) * 100;
  const rewardRisk = (target - entry) / (entry - stop);
  if (stopPercent < rules.minStopPercent) {
    return standard(`KI-Stop zu eng (${stopPercent.toFixed(2)} % < ${rules.minStopPercent} %)`);
  }
  if (rewardRisk < rules.minRewardRisk) {
    return standard(`KI-CRV zu klein (${rewardRisk.toFixed(2)} < ${rules.minRewardRisk})`);
  }
  return {
    limitPrice: entry,
    stopPrice: stop,
    takeProfitPrice: target,
    source: "ki",
    reason: `KI-Levels (Stop ${stopPercent.toFixed(2)} %, CRV ${rewardRisk.toFixed(2)})`,
  };
}
