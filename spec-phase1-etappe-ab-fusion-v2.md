# Phase 1 Instagram — Etappe A+B Fusion-Sprint **v2**
## Inbox-Konsolidierung + Bild-Edit + 4:5 Portrait

**Stand:** 2026-05-17 (v2, nach 4-LLM-Review-Konsolidierung)
**Vorgänger:** `spec-phase1-etappe-ab-fusion.md` (v1, ungültig)
**Scope:** iOS-Share-Sheet-Inbox, Telegram-Parität, Dashboard-Fix, Bild-Edit (sync) + Video-Edit (async) mit 4:5 Portrait
**Out of Scope:** Album-Watch (Phase 2), Dashboard-Manager-UX (Etappe C), Helligkeit/Kontrast-Auto, Performance-Feedback (Etappe D)

---

## Hard Rules

- **Plan Mode (Shift+Tab ×2) Pflicht** — Sprint berührt ~15+ Files in 3 Repos.
- **Build-Gate pro Etappe:** `bun run build && bun run check:node && systemctl --user restart [service] && bun run scripts/smoke-test.ts`. Package-Manager: **Bun** (laut E0-Diagnose).
- **`git add -A` nach jeder Etappe**, `git status` muss "nothing to commit, working tree clean" zeigen vor push.
- **Drei-Repo-Commit-Pattern:** agent + dashboard + workspace, jeweils einzeln, konventionelle Commits.
- **Audit-Log IN der Transaktion** bei jedem Schreibvorgang (`audit_log` Tabelle).
- **Approval-Hard-Rule explizit:** Inbox-Ingestion ist eine **auditierte Eigen-Schreibaktion** (kein interaktives Approval beim Upload). Publishing / externe Posts bleiben approval-pflichtig.
- **Diagnose-First:** Wenn Spec-Premise widerlegt → **STOP + Rückfrage**, nicht stillschweigend anpassen.
- **Build-Hooks aktiv:** `build` läuft automatisch nach jedem TS-Edit.
- **Smoke-Tests pro Etappe** (nicht erst am Ende) — neue Tests werden im selben Etappen-Commit hinzugefügt.

---

## Architektur-Defaults v2 (nach Review-Konsolidierung)

| # | Bereich | Entscheidung | Quelle |
|---|---|---|---|
| 1 | Auth | Neuer `INBOX_TOKEN`, Bearer-Header **only**, niemals URL/Query, constant-time compare gegen SHA256(token) | 4/4 LLMs |
| 2 | Share-Sheet-UX | Kein Kontext-Eingabefeld — 1-Tap-Upload | unverändert |
| 3 | sharp-Location | Im Agent (Core) | unverändert |
| 4 | Bild-Crop | Center-Crop sync beim Upload, Vision-Re-Crop später async bei `/instacraft` | unverändert |
| 5 | Video-Pipeline | **Async** über Status-Modell (`uploaded → processing → edited / edit_failed`) | ChatGPT + Kimi |
| 6 | Cover-Frame | Default **1 Sekunde** (nicht 25%) — bessere Hook-Qualität, vermeidet schwarze Frames | Gemini + Kimi |
| 7 | Helligkeit/Kontrast Auto | SKIP — Backlog | unverändert |
| 8 | `canvas`-Dependency | Entfernen | unverändert |
| 9 | Output-Pfad | `instagram/raw/{session}/original/` + `instagram/raw/{session}/edited/` + `.tmp/{uuid}/` (Atomic-Rename-Schicht) | erweitert |
| 10 | Storage-Modell | **Dedizierte Tabelle `insta_media_edits`** (DDL in V037) | ChatGPT + Kimi |
| 11 | Idempotenz | SHA256(original) + Sequenz-Naming (NN+1) kombiniert, UNIQUE-Constraint auf `(session_id, media_index, variant)` | 4/4 LLMs |
| 12 | Vision-Cache | JSONB mit `model`, `schema_version`, `source_hash`, `confidence`, `cached_at`; Reuse nur bei Hash-Match | ChatGPT + Kimi |
| 13 | Atomicity | `tmp` → atomic rename → kurze DB-TX (Audit) → Edit → zweite DB-TX (Status) | ChatGPT |
| 14 | Failure-Modes | Per-File-Status, HTTP 207 Multi-Status, nie Gesamt-Reject bei Multi-Upload | 4/4 LLMs |
| 15 | Retention | 30 Tage nach `published`, sofort bei `deleted` — als **dry-run-Command** in E7 | 4/4 LLMs |

