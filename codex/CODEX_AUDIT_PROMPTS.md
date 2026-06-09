# CODEX AUDIT PROMPTS — bikosoc

**Purpose:** Ready-to-use audit templates. Each states whether edits are
allowed, expected output format, and severity scale. Findings always use
`CRITICAL` / `HIGH` / `MEDIUM` / `LOW` with concrete `file:line` references.

**Required preamble for every audit:** Before executing any template below,
read `workspace/codex/CODEX_README.md` and the files it lists before doing
anything.

---

## Template 1: Schema Drift Audit

**Mode:** READ_ONLY_AUDIT
**Edits allowed:** No
**Expected output:** `~/codex-audit/bikosoc/<date>-schema-audit.md`

### Prompt

> Read `workspace/codex/CODEX_README.md` and the files it lists before doing
> anything.
>
> Audit the database schema for drift between migration files and CLAUDE.md
> documentation.
>
> 1. List all migration SQL files across `src/modules/*/migrations/` and
>    `src/shared/migrations/`.
> 2. Compare the V-prefix version numbers against the migration convention
>    documented in `executive-agent/CLAUDE.md` (Sprint 11.5 section).
> 3. Check for gaps in version numbering.
> 4. Verify each migration file referenced in the CLAUDE.md migrate-script
>    table actually exists on disk.
> 5. Check that boot-time migrations (0xx prefix) are idempotent (`IF NOT
>    EXISTS` pattern).
> 6. Flag any migration that modifies tables owned by another module.
>
> Severity guide:
> - CRITICAL: Missing migration file referenced in CLAUDE.md, or version
>   collision.
> - HIGH: Gap in version sequence, or non-idempotent boot-time migration.
> - MEDIUM: Documentation mismatch (CLAUDE.md lists wrong version).
> - LOW: Naming convention deviation.

---

## Template 2: Test Coverage Audit

**Mode:** READ_ONLY_AUDIT
**Edits allowed:** No
**Expected output:** `~/codex-audit/bikosoc/<date>-test-coverage.md`

### Prompt

> Read `workspace/codex/CODEX_README.md` and the files it lists before doing
> anything.
>
> Audit test coverage against the mandatory test matrix in
> `executive-agent/CLAUDE.md` (CI-Tests section).
>
> 1. List every test file in `src/**/__tests__/` and `scripts/smoke-test.ts`.
> 2. For each mandatory test listed in CLAUDE.md, verify the file exists and
>    contains the described assertions.
> 3. Check that no mandatory test is skipped (`.skip`, `xit`, `xdescribe`).
> 4. Identify modules with zero test files.
> 5. Check the known `bun test` parallelism issue — are `POSTGRES_URL`
>    overrides isolated per test file?
>
> Severity guide:
> - CRITICAL: Mandatory test file missing or all assertions removed.
> - HIGH: Mandatory test contains `.skip` or assertions that don't match
>   CLAUDE.md description.
> - MEDIUM: Module with no test coverage.
> - LOW: Test file exists but has fewer assertions than documented.

---

## Template 3: Security Surface Audit

**Mode:** READ_ONLY_AUDIT
**Edits allowed:** No
**Expected output:** `~/codex-audit/bikosoc/<date>-security-surface.md`

### Prompt

> Read `workspace/codex/CODEX_README.md` and the files it lists before doing
> anything.
>
> Audit the security surface of the bikosoc area. Do NOT read actual secret
> values.
>
> 1. Scan all `.ts`, `.mjs`, `.js` files for hardcoded secrets (tokens, API
>    keys, passwords, connection strings with credentials).
> 2. Verify `.gitignore` excludes `.env`, `artifacts/personal/`, and
>    `node_modules/`.
> 3. Check that Bearer token validation exists on all `/api/` routes.
> 4. Verify services bind `127.0.0.1` only (not `0.0.0.0`) in systemd units
>    and source code.
> 5. Check nginx config for proper internal-only restrictions on
>    `/api/internal/` routes.
> 6. Verify `redactClientData()` is applied to banking log output.
> 7. Check that `pg_advisory_lock` is used for concurrent-sensitive operations.
>
> Severity guide:
> - CRITICAL: Hardcoded secret in source, or service binding 0.0.0.0.
> - HIGH: Missing Bearer auth on public route, or secrets in git history.
> - MEDIUM: Missing advisory lock on concurrent operation.
> - LOW: Redaction pattern inconsistency.

---

## Template 4: Dead Code & Legacy Cleanup

**Mode:** READ_ONLY_AUDIT
**Edits allowed:** No
**Expected output:** `~/codex-audit/bikosoc/<date>-dead-code.md`

