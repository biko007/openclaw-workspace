# CODEX WORKFLOW — Session Protocol

**Purpose:** How a Codex audit session operates. Modes, session lifecycle,
output conventions, escalation.

---

## Session Lifecycle

### 1. Session Start

1. `~/.codex/AGENTS.md` auto-loads (GLOBAL rules).
2. Codex reads `codex/CODEX_README.md` and follows the read order listed there.
3. Mode is `READ_ONLY_AUDIT` unless owner explicitly upgrades.
4. Area binding: this session is bound to **bikosoc**. Do not touch HDCC.

### 2. During Session

- Pick an audit template from `codex/CODEX_AUDIT_PROMPTS.md`, or follow
  owner's ad-hoc instructions.
- Write findings to `~/codex-audit/bikosoc/<date>-<type>.md`.
- Use `TODO(owner): ...` for anything requiring live inspection or decision.
- If mode upgrade is needed, request it explicitly and wait for owner approval.

### 3. Session End

- Update `codex/HANDOFF.md` with: session summary, open findings, blocked
  items, recommended next audit.
- Confirm all findings are written to `~/codex-audit/bikosoc/`.
- Do NOT commit or push. Owner reviews diff and commits.

## Modes

### READ_ONLY_AUDIT (default)

- Read any source file, config, migration SQL, test file, git history.
- Write findings to `~/codex-audit/bikosoc/`.
- Update `codex/CURRENT_STATE.md`, `codex/ARCHITECTURE_GUARDRAILS.md`,
  `codex/HANDOFF.md` (governance files only — not application code).
- **Cannot** modify application code, configs, tests, or migrations.

### PLAN_ONLY (requires owner approval)

- Everything in READ_ONLY_AUDIT, plus:
- Draft implementation plans, specs, or migration proposals.
- Write plans to `~/codex-audit/bikosoc/<date>-plan-<topic>.md`.
- **Cannot** modify application code.

### IMPLEMENT_WITH_APPROVAL (requires owner approval)

- Everything in PLAN_ONLY, plus:
- Write or modify application code, tests, configs.
- Every change must be reviewed by owner before commit.
- Owner commits; Codex never commits or pushes.

### SMALL_SAFE_FIX (requires owner approval)

- Fix lint errors, typos, dead imports, formatting — cosmetic only.
- No logic changes, no new functionality, no behavior changes.
- Owner reviews and commits.

## Output Conventions

### Findings File Naming

```
~/codex-audit/bikosoc/<YYYY-MM-DD>-<type>.md
```

Types: `schema-audit`, `test-coverage`, `security-surface`, `dead-code`,
`module-boundaries`, `dependency-audit`, `deployment-config`,
`governance-drift`, `self-report-verification`, `ad-hoc`.

### Findings Structure

```markdown
# <Audit Type> — bikosoc — <YYYY-MM-DD>

**Mode:** READ_ONLY_AUDIT
**Scope:** <what was audited>
**Codex session:** <session identifier if available>

## Summary

<1-3 sentence overview>

## Findings

### [CRITICAL] <title>
- **File:** `<path>:<line>`
- **Description:** ...
- **Evidence:** ...
- **Recommendation:** ...

### [HIGH] <title>
...

### [MEDIUM] <title>
...

### [LOW] <title>
...

## TODO(owner)

- [ ] <item requiring owner action>

## Recommended Next Audit

<what to audit next based on findings>
```

## Escalation

- **CRITICAL finding:** Flag immediately in the findings file. If the owner
  is present in the session, call it out directly.
- **Blocked by missing access:** Write `TODO(owner): need access to <X> to
  verify <Y>` and continue with what is available.
- **Ambiguous requirement:** Do not guess. Write `TODO(owner): clarify <X>`.
- **Cross-area concern:** If a bikosoc audit reveals an issue that likely
  affects HDCC, note it as `TODO(owner): verify in HDCC session — <description>`.
  Do not inspect HDCC artifacts from this session.

## Git Rules (for non-READ_ONLY modes)

- Codex never commits, never pushes.
- Codex writes files; owner reviews diff and commits.
- Owner uses `git add -A` (never `-u`, never selective).
- For bikosoc: if files span repos, owner uses the three-repo commit pattern.
- Commit locally only. Owner pushes after review.