---

## Datenmodell (V037 DDL)

```sql
-- V037_insta_media_edits.sql
CREATE TABLE insta_media_edits (
  id              BIGSERIAL PRIMARY KEY,
  session_id      TEXT      NOT NULL,
  media_index     INT       NOT NULL,           -- Sequenz pro Session (NN aus YYMMDD-jb-NN)
  draft_id        TEXT      NULL REFERENCES insta_drafts(id) ON DELETE SET NULL,
  variant         TEXT      NOT NULL,           -- 'original' | 'center_4x5' | 'vision_4x5' | 'video_4x5' | 'cover_frame'
  source_path     TEXT      NOT NULL,           -- relativ zu media-root
  output_path     TEXT      NULL,               -- relativ; null bei variant='original' oder vor Edit
  sha256_original TEXT      NOT NULL,
  sha256_output   TEXT      NULL,
  params_hash     TEXT      NULL,               -- für Re-Crop-Idempotenz (z.B. crop-coords)
  status          TEXT      NOT NULL DEFAULT 'uploaded',
  error_code      TEXT      NULL,
  error_message   TEXT      NULL,
  vision_metadata JSONB     NULL,               -- { model, schema_version, source_hash, subject_bbox, confidence, cached_at }
  source          TEXT      NOT NULL,           -- 'telegram' | 'ios_shortcut' | 'dashboard'
  request_id      TEXT      NULL,               -- trace_id für Audit-Verkettung
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_variant CHECK (variant IN ('original','center_4x5','vision_4x5','video_4x5','cover_frame')),
  CONSTRAINT chk_status  CHECK (status  IN ('uploaded','processing','edited','edit_failed','deleted')),
  CONSTRAINT chk_source  CHECK (source  IN ('telegram','ios_shortcut','dashboard'))
);

CREATE UNIQUE INDEX uq_media_edit_active_variant
  ON insta_media_edits (session_id, media_index, variant, COALESCE(params_hash, ''))
  WHERE status != 'deleted';

CREATE INDEX ix_media_edit_session ON insta_media_edits (session_id);
CREATE INDEX ix_media_edit_draft   ON insta_media_edits (draft_id) WHERE draft_id IS NOT NULL;
CREATE INDEX ix_media_edit_hash    ON insta_media_edits (sha256_original);
CREATE INDEX ix_media_edit_status  ON insta_media_edits (status) WHERE status IN ('processing','edit_failed');
```

**Backwards-Kompatibilität:** Die bestehende `insta_drafts.media_files` JSONB-Spalte bleibt unverändert (Working-Set / Inventar). `insta_media_edits` ist die **Historie + Edit-Varianten**. Beim Draft-Build (`/instacraft`) wird `media_files` weiterhin geschrieben, **plus** der zugehörige `media_edits.id` referenziert.

---

## Sicherheits- & Limit-Block (gilt übergreifend)

| Schicht | Setting | Wert |
|---|---|---|
| nginx | `client_max_body_size` für `/api/instagram/inbox` | 600M (für 4K-Videos) |
| nginx | `limit_req` Zone für Inbox | 10 req/min, burst 5 |
| Express/Bun-Multer | Max files per request | 10 |
| Multer | Max single file size (Bild) | 50 MB |
| Multer | Max single file size (Video) | 500 MB |
| Multer | Upload-Timeout | 120 s |
| MIME-Whitelist | Bilder | `image/jpeg`, `image/png`, `image/heic`, `image/heif` |
| MIME-Whitelist | Videos | `video/mp4`, `video/quicktime` |
| Auth | Vergleich | `crypto.timingSafeEqual(sha256(token), INBOX_TOKEN_SHA256)` |
| Auth | Reihenfolge | Bearer-Header-Check **vor** Multipart-Parsing |
| Auth | Query-Token | explizit **rejecten** (400 mit Hinweis) |
| Audit | Felder | `actor`, `source`, `session_id`, `media_id`, `sha256`, `request_id`, **keine Tokens, keine absoluten Pfade** |
| Path-Sicherheit | Original-Filenames | **niemals** als Pfad — nur generierte Namen |
| Path-Sicherheit | Session-ID | Whitelist-Regex `^[a-z0-9-]{1,40}$`, sonst 400 |
| Path-Sicherheit | Media-Root-Begrenzung | `path.resolve()` muss unter `MEDIA_ROOT` liegen, sonst Reject |
| ffmpeg | Aufruf | `spawn(['ffmpeg', ...args])` — **niemals Shell-String** |
| ffmpeg | Hard-Timeout | 180 s pro Job, dann `kill('SIGKILL')` |
| Disk | Vor jedem Video-Job | `df` Check, min. 20% frei oder 5 GB |
| EXIF | sharp-Konfiguration | `.rotate()` (auto-orient), GPS-Strippung explizit, restliche Metadaten erhalten |

