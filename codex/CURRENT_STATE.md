# CURRENT STATE — bikosoc

**Purpose:** Live system state, populated by Codex's first read-only audit.
Derived ONLY from `git log`, live schema queries (if approved), and running
service checks — never from dated docs or CLAUDE.md status lines (which may
be stale).

**Rule:** This file is a template until populated. Do not fill in values
from CLAUDE.md. Every value must come from a verifiable live source.

---

## Git State

### openclaw-workspace
- **Last commit:** TODO(owner): run `git log --oneline -1` in workspace root
- **Branch:** TODO(owner): run `git branch --show-current`
- **Dirty:** TODO(owner): run `git status --short`

### executive-agent
- **Last commit:** TODO(owner): run `git log --oneline -1`
- **Branch:** TODO(owner): run `git branch --show-current`
- **Dirty:** TODO(owner): run `git status --short`
- **Last tag:** TODO(owner): run `git describe --tags --abbrev=0 2>/dev/null || echo "no tags"`

### executive-dashboard
- **Last commit:** TODO(owner): run `git log --oneline -1`
- **Branch:** TODO(owner): run `git branch --show-current`
- **Dirty:** TODO(owner): run `git status --short`

## Schema Version

- **Current version in DB:** TODO(owner): query `SELECT * FROM schema_version ORDER BY applied_at DESC LIMIT 5;` (requires DB access approval)
- **Highest V-prefix on disk:** TODO(owner): Codex will determine from migration file scan
- **Drift detector result:** TODO(owner): run `npm run verify-schema` in executive-agent (requires DB access approval)

## Running Services

| Service | Expected | Actual Status |
|---------|----------|---------------|
| openclaw-gateway (18789) | active | TODO(owner): `systemctl --user status openclaw-gateway` |
| openclaw-dashboard (18800) | active | TODO(owner): `systemctl --user status openclaw-dashboard` |
| openclaw-pdf-worker | active | TODO(owner): `systemctl --user status openclaw-pdf-worker` |
| openclaw-banking-fints (18794) | active | TODO(owner): `systemctl --user status openclaw-banking-fints` |
| openclaw-trading (18793) | active | TODO(owner): `systemctl --user status openclaw-trading` |
| nginx (443) | active | TODO(owner): `systemctl status nginx` |
| n8n Docker (5678) | active | TODO(owner): `docker ps --filter name=n8n` |

## Backup Timers

| Timer | Schedule | Last Triggered |
|-------|----------|----------------|
| openclaw-backup-daily | daily | TODO(owner): `systemctl --user list-timers openclaw-backup-daily` |
| openclaw-backup-weekly | weekly | TODO(owner): `systemctl --user list-timers openclaw-backup-weekly` |
| openclaw-backup-monthly | monthly | TODO(owner): `systemctl --user list-timers openclaw-backup-monthly` |

## Last Smoke Test

- **Result:** TODO(owner): run `bun run scripts/smoke-test.ts` and record pass/fail count
- **Date:** TODO(owner)

## Last Drift Check

- **Result:** TODO(owner): run `npm run verify-schema` and record exit code
- **Date:** TODO(owner)

## Open Tech Debt (from live inspection, not CLAUDE.md)

TODO(owner): Codex first audit will populate this from code scan.

---

*Last updated: TODO(owner) — to be filled by Codex's first audit session.*
