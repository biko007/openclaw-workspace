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