---

## Etappe 0 — Pre-Diagnose (read-only, ~10–15 Min)

```bash
cd ~/executive-agent

# 0.1 Package-Manager-Klärung (Spec sagt Bun, package-lock.json existiert evtl.)
ls -la package-lock.json bun.lockb 2>/dev/null
cat package.json | jq '.scripts | keys'

# 0.2 sharp im Agent installiert?
grep -E '"sharp"' package.json || echo "sharp fehlt — install in E3"

# 0.3 canvas-Verwendung (direkt + transitiv)
grep -rn -E "from ['\"]canvas['\"]|require\(['\"]canvas['\"]" --include="*.ts" src/ 2>/dev/null || echo "Kein direkter canvas-Import"
npm ls canvas 2>/dev/null || bun pm ls canvas 2>/dev/null  # transitiv

# 0.4 libvips System-Package (sharp-Dependency)
pkg-config vips --modversion 2>/dev/null || echo "libvips fehlt — apt install libvips-dev (BLOCKER)"

# 0.5 ffmpeg + ffprobe
ffmpeg -version | head -1
ffprobe -version | head -1
ffmpeg -version | grep -E "libheif|libheic" && echo "HEIC-Support OK" || echo "HEIC evtl. nicht supported"

# 0.6 Disk-Space
df -h /home/biko ~/.openclaw

# 0.7 nginx body-size aktuell
grep -E "client_max_body_size" /etc/nginx/sites-available/openclaw.conf || echo "kein body-size set — default 1M"

# 0.8 Bestehende Service-Tokens
grep -E "_TOKEN" ~/.config/openclaw/env | awk -F= '{print $1}' | sort

# 0.9 DB-Schema-Stand
psql -h localhost -U openclaw -d openclaw_core -c "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 5;"

# 0.10 insta_drafts.media_files Struktur — Beispiel-Eintrag
psql -h localhost -U openclaw -d openclaw_core -c "SELECT id, jsonb_pretty(media_files) FROM insta_drafts LIMIT 1;"

# 0.11 Test-Fixtures vorbereiten (Hinweis im Bericht, nicht ausführen)
# - 1× JPG (Standard)
# - 1× HEIC (iOS-Realität)
# - 1× MOV (iOS-Video)
# - 1× corrupt file (Error-Path-Test)
```

**STOP-Kriterien:**
- libvips fehlt → erst `sudo apt install libvips-dev` (User-Aktion, kein Auto-Install)
- ffmpeg < 4.0 → Spec-Abgleich nötig
- HEIC-Support fehlt → Entscheidung: HEIC ablehnen oder libheif nachziehen
- Schema-Stand ≠ V035 → Konflikt-Klärung
- INBOX_TOKEN-Name kollidiert → alternativen Namen wählen

**Output:** Mini-Bericht (10–15 Zeilen) mit allen Checks. **Wartet auf User-OK** bevor E1a startet.

---

## Etappe 1a — Auth + nginx + Limits (KEIN Endpoint-Test)

**Ziel:** Infrastruktur für Inbox-Endpoint vorbereiten. Endpoint-Test wandert nach E2b.

**Schritte:**
1. `INBOX_TOKEN` (64-stellig hex) generieren, in `~/.config/openclaw/env` (chmod 600)
2. `INBOX_TOKEN_SHA256` ableiten + zusätzlich in env (App vergleicht gegen Hash, nicht Klartext)
3. nginx-Snippet einfügen:
   - Route `POST /api/instagram/inbox` → `http://127.0.0.1:18789`
   - `client_max_body_size 600M;`
   - `limit_req zone=inbox burst=5 nodelay;` + `limit_req_zone $binary_remote_addr zone=inbox:10m rate=10r/m;` im http-Block
4. `nginx -t` + Reload — **erst dann committen**

