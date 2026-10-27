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
| 1 — IBKR-Verbindung | 3 aufeinanderfolgende Failures → automatischer Gateway-Restart (`systemctl --user restart ibgateway.service`) |
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
- **Ungegated:** Daily Report, Daily Health Check, CRITICAL-Alerts, Guardian-Alerts (eigenes `TRADING_ALERTS_TELEGRAM` in `index.ts`, wirkt auf den Sender des AlertManagers)
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

## IBKR-Feiertagskalender (ab 2026-07-13)

- **Quelle:** `ContractDetails.liquidHours` aus `reqContractDetails` (Regular Session)
- **Referenz-Symbole:** SPY (NYSE/NASDAQ, SMART, USD), SAP (XETRA, SMART, EUR)
- **Parsing:** IBKR-Format `YYYYMMDD:HHMM-YYYYMMDD:HHMM;YYYYMMDD:CLOSED` → `Map<dateStr, DaySchedule>`
- **Cache:** `globalThis.__tradingCalendar` (TradingCalendar Singleton), TTL 25h
- **Refresh:** bei IBKR-Connect + Reconnect + taeglich 06:00 UTC
- **Fail-safe:** kein Kalender-Eintrag → Fallback auf Wochentag-Check (identisch mit bisherigem Verhalten)
- **Logik:** `isTradingDay()` gibt `false` nur wenn BEIDE Exchanges (NYSE + XETRA) CLOSED. Bei fehlenden Daten konservativ `true`.
- **Dateien:** `trading-calendar.ts` (Parsing + Cache), `market-hours.ts` (isTradingDay), `ibkr.ts` (fetchLiquidHours), `index.ts` (Refresh-Orchestrierung)
- **Tests:** `tests/trading-calendar.test.ts` (22 Tests: Parsing, Holiday, Half-Day, Fallback, Timezone)

## Meldungsdisziplin (ab 2026-09-18)

- **ENV-Flags:** `HEALTH_REPORT_MODE`, `TRADING_REPORT_MODE` (Default beide `exception`)
  - `exception` — Telegram nur bei Abweichung, Alles-OK-Tage bleiben still
  - `always` — altes Verhalten (tägliche Nachricht auch ohne Befund)
- **Prüfungen laufen unverändert täglich:** Health-Check 08:00 UTC, Report 18:00 UTC.
  Gedrosselt ist nur der Versand — jedes Ergebnis landet im Ledger.
- **Health-Abweichungen** (`healthDeviations()`): IBKR disconnected, `reconnectAttempts > 0`,
  Universe-Scheduler gestoppt, `consecutiveWatchdogFailures > 0`
- **Report-Abweichungen** (`reportDeviations()`): `tradingLocked`, `guardianLocked`,
  IBKR disconnected, `reconnectAttempts > 0`, offene Alerts (`AlertManager.activeKeys()`),
  offene Position ohne Exit-Coverage (`positions - stateCount.protected`),
  Anomalie `buyDecisions > 0 && openedToday === 0` (bekannter 3-BUY/0-Eröffnungen-Fall)
- **Bei Abweichung:** Kopfzeile „⚠️ … — Abweichung" + Bullet-Liste, darunter der
  vollständige Report wie bisher.
- **Ledger:** `artifacts/personal/trading/report-ledger.json` (60 Tage, ein Eintrag/Tag)
- **`GET /weekly-stats`:** 7-Tage-Aggregat (Health grün/gesamt, Trades, Exits, P&L, NLV,
  Abweichungsliste). Der executive-agent baut daraus die Montags-Nachricht — der
  trading-agent sendet selbst KEINE Wochen-Zusammenfassung, damit genau eine rausgeht.
- **Dateien:** `report-ledger.ts` (Ledger + reine Abweichungs-Funktionen),
  `index.ts` (`sendHealthCheck`, `sendDailyReport`, `/weekly-stats`),
  `alert-manager.ts` (`activeKeys()`)

## Börsenzeiten und Option A (ab 2026-10-24)

