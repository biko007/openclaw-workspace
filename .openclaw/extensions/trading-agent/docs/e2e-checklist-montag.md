# E2E-Verifikation — Paper Account (Montag)

## Vorbereitung
- [ ] Agent laeuft: `systemctl --user status openclaw-trading`
- [ ] Mode = 3 (Full-Auto)
- [ ] Paper Account DUP514636 verbunden
- [ ] TWS/Gateway laeuft auf Port 7497

## 1. Entry beobachten
- [ ] Scan-Ergebnis abwarten (Markt-Oeffnung + 15min)
- [ ] AI-Decision im Log: `[ai-decision] SYMBOL: BUY (confidence: X.XX)`
- [ ] Entry-Fill im Log: `[executor] SYMBOL: FILLED N/N @ $X.XX`
- [ ] orderRef-Format pruefen: `OCAGENT|DUP514636|SYMBOL-YYMMDD-NN|conId|entry|0`

## 2. GTC-Brackets verifizieren
- [ ] `diag-open-orders.ts` laufen lassen
- [ ] STP-Order vorhanden: orderType=STP, tif=GTC, orderRef mit |stop|0
- [ ] TP-Order vorhanden: orderType=LMT, tif=GTC, orderRef mit |tp|0
- [ ] OCA-Group identisch auf beiden: OCA|SYMBOL-YYMMDD-NN|0
- [ ] Qty auf beiden = Entry-Fill-Qty
- [ ] Watchdog OK-Zeile: `exits=N/N` (N = Gesamtpositionen)

## 3. Exit manuell canceln → Re-Placement
- [ ] In TWS: STP-Order der Test-Position canceln
- [ ] Warten auf naechsten Guardian-Cycle (5min)
- [ ] Log pruefen: `[reconcile] ... states={"protected":N-1,"missing_stop":1}`
- [ ] Guardian-Aktion: `[guardian] SYMBOL: missing_stop → replacement gen=1`
- [ ] Neue Orders in diag: orderRef mit |stop|1 und |tp|1
- [ ] OCA-Group: OCA|SYMBOL-YYMMDD-NN|1

## 4. Watchdog-Zustandswechsel
- [ ] Waehrend STP fehlt: Watchdog `exits=N-1/N`
- [ ] Falls >15min: CRITICAL-Eskalation im Telegram
- [ ] Nach Re-Placement: `exits=N/N` wieder hergestellt
- [ ] Telegram: RESOLVED-Nachricht

## 5. Aufraeumen
- [ ] Test-Position in TWS schliessen (oder Agent schliessen lassen)
- [ ] Log-Auszuege sichern fuer E8-Report