**Test:** `nginx -t` passes, `curl -X POST https://app.bikobickel.de/api/instagram/inbox -H "Authorization: Bearer x"` → 502 (Endpoint existiert noch nicht, erwartet)

**Commit:** `feat(infra): inbox routing + body-size + rate-limit (E1a)`

---

## Etappe 1b — V037 DDL `insta_media_edits`

**Schritte:**
1. Migration `migrations/V037_insta_media_edits.sql` mit DDL aus Datenmodell-Block
2. Migration apply: `bun run db:migrate` (oder npm-Pendant)
3. Sanity-Check: `\d+ insta_media_edits` + Test-INSERT + ROLLBACK

**Commit:** `feat(db): V037 insta_media_edits table for edit versioning (E1b)`

---

## Etappe 2a — Session-Helper-Refactor (isoliert, kein neuer Endpoint)

**Ziel:** Wiederverwendbarer Session-/Naming-Helper, **ohne Inbox-Endpoint anzufassen**. Bestehender Telegram-Flow muss weiter funktionieren.

**Schritte:**
1. Neue Datei `src/modules/instagram/session-helper.ts`:
   - `getOrCreateActiveSession(senderId, source)` → Session-ID, atomisch
   - `nextMediaIndex(sessionId)` → INT, per `pg_advisory_xact_lock(45)` + max(media_index)+1
   - `buildMediaName(sessionId, mediaIndex, ext)` → `YYMMDD-jb-NN.ext`
   - `sanitizeSessionId(input)` → wirft 400 bei Regex-Miss
2. Bestehenden Telegram-Upload-Pfad in `commands.ts` refactoren — gleiche Helper nutzen, identisches Verhalten
3. Tests: 2 parallele Calls produzieren eindeutige `media_index` (DB-Lock testen)

**Build-Gate:** Bestehender Telegram-Upload-Smoke-Test grün — kein Regressions-Bruch.

**Commit:** `refactor(instagram): extract session+naming helpers (E2a)`

---

## Etappe 2b — Inbox-Endpoint

**Ziel:** `POST /api/instagram/inbox` voll funktional, integriert Helper aus E2a.

**Schritte:**
1. Auth-Middleware (vor Multer): Header-only, constant-time compare, Query-Token-Reject
2. Multer-Konfiguration mit allen Limits aus Sicherheits-Block
3. Pipeline pro Datei:
   - Schreibe in `.tmp/{uuid}/` (Disk-Write)
   - SHA256 berechnen
   - **Hash-Lookup** in `insta_media_edits` — wenn vorhanden: kein neuer Upload, Existing referenzieren
   - `nextMediaIndex(sessionId)` (E2a-Helper)
   - **Atomic rename** nach `raw/{session}/original/YYMMDD-jb-NN.ext`
   - Kurze DB-TX: INSERT `insta_media_edits` (variant='original', status='uploaded') + audit_log
4. Für Bilder: synchron weiter zu E3-Pipeline (Center-Crop)
5. Für Videos: Job in async-Queue (kommt E4a)
6. Response: HTTP 207 mit `{ session_id, files: [{ media_index, status, edit_id, hint }], request_id }`

**Files:**
- `src/modules/instagram/inbox.ts` (neu)
- `src/modules/instagram/inbox-auth.ts` (neu, Bearer-Middleware)
- `index.ts` (Route registrieren)

**Tests:**
- 401 bei ungültigem Token
- 400 bei Query-Token
- 400 bei ungültigem MIME
- 413 bei zu großer Datei
- 200/207 mit 3 gemischten Files (JPG + HEIC + MOV)
- Dedup: 2× selbe Datei hochladen → zweiter Upload referenziert bestehenden Hash

**Commit:** `feat(instagram): unified inbox endpoint with auth+limits (E2b)`

---

## Etappe 2c — Dashboard-Upload-Fix

**Ziel:** `POST /api/instagram/raw/:id/upload` nutzt gleichen Naming-Helper.

**Schritte:**
1. `executive-dashboard/server.mjs` — Upload-Handler refactoren auf E2a-Helper (proxied an Core)
2. Owner-Check beibehalten
3. Audit-Log-Eintrag mit `source='dashboard'`

**Commit (dashboard-Repo):** `fix(instagram): use shared YYMMDD naming for dashboard raw upload (E2c)`

---

## Etappe 3 — sharp + Image Center-Crop (sync)