### Prompt

> Read `workspace/codex/CODEX_README.md` and the files it lists before doing
> anything.
>
> Identify dead code, unused files, and legacy artifacts in both repos.
>
> 1. Find `.bak`, `.bak.*`, `*.old` files in repo roots.
> 2. Identify exported functions/classes in `src/` that are never imported
>    elsewhere.
> 3. Check for `TODO`, `FIXME`, `HACK` comments and cross-reference with
>    CLAUDE.md open TODOs.
> 4. Identify `PROJECT_STATUS_*.md` files — are they superseded by CLAUDE.md?
> 5. Check `archive/` directories for files that should have been removed
>    from the repo entirely.
> 6. Identify npm dependencies in `package.json` not imported anywhere in
>    source.
>
> Severity guide:
> - CRITICAL: None expected.
> - HIGH: Dead code that could mask bugs (e.g., unused error handler).
> - MEDIUM: Unused dependency, stale backup file in repo.
> - LOW: Cosmetic (TODO comment for completed work).

---

## Template 5: Module Boundary Audit

**Mode:** READ_ONLY_AUDIT
**Edits allowed:** No
**Expected output:** `~/codex-audit/bikosoc/<date>-module-boundaries.md`

### Prompt

> Read `workspace/codex/CODEX_README.md` and the files it lists before doing
> anything.
>
> Verify module isolation as enforced by ESLint and documented in CLAUDE.md.
>
> 1. Read `eslint.config.js` and understand the `no-deep-module-import` rule.
> 2. For each module in `src/modules/`, check whether it imports from another
>    module's internals (bypassing `<module>/index.ts`).
> 3. Check whether any module directly accesses another module's DB tables
>    (e.g., Instagram module querying `health_logs`).
> 4. Verify that `n8n` integration is limited to `/api/n8n/trigger/*` routes
>    (CLAUDE.md manifest rule 2).
> 5. Check the dashboard proxy pattern — does `server.mjs` bypass Core API
>    to access Postgres directly for any module?
>
> Severity guide:
> - CRITICAL: Module directly mutates another module's DB tables.
> - HIGH: Deep import bypassing module index.
> - MEDIUM: n8n calling a non-trigger endpoint.
> - LOW: Inconsistent module index exports.

---

## Template 6: Deployment & Config Audit

**Mode:** READ_ONLY_AUDIT
**Edits allowed:** No
**Expected output:** `~/codex-audit/bikosoc/<date>-deployment-config.md`

### Prompt

> Read `workspace/codex/CODEX_README.md` and the files it lists before doing
> anything.
>
> Audit deployment configuration for correctness and safety.
>
> 1. Read all systemd unit files in `~/.config/systemd/user/openclaw-*.service`.
> 2. Verify each service's `ExecStart` matches the documented startup in
>    CLAUDE.md.
> 3. Check that backup timers (daily/weekly/monthly) are enabled and their
>    schedules match CLAUDE.md.
> 4. Read nginx config and verify route mappings match CLAUDE.md documentation.
> 5. Check that the smoke test is documented as post-deploy gate
>    (CLAUDE.md deployment section).
> 6. Verify the drift detector is documented as sprint-cut gate.
>
> Severity guide:
> - CRITICAL: Service config diverges from documented architecture.
> - HIGH: Backup timer disabled or missing.
> - MEDIUM: nginx route undocumented in CLAUDE.md.
> - LOW: Documentation lists outdated port or path.

---

## Template 7: Dependency Audit

**Mode:** READ_ONLY_AUDIT
**Edits allowed:** No
**Expected output:** `~/codex-audit/bikosoc/<date>-dependency-audit.md`

### Prompt

> Read `workspace/codex/CODEX_README.md` and the files it lists before doing
> anything.
>
> Audit npm dependencies for security and hygiene.
>
> 1. Read `package.json` and `package-lock.json` in both repos.
> 2. Check for known deprecated packages.
> 3. Identify dependencies with no lockfile entry (phantom deps).
> 4. Check for duplicate dependencies across agent and dashboard repos.
> 5. Verify `devDependencies` are not imported in production source files.
> 6. List any dependency that hasn't been updated in >12 months (check
>    lockfile metadata if available).
>
> Severity guide:
> - CRITICAL: Dependency with known critical CVE.
> - HIGH: Deprecated package still in use.
> - MEDIUM: Phantom dependency or dev-dep in production import.
> - LOW: Outdated but functional dependency.

---

## Template 8: Cross-Area Governance Drift Check

