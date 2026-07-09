# CLAUDE.md — trading-agent

## Task Output Protocol (mandatory — cc and Codex)

- Every cc/Codex task writes its complete result to ONE timestamped file:
  cc → `~/bikosoc-spec/<task>.md`, Codex → `~/codex-audit/bikosoc/<date>-<type>.md`.
- Terminal output is ONLY: `DONE → <path>`. No result content, no diffs, no logs to stdout.
- Owner uploads the FILE for review — never raw terminal scrollback.
- Secrets NEVER go to stdout, logs, or report files. If a secret must be handed over:
  write it to a chmod-600 temp file (or 1Password/op), reference the path, shred after use.
- Auch die Abschluss-Zusammenfassung einer Etappe gehoert in die Report-Datei, NICHT ins Terminal.
  Terminal-Output nach Task-Ende ist ausschliesslich die Zeile `DONE → <Pfad>`.
  Keine Tabellen, keine Summaries im Terminal.

---

## Order-Identität

- **orderRef-Schema:** `OCAGENT|account|tradeIntentId|conId|leg|gen`
- **Legs:** `entry`, `stop`, `tp`, `fbclose`
- **gen:** 0 = initial placement, +1 bei jeder Guardian-Nachrüstung (replacement)
- **OCA-Group:** `OCA|tradeIntentId|gen` — verbindet Stop + TP einer Generation
- **tradeIntentId:** `SYMBOL-YYMMDD-NN` (NN = laufende Nummer pro Tag)

## Durable Event Log

- **Datei:** `orders-v2.jsonl` (append-only, fsync nach jedem Write)
- **Event-Typen:** `order_submitted`, `order_status_changed`, `order_filled`, `order_cancelled`, `order_error`, `replacement_intent_started`, `replacement_intent_confirmed`, `replacement_intent_abandoned`, `fallback_intent_started`, `fallback_intent_confirmed`, `fallback_intent_abandoned`
- **Rebuild beim Start:** Quarantine bei 1 korrupten Zeile (Zeile übersprungen, Warnung), `tradingLocked` bei 2+ korrupten Zeilen (Agent blockiert, CRITICAL-Alert)
- **ExecId-Correction:** gleiche `execIdBase`, höherer Suffix ersetzt älteren Fill-Event (IBKR sendet korrekturen)

## Guardian-Zustände

| Zustand | Aktion |
|---------|--------|
| `protected` | Nichts — vollständig gedeckt |
| `missing_stop` | Nachrüstung: STP + TP neu platzieren (gen+1) |
| `missing_tp` | Nachrüstung: STP + TP neu platzieren (gen+1) |
| `missing_both` | Nachrüstung: STP + TP neu platzieren (gen+1) |
| `qty_mismatch` | Nachrüstung: alte Orders canceln, neue mit korrekter Qty (gen+1) |
| `oca_broken` | Nachrüstung: alte Orders canceln, neue mit gleicher OCA (gen+1) |
| `unreconstructable` | `alert_only` — keine Exit-Orders, kein Intent, kein Legacy. CRITICAL-Alert |
| `foreign_involved` | `alert_only` — Fremd-Orders beteiligt, manuell prüfen. WARN-Alert |

- **Retry-Budget:** max 2 fehlgeschlagene Nachrüstungen pro Stunde pro Symbol
- **fallbackMode:**
  - `market_close` — MKT SELL wenn Preis ≤ Stop und keine aktive STP-Order
  - `alert_only` — nur CRITICAL-Alert via Telegram, kein automatischer Close

## Legacy-Übergangsregel

- **clientId 1 oder 98** = Legacy (TWS oder alter Agent)
- **Regel:** read-only — kein Cancel, kein Placement, nur Alert
- Entfällt wenn alle Legacy-Positionen (BMY, GILD, SO, DUK, IFX, DTE, P911, COP) geschlossen sind

## First-Cycle-Grace

- `classificationCycleCount` = 0 bei Start und Reconnect
- **Cycle 1:** keine Telegram-Alerts (Klassifizierung basiert auf unvollständigem openOrder-Stream)
- Guardian-Aktionen laufen normal, nur Alert-Versand an Telegram unterdrückt