**Schritte:**
1. `bun add sharp` (oder npm — laut E0)
2. `bun remove canvas` (laut E0-Bestätigung)
3. `src/modules/instagram/image-edit.ts`:
   - `normalizeOrientation(input)` — EXIF rotate via `sharp().rotate()`
   - `stripGps(metadata)` — GPS aus EXIF, andere Metadaten erhalten
   - `cropTo4x5Center(input, output)` → 1080×1350
   - Pipeline-Chain mit `.clone()` für Multi-Output
4. Hook in E2b-Inbox: nach DB-INSERT `original`, sync Center-Crop für `image/*`
5. Schreibe `.tmp` → atomic rename → DB-INSERT `variant='center_4x5'`, status='edited'
6. Failure: `status='edit_failed'`, `error_message`, Original bleibt
7. EXIF: `.withMetadata({ exif: { ... ohne GPS ... } })` explizit

**Tests:**
- JPG mit Orientation-Flag → korrekt rotiert
- HEIC → konvertiert + gecroppt
- Bild ohne EXIF → kein Fehler
- Corrupt file → `edit_failed` mit error_message

**Commit:** `feat(instagram): sharp center-crop 4:5 with EXIF handling (E3)`

---

## Etappe 4a — Async-Job-System + ffmpeg-Engine

**Ziel:** Async-Processing für Videos. In-Memory-Queue (kein Redis), reicht für Solo-User-Setup.

**Schritte:**
1. `src/modules/instagram/edit-queue.ts`:
   - `p-queue` mit `concurrency: 2`, persisted state in `insta_media_edits.status='processing'`
   - Job-Pickup beim Start: Alle `status='processing'` älter als 5 Min → reset auf `uploaded` (Recovery)
2. `src/modules/instagram/ffmpeg-engine.ts` erweitern:
   - `spawn(['ffmpeg', ...args])` — kein Shell-String
   - 180s Hard-Timeout, dann `proc.kill('SIGKILL')`
   - Disk-Check vor Start (`statvfs` oder `df`)
   - Args-Validierung: Pfade müssen unter MEDIA_ROOT liegen
3. Failure-Behandlung: status='edit_failed' + error_message

**Tests:**
- Job pickup nach Service-Restart (`processing` → `uploaded` Recovery)
- Concurrency-Limit: 5 Videos parallel → max 2 laufen
- Timeout: Endlosjob → SIGKILL nach 180s

**Commit:** `feat(instagram): async edit queue + hardened ffmpeg wrapper (E4a)`

---

## Etappe 4b — Video 4:5 + Cover-Frame (Default 1s) + /instaedit Override

**Schritte:**
1. `scaleVideoTo4x5(input, output)`:
   - `ffmpeg -i input -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1350" -c:a copy ...`
   - Wenn Input kein Audio: `-an` (sonst Codec-Fehler)
   - Per `ffprobe` Audio-Stream-Existenz prüfen
2. `extractCoverFrame(input, output, positionSec=1)`:
   - `ffmpeg -ss <pos> -i input -vframes 1 -q:v 2 ...`
   - Edge-Case: Video < 1s → ersten Frame nehmen
   - Edge-Case: schwarzer Frame → Fallback auf Position+0.5s (ein Retry)
3. Inbox-Endpoint (E2b) Video-Branch: Job in Queue → 2 Edits (`video_4x5` + `cover_frame`)
4. `/instaedit <draft_id> cover_frame=<seconds>` Command:
   - Validierung: 0 ≤ sec ≤ video-Dauer
   - Re-Job, neue Edit-Row mit gleichem `variant='cover_frame'` (UNIQUE-Constraint greift → neuer media_index?)
   - **Konfliktlösung:** für Override: alte Cover-Frame-Row als `status='deleted'` markieren (fällt aus partial UNIQUE-Index raus), neue einfügen mit neuem `params_hash` → UNIQUE `(session_id, media_index, variant, COALESCE(params_hash,'')) WHERE status!='deleted'` wird nicht verletzt.

**MUSS-Klärung VOR E1b:** UNIQUE-Constraint = `(session_id, media_index, variant, COALESCE(params_hash, ''))` statt nur 3-Spalten. Im DDL-Block bereits oben angepasst? **Nein** — wird in E1b ergänzt.

