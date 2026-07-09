# Evidence Bundle: Trading Daily-Report Fix (C1+C2)

**Datum:** 2026-07-09
**Arbeitspaket:** Fix Trading Daily-Report — Manual Close Tracking + Paper-Account dailyPnl
**Autor:** Claude Opus 4.6

---

## Commits

| Hash | Nachricht |
|------|-----------|
| `0cb65e5` | fix(trading): track manual/sentinel closes + paper-account dailyPnl |

---

## Betroffene Regeln

| ID | Regel | Bezug |
|----|-------|-------|
| GOV-007 | TypeScript Build fehlerfrei | Build-Gate nach Aenderungen |
| GOV-008 | Smoke-Test 28/28 | Smoke nach Restart |

---

## Ausgangslage (Verifikation vom selben Tag)

| Check | Verdikt | Ursache |
|-------|---------|---------|
| C1 dailyPnl | FAIL | IBKR Paper-Account (DUP514636) liefert DailyPnL=0 |
| C2 Win/Loss | FAIL | Manuelle Closes erzeugen keine SELL-Records |
| C3 Wording | PASS | "Beste offene Position" korrekt |

---

## Durchgefuehrte Arbeiten

### C2-Fix: Position-Closed Event Type

**Dateien:** `src/order-state-tracker.ts`

- Neuer Event-Typ `position_closed` im OrderStateTracker
- Interface `PositionClosedEvent`: symbol, quantity, entryPrice, exitPrice, pnl, pnlPercent, source
- `source`: `"manual"` (API /close/:symbol) oder `"sentinel"` (pollIBKR Positionserkennung)
- In-Memory-Index `_closedPositions` mit Dedup via `closedDedupeSet`
- `getRecentFills()` liefert position_closed Events als SELL-Fills (mit source/pnl Feldern)
- `hasRecentClose(symbol, withinMs)` fuer Sentinel-Dedup
- `TrackerTradeRecord` erweitert um optionale Felder `source` und `pnl`

### C2-Fix: Close-Pfade schreiben Events

**Dateien:** `src/index.ts`

- `POST /close/:symbol`: Schreibt `position_closed` mit source=`"manual"` nach erfolgreichem Fill.
  `apiClosedSymbols` Set verhindert Doppel-Record durch Sentinel (120s TTL).
- `notifyPositionClosed()`: Schreibt `position_closed` mit source=`"sentinel"` NUR wenn:
  1. Kein API-Close-Flag (`apiClosedSymbols`)
  2. Kein kuerzlicher Close im Tracker (`hasRecentClose`)
  3. Kein Bracket-Exit-Fill heute fuer dieses Symbol

### C2-Fix: Daily Report Manual-Close-Zaehlung

- `todayExits` enthaelt jetzt position_closed Events via erweitertes `getRecentFills()`
- Win/Loss nutzt `pnl`-Feld aus position_closed (kein Entry-Lookup noetig)
- Neue Zeile: "davon manuell: N" bei manualCloseCount > 0
- 30-Tage-Statistik integriert Tracker-Exits (inkl. position_closed)

### C1-Fix: Computed dailyPnl

- Wenn IBKR `dailyPnl === 0`: Eigene Berechnung aus
  `realizedPnlToday` (Summe aller Exit-P&L) + `unrealizedDelta` (aktuell - Vortag)
- Vortages-Unrealized aus `loadPreviousDayPerformance()` (neu in store.ts)
- Kennzeichnung: `"~"` Praefix im Report wenn berechnet
- Live-Account-Pfad (IBKR liefert non-zero) unveraendert

### Backfill: NKE + GILD Juli-Closes

- 2 synthetische `position_closed` Events in `orders-v2.jsonl` nachgetragen
- NKE: 2026-07-02T13:30:31Z, 1355 Stk, +$833.32, source=sentinel
- GILD: 2026-07-07T13:31:28Z, 485 Stk, +$3,348.92, source=sentinel
- Daten aus Journal-Logs extrahiert, Entry-Preise aus Tracker/Legacy verifiziert

### Tests

- Neues Testfile `tests/manual-close-tracking.test.ts` (15 Tests, 5 Gruppen):
  1. position_closed Event-Persistenz (3 Tests)
  2. getRecentFills Integration (3 Tests)
  3. hasRecentClose (2 Tests)
  4. Win/Loss Zaehlung (3 Tests)
  5. Computed dailyPnl Logik (4 Tests)

---

## Gate-Outputs

### `npm run build` (tsc)
Exit 0 — clean.

### `npm run verify:commands`
Exit 0 — 112/112 bidirektional konsistent.

### `systemctl --user restart openclaw-trading`
Active: active (running).

### `systemctl --user restart openclaw-gateway`
Active: active (running).

### `bun run scripts/smoke-test.ts`
ALL PASS (28/28).

### `npx vitest run tests/manual-close-tracking.test.ts`
15/15 PASS.

### Vorbestehende Test-Failures (nicht durch diese Aenderung verursacht)
- `tests/watchdog-metrics.test.ts`: 6 Failures (recovery/resolve alerts)
- `tests/alert-hygiene.test.ts`: 3 Failures
- Identisch mit Baseline vor diesem Commit (verifiziert via git stash + Testlauf)

---

## Owner-Approval

- [ ] Review durch Owner

## Doku-Aenderung

- Kein CLAUDE.md-Update noetig (CLAUDE.md des trading-agent dokumentiert Daily-Report-Fixes bereits unter "Daily-Report-Fixes (ab 2026-07-03)")

## Offene Risiken

- Paper-Account dailyPnl bleibt eine Schaetzung (~Praefix kennzeichnet dies)
- Unrealized-Delta haengt von der Qualitaet der Yahoo-Finance-Preise ab
- Vorbestehende Test-Failures in watchdog-metrics + alert-hygiene (kein Bezug zu dieser Aenderung)
