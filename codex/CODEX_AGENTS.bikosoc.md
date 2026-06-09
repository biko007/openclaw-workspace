# CODEX AREA-SPECIFIC RULES — bikosoc

**Area:** bikosoc (private executive system)
**Loaded:** Explicitly by audit prompts — not auto-discovered by Codex.
**Prerequisite:** `~/.codex/AGENTS.md` (GLOBAL rules) must be active.

---

## Repos in Scope

| Repo | Path | Remote |
|------|------|--------|
| openclaw-workspace | `/home/biko/.openclaw/workspace` | `git@github.com:biko007/openclaw-workspace.git` |
| executive-agent | `.../.openclaw/extensions/executive-agent` | `git@github.com:biko007/executive-agent-private.git` |
| executive-dashboard | `.../.openclaw/extensions/executive-dashboard` | `git@github.com:biko007/executive-dashboard-private.git` |

**Related but out-of-scope for governance files** (referenced in audits):
- Banking FinTS sidecar: `~/openclaw-banking-fints` (Python, no GitHub remote — TD-3)

## Database

- **DB name:** `openclaw_core`
- **App role:** `openclaw`
- **Instance:** `n8n-docker-postgres-1` (shared with n8n DB)
- **Cross-DB rule:** `n8n_app` must NEVER have GRANT on `openclaw_core`
  (enforced by smoke-test checks 14+15; see `executive-agent/CLAUDE.md`)

## Stack

| Component | Technology | Port |
|-----------|-----------|------|
| openclaw-gateway | Node.js / TypeScript / Bun | 18789 |
| openclaw-dashboard | Node.js / Express | 18800 |
| openclaw-pdf-worker | Playwright Chromium | — |
| openclaw-banking-fints | Python FastAPI | 18794 |
| openclaw-trading | Node.js | 18793 |
| ibgateway | IB Gateway (Java) | 7497 |
| nginx | Reverse proxy | 443 |
| n8n | Docker | 5678 |

All services bind `127.0.0.1` only; nginx proxies externally via
`app.bikobickel.de`.

## Services (systemd user-level)

```
~/.config/systemd/user/openclaw-gateway.service
~/.config/systemd/user/openclaw-dashboard.service
~/.config/systemd/user/openclaw-pdf-worker.service
~/.config/systemd/user/openclaw-banking-fints.service
~/.config/systemd/user/openclaw-trading.service
~/.config/systemd/user/openclaw-backup-daily.service  (+timer)
~/.config/systemd/user/openclaw-backup-weekly.service  (+timer)
~/.config/systemd/user/openclaw-backup-monthly.service (+timer)
```

## Source of Truth

- **executive-agent/CLAUDE.md** — architecture manifest, module map, migration
  convention, sprint status, test matrix, deployment protocol, naming conventions.
- **executive-dashboard/CLAUDE.md** — dashboard API structure, proxy pattern,
  Alpine CSP rules, tab inventory.
- These files are authoritative. Codex governance files reference them.

## Modules (12, in executive-agent)

executive, instagram, assets, nk, health, fleet, travel, pe, mail, calendar,
sharepoint, banking.

Each lives in `src/modules/<name>/`. Module boundaries enforced by ESLint
(`eslint.config.js` — `no-deep-module-import` rule).

## No-Go Zones (Codex must never modify)

1. `~/.config/openclaw/env` — secrets store
2. `artifacts/personal/` — personal data (gitignored)
3. `.env` / `.env.*` files anywhere
4. `node_modules/`, `dist/` — build artifacts
5. n8n workflows (in Docker, out of Codex scope)
6. nginx config (`/etc/nginx/`) — requires sudo, out of scope
7. systemd unit files — require owner action
8. The existing `workspace/AGENTS.md` — Hans_Dampf persona, application data

## Existing Enforcement Mechanisms

Codex audits should verify these are intact, not replace them:

| Mechanism | Location | What it enforces |
|-----------|----------|-----------------|
| ESLint `no-deep-module-import` | `executive-agent/eslint.config.js` | Module boundary isolation |
| Smoke test (28/28) | `executive-agent/scripts/smoke-test.ts` | Post-deploy health |
| Schema drift detector | `executive-agent/scripts/verify-schema-versions.ts` | Migration consistency |
| Approval hard-rule test | `src/modules/instagram/__tests__/approval-hard-rule.test.ts` | Publish requires approval |
| CI test suite (89+ tests) | `npm test` / `bun test` | Regression prevention |
| `.gitignore` | All repos | Secrets/artifact exclusion |
| Borg backup (daily/weekly/monthly) | `scripts/openclaw-backup` + systemd timers | Disaster recovery |