**Tests:**
- Vertikales 9:16-Video → korrekt auf 4:5 gecroppt
- Video ohne Audio → kein Fehler
- Short-Video (<1s) → Cover bei Frame 0
- Override: `/instaedit draft cover_frame=3.5` → neuer Cover, alter `deleted`

**Commit:** `feat(instagram): video 4:5 + cover frame + override (E4b)`

---

## Etappe 5 — Vision-gestützter Re-Crop bei `/instacraft`

**Schritte:**
1. Vision-Prompt erweitern: `subject_bbox` (relative coords) + `confidence` + `model_used`
2. Validierung: `0 ≤ x,y,w,h ≤ 1`, `w ≥ 0.05`, `h ≥ 0.05`, sonst Fallback Center-Crop
3. BBox runden/clampen (3 Dezimalstellen) → vermeidet `v2/v3/v4`-Explosion durch minimale Drift
4. `cropTo4x5SubjectAware(input, output, bbox)` via sharp
5. Re-Crop schreibt `variant='vision_4x5'` mit `params_hash=hash(bbox)` und `vision_metadata`
6. Idempotenz: Wenn `(sha256_original, params_hash)` schon existiert → kein neuer Crop
7. `vision_metadata.source_hash` muss mit aktuellem Original-SHA matchen, sonst Vision neu

**Tests:**
- Same Vision-Result 2× → kein neuer Crop
- Ungültige BBox → Fallback auf Center
- Source-File geändert → Vision neu

**Commit:** `feat(instagram): vision-aware 4:5 re-crop with caching (E5)`

---

## Etappe 6 — iOS-Shortcut-Doku

**Ziel:** Bauanleitung für den User.

**Datei:** `docs/ios-instagram-shortcut.md` im agent-Repo

**Inhalt:**
1. Shortcut-Schritte:
   - "Get File from Input" (Bilder + Videos, multiple)
   - "Get Variable" → `OPENCLAW_INBOX_TOKEN` (aus iCloud-Keychain, **nicht in URL**)
   - "POST URL" mit Header `Authorization: Bearer <variable>`
   - "Get Dictionary Value" für `status` aus Response
   - "If" → bei Fehler `Show Notification` mit `error_code` + `request_id`
2. Token-Setup: Anleitung wie Token-Variable in iOS Settings → Keychain (oder Shortcut-Variable mit "Don't Show When Run")
3. Testanleitung: 1× Foto teilen, Response-Erwartung, Bestätigungstext
4. Hinweis: Album-Watch kommt Phase 2

**Commit:** `docs(instagram): ios share-sheet shortcut guide (E6)`

---

## Etappe 7 — End-to-End-Smoke + Retention-Cleanup

**Schritte:**
1. `scripts/smoke-test.ts` erweitern:
   - Test-Fixtures `tests/fixtures/instagram/` (JPG, HEIC, MOV, corrupt) — committed im workspace-Repo
   - **Mock-Vision** (kein echter API-Call) — Test-stable, kein Anthropic-Credit-Verbrauch
   - End-to-End-Flow: Upload → DB-Row → Edit → Vision-Mock → Re-Crop → Final-State
   - Test-Session-Prefix `smoke-test-` — Cleanup garantiert
2. `scripts/instagram-retention-cleanup.ts` (dry-run default):
   - SELECT Files für Deletion (`published_at < NOW() - 30 days` + `status != 'archived'`)
   - Output: Liste der Pfade + Bytes
   - Flag `--apply` für echte Löschung (nicht in Standard-Smoke)
3. Optional: n8n-Workflow `instagram-retention-daily` definieren (NICHT aktivieren — User-Entscheidung später)

**Commit:** `feat(instagram): e2e smoke + retention dry-run command (E7)`

---

## Etappe 8 — Audit-Pre-Closure + Memory-Update

**Ziel:** Read-only Diagnose aller neuen Pfade vor Closure (Audit-Pre-Closure-Pattern, Memory).

**Schritte:**
1. **Lesepfade-Audit:** Alle neuen + geänderten Endpoints — lesen sie wirklich aus DB, nicht versehentlich noch File-System?
   - `grep -rn -E "readFile|readFileSync.*instagram" src/modules/instagram/` → erwartete Fundstellen prüfen