**Mode:** READ_ONLY_AUDIT
**Edits allowed:** No
**Expected output:** `~/codex-audit/bikosoc/<date>-governance-drift.md`

### Prompt

> Read `workspace/codex/CODEX_README.md` and the files it lists before doing
> anything.
>
> Check for drift between the GLOBAL block of Codex governance and its
> deployed copy.
>
> 1. Compare `workspace/codex/AGENTS.global.md` (canonical) with
>    `~/.codex/AGENTS.md` (deployed). They must be **byte-identical**.
>    Any divergence is a **CRITICAL** finding.
> 2. If the HDCC area has its own `AGENTS.global.md`, compare it with
>    the bikosoc canonical. The GLOBAL block must be byte-identical
>    across areas. Any divergence is **CRITICAL**.
> 3. Check that `codex/CODEX_WORKFLOW.md` mode definitions are consistent
>    with the mode table in `AGENTS.global.md`.
> 4. Verify `codex/SECURITY.md` no-go zones are consistent with the hard
>    rules in `AGENTS.global.md`.
>
> Severity guide:
> - CRITICAL: GLOBAL block divergence between canonical and deployed, or
>   between areas.
> - HIGH: Mode definitions inconsistent across files.
> - MEDIUM: Security boundary listed in one file but missing in another.
> - LOW: Formatting-only divergence (whitespace, line endings).

---

## Template 9: Claude Code Self-Report Verification

**Mode:** READ_ONLY_AUDIT
**Edits allowed:** No
**Expected output:** `~/codex-audit/bikosoc/<date>-self-report-verification.md`

### Prompt

> Read `workspace/codex/CODEX_README.md` and the files it lists before doing
> anything.
>
> Independently verify Claude Code's claimed equivalence, test coverage, and
> closure against live code and committed tests. Any claim that does not hold
> is a **CRITICAL** finding.
>
> 1. Read `executive-agent/CLAUDE.md` — extract every factual claim:
>    - Sprint completion status ("abgeschlossen" / "erledigt")
>    - Test counts (e.g., "28/28 Smoke", "89+ Tests", "71 Tests")
>    - Module counts and names
>    - Migration version numbers and which modules they belong to
>    - Specific files claimed to exist (stores, routes, tests)
>    - Specific behaviors claimed (advisory locks, idempotency, audit logging)
>
> 2. For each sprint marked "abgeschlossen":
>    - Verify the claimed migration files exist on disk.
>    - Verify the claimed test files exist and are not empty/skipped.
>    - Verify the claimed endpoints exist in source code.
>    - Verify claimed module files (store.ts, routes.ts, etc.) exist.
>
> 3. For test count claims:
>    - Count actual `describe`/`it`/`test` blocks in each test file.
>    - Compare with the counts stated in CLAUDE.md.
>    - Check for `.skip`, `.only`, or commented-out tests.
>
> 4. For the smoke test:
>    - Read `scripts/smoke-test.ts` and count the actual checks.
>    - Compare with the claimed count (28/28).
>
> 5. For architecture claims:
>    - "Module boundaries enforced by ESLint" — verify the rule exists and
>      covers all modules.
>    - "Advisory lock(N)" claims — verify the lock IDs appear in source.
>    - "Idempotency key" claims — verify idempotency logic exists in the
>      claimed locations.
>    - "Audit log" claims — verify `audit.log()` or equivalent calls exist.
>
> 6. For the dashboard (`executive-dashboard/CLAUDE.md`):
>    - Verify claimed proxy routes exist in `server.mjs`.
>    - Verify claimed ENDPOINT_MAP entries exist in dashboard JS.
>    - Verify tab inventory matches `public/index.html`.
>
> Severity guide:
> - CRITICAL: Claimed test file missing, sprint marked complete but migration
>   absent, test count inflated, endpoint claimed but not in source.
> - HIGH: Test exists but assertions don't match description, advisory lock
>   ID mismatch, module listed but directory empty.
> - MEDIUM: Minor count discrepancy (off by 1-2), documentation uses
>   different terminology than code.
> - LOW: Formatting or phrasing inconsistency in documentation.

---

## Template 10: Ad-Hoc Audit

**Mode:** As specified by owner
**Edits allowed:** As specified by owner
**Expected output:** `~/codex-audit/bikosoc/<date>-ad-hoc.md`

### Prompt

> Read `workspace/codex/CODEX_README.md` and the files it lists before doing
> anything.
>
> [Owner provides specific audit instructions here.]
>
> Follow the standard findings format (CRITICAL/HIGH/MEDIUM/LOW with
> file:line references). Write results to the output file above.
