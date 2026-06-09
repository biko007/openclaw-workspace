# ARCHITECTURE GUARDRAILS — bikosoc

**Purpose:** Observed architectural invariants, populated by Codex during
its first code-level audit. Not guessed — derived from actual source
inspection.

**Rule:** This file is a template until populated. Every entry must cite
the source file and line where the invariant was observed.

---

## Module Dependency Graph

TODO(owner): Codex first audit will map actual imports between modules.

```
Format:
  module-A --> module-B  (file:line — reason)
  module-C --> shared/db (file:line — DB access)
```

## API Surface Inventory

TODO(owner): Codex first audit will extract actual routes from source.

### executive-agent (gateway)

```
Format:
  METHOD /api/path  →  module/handler  (file:line)
```

### executive-dashboard

```
Format:
  METHOD /api/path  →  handler | proxyToCore  (file:line)
```

## DB Table Ownership Map

TODO(owner): Codex first audit will map tables to owning modules.

```
Format:
  table_name  →  module  (migration file)
```

## Advisory Lock Registry

TODO(owner): Codex first audit will extract all pg_advisory_lock IDs.

```
Format:
  lock_id  →  purpose  (file:line)
```

## Idempotency Key Usage

TODO(owner): Codex first audit will map idempotency patterns.

```
Format:
  operation  →  key source  (file:line)
```

## Known Tech Debt

TODO(owner): Codex first audit will extract from code inspection.

```
Format:
  TD-N: description  (file:line, severity, documented in CLAUDE.md: yes/no)
```

---

*Last updated: TODO(owner) — to be filled by Codex's first audit session.*