## Watchdog-Metriken

| Check | Beschreibung |
|-------|-------------|
| 1 — IBKR-Verbindung | 3 aufeinanderfolgende Failures → automatischer Gateway-Restart (`systemctl --user restart openclaw-ibkr-gateway`) |
| 2 — Scan-Staleness | >10min seit letztem Scan-Ergebnis, mit 20min Grace nach Market-Open. **Debounce:** erst nach 3 aufeinanderfolgenden stale-Beobachtungen (≈15min bei 5min-Intervall) |
| 3 — Scheduler-Status | WARN wenn Universe-Scheduler gestoppt |
| 4 — Exit-Coverage | `exits_incomplete`: WARN → CRITICAL nach 15min. `qty_undercoverage`: **Grace 90s** — erst nach persistenter Unterdeckung alarmieren, transiente Zustände (Reconnect/Order-Settling) werden geschluckt |

- **OK-Zeile:** `exits=N/N` (N protected / N total) oder `exits=?/?` bei First-Cycle-Grace

## Alert-Hygiene (ab 2026-06-26)

- **Fail-Loud KI-Eval:** Pro Scan-Zyklus werden Eval-Fehler gezählt. Bei ≥3 Fehlern oder ≥50% Fehlerquote: WARN-Alert `ai_eval_failing` mit Beispiel-Fehler. Sauberer Zyklus → resolve.
- **Exit-Fill Dedup:** `notifiedExitFills` Set (keyed by `orderRef`). Ein logischer Fill = eine Telegram-Nachricht, unabhängig von der Anzahl IBKR-Callbacks.
- **resolve() Gate (R4a):** `sentDuringCurrentActivation`-Flag in AlertManager. Recovery-Nachricht nur wenn während der aktuellen Aktivierung tatsächlich eine Telegram-Nachricht gesendet wurde. Verhindert „behoben"-Spam bei supprimierten/deduplizierten Alerts.

## Trade-Event-Telegram (ab 2026-07-03)

- **ENV-Flag:** `TRADE_EVENT_TELEGRAM` (Default: `true`)
- **`false`:** Unterdrückt individuelle Trade-Notifications (Position closed, Exit-Fill, Manual Close)
- **Ungegated:** Daily Report, Daily Health Check, CRITICAL-Alerts, Guardian-Alerts (eigenes `TRADING_ALERTS_TELEGRAM`)
- Gate-Points: `onPositionClosed()`, `POST /close/:symbol`, Exit-Fill Callback

## Daily-Report-Fixes (ab 2026-07-03)

- **DailyPnL:** `reqAccountSummary` fragt jetzt `DailyPnL`-Tag ab. `onSummary`-Handler füllt `summary.dailyPnl`.
- **Tracker-Exits:** `todayExits` enthält jetzt Legacy + Tracker SELL-Fills. Win/Loss-Zählung sucht Entry in Legacy UND Tracker.
- **Wording:** „Beste Position" → „Beste offene Position" (unrealisiert kenntlich).

## Manual Close Tracking + Paper-Account dailyPnl (ab 2026-07-09)

- **position_closed Event:** Neuer Event-Typ im OrderStateTracker (`orders-v2.jsonl`).
  Source `"manual"` (API /close/:symbol) oder `"sentinel"` (pollIBKR Positionserkennung).
  Dedup: apiClosedSymbols Set (120s TTL) + `hasRecentClose()` + Bracket-Exit-Check.
- **Daily Report C2:** Win/Loss zählt position_closed Events mit. Ergebniszeile:
  `"Ergebnis: NW / NL (davon manuell: N)"`. 30-Tage-Statistik integriert Tracker-Exits.
- **Daily Report C1:** Bei Paper-Account (IBKR dailyPnl=0) eigene Berechnung:
  `~dailyPnl = realizedPnlToday + (currentUnrealized - yesterdayUnrealized)`.
  `"~"` Präfix kennzeichnet berechneten Wert. Live-Account-Pfad unverändert.