- **`market-hours.ts`** ist die einzige Quelle für Handelszeiten: XETRA 09:00–17:30
  Europe/Berlin, NYSE 09:30–16:00 America/New_York, je Börse in ihrer Zeitzone
  (Sommer-/Winterzeit automatisch), Wochenende geschlossen, IBKR-Kalender
  (CLOSED, verkürzter Tag) darf das Fenster nur verkürzen, nie verlängern.
- **Executor:** KI-Aufruf und Order nur, wenn die Börse des Symbols offen ist
  (`isExchangeOpen`). **Scheduler:** Scans nur, wenn XETRA oder NYSE offen ist;
  Universe-Build 07:00 UTC nur an Handelstagen. **`isMarketSafe`:** erste 15 /
  letzte 30 Minuten relativ zur jeweiligen Börsenzeit.
- **Nachweis:** Log `[market-hours] YYYY-MM-DD: XETRA hh:mm–hh:mm UTC, NYSE …`
  bei jedem Kalender-Refresh; `GET /market-hours?date=YYYY-MM-DD`.
- **Anomalie im Daily Report** zählt nur freigegebene BUYs (Konfidenz ≥
  `CONFIDENCE_THRESHOLD`).
- **Status:** `unrealizedPnl` = 0 ohne Position.
- **Glattstellungs-Meldung (sentinel):** Position muss in zwei Abfragen
  hintereinander fehlen; je Position (Symbol, Menge, Einstand) nur eine Meldung;
  Kurs aus IBKR-Executions (`ibkr.recentSellPrice`), sonst „(geschätzt)“ und
  `estimated: true` im `position_closed`-Event.
- **`GET /orders`:** Alt-Orders aus `orders.jsonl` mit offenem Status, die bei
  IBKR nicht offen sind, erscheinen als `NotAtIBKR` (`logStatus` = Original).
  Das Log bleibt unverändert.

## Option B: Tageslimit, Levelregeln, Auswertung (ab 2026-10-27)

Owner-Entscheidung 27.10.2026 (Werte aus der Auswertung von 115 Kaufsignalen ≥ 0,75).

- **Tageslimit** (`risk-rules.ts` `checkDailyLoss`, Executor vor jedem Kauf):
  NLV ≥ 2 % unter dem Vortagsschluss (`performance/*.json`) → keine neuen Käufe,
  WARN-Alert `daily_loss_limit`; Stops, Ziele und Guardian laufen weiter.
  Gemessen an der NLV, weil das Paper-Konto als DailyPnL immer 0 meldet.
  Ohne Vortags-NLV kein Block, nur Log-Zeile.
- **Levelregeln** (`chooseLevels`): KI-Levels nur bei Stop ≥ 1,0 % unter Einstieg
  und CRV ≥ 1,5; sonst Standardlevels Stop −`stopLossPercent` %, Ziel +2 × (CRV 2).
  Die Quelle steht in der Trade-Meldung und in `trade-intents.jsonl`.
- **Konfiguration:** `strategies.json` (fehlt = Vorgaben in `store.ts`);
  `dailyLossLimit` und `levelRules` werden mit den Vorgaben zusammengeführt, eine
  ältere Datei schaltet die Regeln also nicht still ab.
- **`GET /auswertung`** (`auswertung.ts`, nur lesend): Abschlüsse aus den
  IBKR-Ausführungen in `orders-v2.jsonl` (Korrekturen über execIdBase; Ausstiege
  unter der Kennung einer älteren Position desselben Symbols werden zugeordnet;
  TWS-Glattstellung aus `position_closed` als „geschätzt“), Monatswerte
  (Trefferquote, Ø Gewinn/Verlust je Währung, größter Gewinn/Verlust, je
  Levelquelle und Ausstiegsgrund), NLV-Änderung und davon an Tagen ohne Position
  (Zins u. a.). Altpositionen vor 12.06.2026 ohne Einstieg im Log werden genannt,
  nicht gewertet.
- **Rückweg der Regeln ohne Code:** `strategies.json` mit
  `"dailyLossLimit": {"enabled": false}` bzw. `"levelRules": {"minRewardRisk": 0, "minStopPercent": 0}`;
  wirkt beim nächsten Scan.
