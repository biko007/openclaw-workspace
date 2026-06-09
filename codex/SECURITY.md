# SECURITY — Codex Auditor Boundaries (bikosoc)

**Purpose:** Define what Codex must never read, modify, or trigger when
auditing the bikosoc area. References the authoritative Data Hygiene and
Postgres User Model sections in `executive-agent/CLAUDE.md`.

---

## Secrets — Never Touch

| Asset | Location | Rule |
|-------|----------|------|
| Environment secrets | `~/.config/openclaw/env` | Never read, print, or reference values |
| `.env` / `.env.*` files | Any repo | Never read contents |
| `.env.save` | executive-agent root | Saved env snapshot — never read |
| 1Password items | Referenced in CLAUDE.md | Never attempt access |
| `CORE_SERVICE_TOKEN` | Runtime only | Never log or extract |
| `BANKING_ENCRYPTION_KEY` | Runtime only | Never log or extract |
| `DASHBOARD_TOKEN` | URL parameter | Never log or extract |
| OAuth tokens (Meta, M365, Withings) | Postgres tables / runtime | Never query or display |

## Production Data — Never Access

- **Database `openclaw_core`**: Never connect. Audit schema via migration SQL
  files and CLAUDE.md documentation only.
- **Database `n8n`**: Never connect.
- **`artifacts/personal/`**: Contains personal data (health, fleet, assets,
  travel, mail, Instagram). Gitignored. Never read contents.
- **`~/codex-audit/`**: Codex writes findings here. Never include secrets
  or personal data in findings.

## Real Actions — Never Trigger

These systems have real-world consequences. Codex must never invoke them
even in READ_ONLY_AUDIT mode:

| System | Why |
|--------|-----|
| FinTS / banking sidecar (port 18794) | Real bank connections |
| SMTP / IMAP (mail module) | Sends/reads real email |
| Meta Graph API (Instagram module) | Posts to real Instagram |
| M365 Graph API (calendar, SharePoint, mail) | Mutates real Microsoft data |
| Withings API (health module) | Accesses real health data |
| Telegram Bot API | Sends messages to real users |
| n8n workflows (port 5678) | Triggers real automations |
| Playwright PDF worker | Resource-intensive; may affect production |

## Audit-Safe Operations

Codex MAY do the following in any mode:

- Read source code (`.ts`, `.mjs`, `.js`, `.sql`, `.json`, `.md`)
- Read `package.json`, `tsconfig.json`, `eslint.config.js`
- Read `.gitignore` files
- Read systemd unit files (read-only, no restart/enable)
- Read nginx config files (read-only)
- Run `git log`, `git diff`, `git status` (read-only git operations)
- Run `npm run verify-schema` (drift detector — read-only DB check)
  **Only if owner confirms the DB connection is safe for this session.**

## Credential Hygiene in Findings

When writing audit findings to `~/codex-audit/bikosoc/`:
- Never include actual secret values, tokens, or passwords
- Refer to secrets by name only (e.g., "CORE_SERVICE_TOKEN is used in...")
- Redact any accidentally captured values with `[REDACTED]`
- Never include personal data from `artifacts/personal/`
