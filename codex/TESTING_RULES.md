# TESTING RULES — Codex Auditor Reference (bikosoc)

**Purpose:** Rules for how Codex evaluates and interacts with the bikosoc
test suite. References the authoritative CI-Tests section in
`executive-agent/CLAUDE.md`.

---

## Source of Truth

All test requirements are defined in `executive-agent/CLAUDE.md` under:
- "CI-Tests — MUSS GRUN BLEIBEN" (mandatory test matrix)
- "Deployment" section (smoke test as post-deploy gate)
- Sprint-specific sections (per-module test descriptions)

This file does NOT restate those requirements. It defines Codex-specific
rules for auditing and validating tests.

## Mandatory Tests (reference)

The mandatory test list lives in `executive-agent/CLAUDE.md` (lines 414-438).
Codex must verify these tests exist, are not skipped, and match their
documented descriptions. See Template 2 (Test Coverage Audit) in
`CODEX_AUDIT_PROMPTS.md`.

## Codex Test Validation Rules

### In READ_ONLY_AUDIT mode

1. **Never run tests.** Validate by reading test source files only.
2. Count `describe`, `it`, `test` blocks to verify claimed test counts.
3. Check for `.skip`, `.only`, `xit`, `xdescribe` — these indicate
   disabled tests.
4. Verify test file paths match CLAUDE.md references.
5. Check that test assertions match documented behaviors.

### In IMPLEMENT_WITH_APPROVAL mode (if granted)

1. **May run `npm test` or `bun test`** only with owner approval.
2. **May run `bun run scripts/smoke-test.ts`** only with owner approval.
3. **May run `npm run verify-schema`** (drift detector) only with owner
   approval and confirmation that DB connection is safe.
4. **Never run tests against production data.** Test DB isolation is
   per-file via `POSTGRES_URL` override.
5. If tests fail, report the failure — do not auto-fix without owner
   approval.

## Known Issues

### bun test Parallelism

Documented in `executive-agent/CLAUDE.md`: multiple test files override
`POSTGRES_URL` to use isolated test databases. When `bun test` runs files
in parallel, these overrides conflict. All tests pass when run
individually/sequentially.

**Codex rule:** When auditing test results, if parallel failures occur,
re-validate by checking if tests pass individually before flagging as a
real failure.

## Smoke Test

- **Location:** `executive-agent/scripts/smoke-test.ts`
- **Claimed count:** 28/28 (as of Sprint 11.7)
- **When it runs:** After every build + restart (deployment protocol)
- **Gate:** Exit code 1 = deployment failed, must fix before declaring done
- **Codex rule:** Audit the smoke test source to verify the actual check
  count matches the claimed count. See Template 9 (Self-Report Verification).

## Drift Detector

- **Command:** `npm run verify-schema` (in executive-agent)
- **Script:** `scripts/verify-schema-versions.ts`
- **What it does:** Compares SQL migration files on disk with
  `schema_version` table in DB.
- **Gate:** Exit 0 is mandatory before every commit/release.
- **Codex rule:** In READ_ONLY_AUDIT, verify the script exists and is
  referenced in `package.json` scripts. Do not run it without owner
  approval.