2. **Audit-Log-Coverage:** Jede Schreibaktion in `insta_media_edits` hat audit_log-Eintrag?
3. **Orphan-Scan:** Files in `original/` ohne DB-Row? DB-Rows ohne File? → in Mini-Bericht
4. **Backlog dokumentieren** in `runbook-instagram.md` (workspace-Repo):
   - Etappe-C-Backlog: Status-Mismatch-Fix `index.html:2566`, Badge-Cleanup, Audit-Log-Check `updateDraft()`
   - Phase-2: Album-Watch
   - Nice-to-Haves aus Review: Token-SHA256, request_id, media doctor, Bun/npm-Klärung, Helligkeit/Kontrast-Auto
5. **Memory-Update-Vorschlag** (Text im Bericht, User-OK abwarten):
   - "Sprint A+B Fusion done (2026-05-XX): INBOX_TOKEN, sharp, ffmpeg async-queue, insta_media_edits V037. iOS-Share-Sheet live. Retention dry-run."

**Commit:** `chore(instagram): closure E8 — audit + runbook + backlog`

---

## Failure-Recovery (überarbeitet)

| Etappen-Failure | Recovery-Pattern |
|---|---|
| E1a (nginx) | `git checkout HEAD~1 -- /etc/nginx/...` (oder: nginx-Snippet manuell raus), `nginx -t`, reload |
| E1b (Migration) | `psql -c "DROP TABLE insta_media_edits;"` + `DELETE FROM schema_version WHERE module='instagram' AND version=37;` + git reset |
| E2a/b/c (Code) | `git reset --hard HEAD~1` im jeweiligen Repo + `systemctl --user restart [service]` |
| E3 (sharp) | Bei `libvips`-Build-Error: `sudo apt install libvips-dev`, dann `bun install` retry. Bei sharp-Runtime-Error: `git reset` |
| E4a (Queue) | Jobs in `processing` älter 5 Min → manuell auf `uploaded` zurücksetzen, Service-Restart |
| E4b (ffmpeg) | bei Audio-Codec-Fehler: ffprobe-Output prüfen, ggf. `-an` ergänzen |
| E5 (Vision) | Fallback auf Center-Crop unverändert — kein Block |

**Kein `systemctl revert`** (das ist für Unit-Overrides, nicht App-Code).

---

## Smoke-Test-Baseline

Aktuell 28/28. Erwartung nach E8: **40+/40+**. Neue Tests u.a.:
- Inbox 401, 400 (Query-Token), 400 (MIME), 413 (Größe), 207 (Multi-Upload)
- Hash-Dedup
- Race-Condition `media_index` (parallele Inserts)
- HEIC + EXIF-Rotation
- Video async-Job pickup
- Cover-Frame Edge-Cases (short video, schwarzer Frame)
- Vision-Re-Crop Idempotenz
- Retention dry-run output

---

## Erwartete Lieferzeit (User-Korrektur: Schätzungen knapp halten)

- E0: 10–15 Min
- E1a + E1b: 10 Min + 10 Min
- E2a + E2b + E2c: 15 + 25 + 10 Min
- E3: 20 Min
- E4a + E4b: 25 + 25 Min
- E5: 15 Min
- E6: 15 Min
- E7: 20 Min
- E8: 10 Min
- **Gesamt Claude-Code-Zeit:** ~3,5 Stunden (akkumuliert), verteilt über 1–2 Tage

iOS-Shortcut-Bau auf deinem iPhone: ~15 Min einmalig.

---

## Drei-Repo-Commit-Übersicht

| Repo | Etappen + Files |
|---|---|
| `executive-agent` | E1b (V037), E2a (session-helper), E2b (inbox), E3 (image-edit), E4a (queue+ffmpeg), E4b (video), E5 (vision), E6 (docs), E7 (smoke+retention), E8 (audit) |
| `executive-dashboard` | E2c (raw-upload-fix) |
| `openclaw-workspace` | Diese Spec (v2), final-Diagnose-Berichte, Test-Fixtures, runbook-instagram.md Update |

---

## Backlog (für nach diesem Sprint)

- Token-SHA256-Vergleich auf alle Bearer-Endpoints rollen
- `request_id`/`trace_id`-Propagation systemweit
- `media doctor` Orphan-Scan-Command
- Helligkeit/Kontrast-Auto-Adjustment (eigene Mini-Etappe)
- Album-Watch (Phase 2)
- Bun/npm-Final-Vereinheitlichung
- Vision-API-Cost-Caps (Cross-Cutting)
- Hashtag-Pool-Auto-Updates (Etappe D)
