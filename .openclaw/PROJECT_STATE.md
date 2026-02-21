Last updated: 2026-02-19 (Europe/Berlin)

============================================================
PURPOSE
============================================================
OpenClaw Executive System on Hetzner VPS:
- Unified Inbox (M365 + Yahoo)
- Draft lifecycle with approval gate
- Calendar read + free/busy + meeting creation with conflict handling
- Telegram interface as primary control surface

============================================================
INFRASTRUCTURE
============================================================

Server:
- Hetzner Cloud VPS (CCX33)
- Ubuntu 24.04 LTS
- Public IP: 46.62.153.181
- Tailscale IP: 100.121.45.4
- HTTPS via Tailscale Serve → 443 → 127.0.0.1:18789

Security:
- SSH key only
- Root disabled
- UFW + Fail2ban active
- Gateway auth mode = token
- Secrets single source of truth: ~/.config/openclaw/env
- No secrets in code, pluginConfig, workspace files, chat

OpenClaw:
- Version 2026.2.14
- systemd user service: openclaw-gateway.service
- Session store: ~/.openclaw/agents/main/sessions
- Log file: /tmp/openclaw/openclaw-YYYY-MM-DD.log

Workspace:
- ~/.openclaw/workspace

Extension:
- ~/.openclaw/workspace/.openclaw/extensions/executive-agent

============================================================
RUNTIME & BUILD
============================================================

Runtime:
- Node.js 22.x (ESM)
- No external DB (file-based drafts)

Build strategy (IMPORTANT):
- Treat TypeScript (index.ts) as source.
- Prefer compiled JS for runtime stability:
  - Build output: dist/index.js
  - Target: ES2022, Module: NodeNext
  - Node types: @types/node

Commands must be validated via:
- npm run build
- node --check dist/index.js
- systemctl restart
- Telegram smoke tests

============================================================
MODUS OPERANDI (NON-NEGOTIABLE)
============================================================

We do NOT do manual copy/paste edits inside nano for large blocks.

Default workflow:
1) Snapshot/branch in git
2) Apply deterministic changes via patches or scripted edits
3) Build gate:
   - npm run build
   - node --check dist/index.js
4) Restart gate:
   - systemctl --user restart openclaw-gateway.service
5) Smoke tests in Telegram
6) Commit

Rollback is always available:
- git reset --hard <commit>

Goal:
- Minimize iteration friction
- Avoid file corruption
- Keep changes small and reviewable

============================================================
MAIL
============================================================

Yahoo:
- IMAP unread fetch (ImapFlow)
- SMTP send (Nodemailer)
- SMTP verify implemented

M365:
- Graph token caching + retry layer in helper functions
- Unified inbox merges M365 + Yahoo unread
- Source tagging (m365/yahoo)
- Chronological descending

Unified Inbox:
- Unread only
- Combined + sorted desc
- Source tagging (m365/yahoo)

Draft Lifecycle:
- statuses: draft → approved → sent
- requireApproval default true
- Draft storage: workspace/artifacts/mail-drafts

Telegram Commands (Mail):
- /mailstatus
- /inbox
- /yinbox
- /yverify
- /ytest
- /draftshow
- /draftapprove
- /draftsend

============================================================
CALENDAR
============================================================

Implemented (M365 Calendar via Graph):
- /calendar
  - Shows next 7 days (read-only view)
- /free DD.MM HH:MM-HH:MM
  - Free/busy in window with grouped busy items
- /meet DD.MM HH:MM [durationMin] Title...
  - Creates meeting only if NO conflict (blocks on conflict)
- /meetf DD.MM HH:MM [durationMin] Title...
  - Force create meeting even if conflict exists

Conflict detection:
- Robust approach:
  - Query wider window around candidate slot (±12h)
  - Compute overlap locally: eventStart < end && eventEnd > start

Online meetings:
- Teams auto creation enabled in event payload:
  - isOnlineMeeting: true
  - onlineMeetingProvider: teamsForBusiness

============================================================
CODE STRUCTURE (CURRENT)
============================================================

Single plugin entry (source):
- index.ts (TypeScript ES Module)

Build output:
- dist/index.js

Key modules/areas:
- Graph helpers: token, get/post, retry/throttle handling
- Yahoo IMAP/SMTP
- Draft persistence helpers
- Telegram commands registered via api.registerCommand

============================================================
OPEN TECHNICAL ITEMS
============================================================

High Priority:
- Ensure runtime uses dist/index.js (avoid TS loader parse issues)
- Finish openclaw.plugin.json entry pointing to dist/index.js
- Add dev-check.sh:
  - npm run build
  - node --check dist/index.js
  - restart service
  - status check

Medium:
- HTML mail support
- Attachments support
- Structured logging + log rotation (avoid /tmp volatility)
- Healthcheck endpoint

Low:
- VIP whitelist
- Priority engine (P0/P1)
- Spam detection
- Audit log persistence
- Background scheduler (later; likely SQLite)

============================================================
CONFIG DECISION
============================================================

Single Source of Truth for Secrets:
- ~/.config/openclaw/env

No secrets in:
- pluginConfig
- workspace files
- index.ts
- chat

(END)
