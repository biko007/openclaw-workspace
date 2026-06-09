# DB MIGRATION RULES — Codex Auditor Reference (bikosoc)

**Purpose:** Rules for how Codex audits database migrations in the bikosoc
area. References the authoritative Schema Migration Convention in
`executive-agent/CLAUDE.md` (Sprint 11.5 section).

---

## Source of Truth

The migration convention is defined in `executive-agent/CLAUDE.md` under
"Schema-Migration-Konvention (Sprint 11.5)". This file does NOT restate
that convention. It defines Codex-specific audit rules.

## Dual Pattern (reference)

1. **V-Prefix (`Vxxx__name.sql`):** One-shot migrations with data import.
   Run manually via `bun run scripts/migrate-*.ts --apply`.
2. **0xx-Prefix (`0xx_name.sql`):** Boot-time DDL-only via `runMigrations()`.
   Idempotent (`IF NOT EXISTS`), runs automatically at gateway start.

## Migration File Locations

```
src/shared/migrations/              (001)
src/shared/settings/migrations/     (035)
src/modules/executive/migrations/   (001)
src/modules/instagram/migrations/   (020, V037)
src/modules/assets/migrations/      (V022, V023, V024, V030, V031, V036)
src/modules/banking/migrations/     (V027, V028, V029)
src/modules/fleet/migrations/       (V025, V026, V037)
src/modules/health/migrations/      (V021)
src/modules/sharepoint/migrations/  (034)
src/modules/location/migrations/    (032)
src/modules/links/migrations/       (033)
```

## Migrate Scripts (reference)

Listed in `executive-agent/CLAUDE.md` under "Migrate-Skripte (One-Shot,
manuell)". Codex verifies these scripts exist and match their documented
version numbers.

## Codex Migration Audit Rules

### In any mode

1. **Never create migration files.** Migration creation is an owner/Claude
   Code task, not a Codex task.
2. **Never run migrations against production.** The `openclaw_core` database
   is off-limits.
3. **Never modify existing migration files.** Migrations are immutable once
   applied.

### In READ_ONLY_AUDIT mode

1. **Version gap detection:** List all V-prefix versions in order. Flag
   gaps (e.g., V024 exists but V025 is missing for a module that should
   have it).
2. **Naming compliance:** Verify V-prefix files follow `Vxxx__name.sql`
   pattern; boot-time files follow `0xx_name.sql` pattern.
3. **Idempotency check:** Boot-time migrations (0xx prefix) must use
   `IF NOT EXISTS`, `CREATE OR REPLACE`, or equivalent idempotent DDL.
   Flag any that don't.
4. **Cross-module isolation:** Each migration should only touch tables
   owned by its module. Flag any migration that modifies another module's
   tables.
5. **Migrate-script existence:** For each entry in the CLAUDE.md
   migrate-script table, verify the script file exists on disk.
6. **Rollback script inventory:** Check for `rollback-v*.ts` scripts and
   note which versions have rollback coverage.
7. **Drift detector integrity:** Verify `scripts/verify-schema-versions.ts`
   exists and is registered in `package.json` scripts as `verify-schema`.

### Documentation cross-reference

- Compare the migration file list on disk with the list in CLAUDE.md.
- Any file on disk not documented in CLAUDE.md is a MEDIUM finding.
- Any file documented in CLAUDE.md but missing on disk is a CRITICAL finding.

## DR Path (reference)

`pg_dump --format=custom` is the truth source for disaster recovery,
independent of the migration runner. Borg backup secures the dump daily.
Codex does not interact with backups but may audit that the backup
infrastructure is documented and configured.
