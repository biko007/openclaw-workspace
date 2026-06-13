# Runbook: Order Reconciliation

Operator-Handbuch fuer das Trading-Agent Order-Reconciliation-System.

## Watchdog-Warnungen und Reaktion

| Alert | Severity | Aktion |
|-------|----------|--------|
| `exits_incomplete` | WARN → CRITICAL (15min) | Log pruefen, `diag-open-orders.ts` laufen lassen, Guardian-Log auf Fehler pruefen |
| `qty_undercoverage` | WARN | Position-Qty vs Exit-Qty vergleichen, ggf. manuell nachruesten |
| `unreconstructable` | CRITICAL | Keine Exit-Orders, kein Intent, kein Legacy → manuell nachruesten oder Position in TWS schliessen |
| `foreign_involved` | WARN | Fremd-Order in TWS identifizieren, ggf. canceln |
| `guardian_retry_limit` | CRITICAL | 2 fehlgeschlagene Nachruestungen/Stunde → IBKR-Fehler pruefen, manuell eingreifen |

## Diagnose: diag-open-orders.ts

```bash
npx tsx scripts/diag-open-orders.ts > /tmp/diag.json 2>/tmp/diag.log
cat /tmp/diag.json | jq '.orders[] | {symbol, orderType, totalQty, status, orderRef, ocaGroup}'
```

- Verwendet clientId 99 (stoert laufenden Agent nicht)
- Output: orders, positions, executions als JSON
- Pruefpunkte:
  - `orderRef` mit `OCAGENT`-Prefix vorhanden
  - `ocaGroup` konsistent (gleiche `OCA|tradeIntentId|gen` auf Stop + TP)
  - `tif` = GTC auf allen Exit-Orders

## Position manuell nachruesten (I4-Muster)

1. Diagnose laufen lassen → fehlende Legs identifizieren
2. **Option A — TWS:** Bracket-Order fuer das Symbol platzieren (STP + LMT, gleiche Qty wie Position)
3. **Option B — Agent-Restart:** `systemctl --user restart openclaw-trading` → Guardian erkennt `missing_*` im naechsten Cycle und ruestet automatisch nach (gen+1)
4. Watchdog-OK-Zeile beobachten: `exits=N/N`

## fallbackMode umschalten

In `universe.json` unter `strategies`:

```json
"fallbackMode": "market_close"
```

- `market_close` — MKT SELL wenn Preis <= Stop und keine aktive STP-Order
- `alert_only` — nur CRITICAL-Alert, kein automatischer Close

Neustart des Agents noetig (`universe.json` wird bei Programmstart geladen):

```bash
systemctl --user restart openclaw-trading
```

## Gateway-Restart (automatisch)

- Watchdog loest nach 3+ aufeinanderfolgenden Connection-Failures automatisch aus
- Cooldown: 60 Minuten zwischen Restarts
- Befehl: `systemctl --user restart openclaw-ibkr-gateway`
- Manuell: gleicher Befehl, Gateway-Log pruefen mit `journalctl --user -u openclaw-ibkr-gateway -f`
