# Instagram Runbook

## Stale Edit Queue Jobs (E4a)

Jobs stuck in `processing` for >5 minutes are auto-recovered on service restart.

**Check:**
```sql
SELECT id, session_id, media_index, variant, status, updated_at
FROM insta_media_edits WHERE status = 'processing';
```

**Manual recovery:**
```sql
UPDATE insta_media_edits SET status = 'uploaded', updated_at = NOW()
WHERE status = 'processing' AND updated_at < NOW() - INTERVAL '5 minutes';
```

**Health endpoint:**
```bash
curl -s http://127.0.0.1:18789/api/instagram/queue/health \
  -H "Authorization: Bearer $CORE_SERVICE_TOKEN" | jq .
```

## Telegram Callback Pattern (E1-E4, 2026-05-18)

New modules that need inline-keyboard buttons should use `event.content` (not `event.raw.callback_query`).

**Pattern:**
- Framework v2026.2 delivers callback data as `event.content` string in `message_received`
- Parse with helper: `src/shared/telegram-callback/index.ts` → `parseTelegramCallback(content)`
- `answerCallbackQuery` no longer needed — framework auto-answers before dispatch
- LLM suppression: add callback prefix to `CALLBACK_PREFIXES` array in `index.ts` `before_agent_start`

**Files:**
- Helper: `src/shared/telegram-callback/index.ts`
- Callback dispatch: `src/modules/instagram/commands.ts` (search `message_received` + `parseTelegramCallback`)
- LLM guard: `index.ts` `before_agent_start` → `CALLBACK_PREFIXES` array + craft-dialog TTL check

## Bekannte offene Bugs / Backlog

1. **Vision-API 5MB-Limit:** iPhone-Bilder >3.7MB raw werden von Anthropic Vision abgelehnt. Braucht Resize-Pre-Step vor `analyzeSessionFiles()`.
2. **sharp extract_area:** `bad extract area` bei manchen iPhone-Bildern. Bound-Check vor `sharp().extract()` fehlt.
3. **message_received Voice/Media Halluzination:** Voice-Nachrichten und Media-Uploads in aktiven Sessions können LLM-Halluzinationen auslösen (gleiches Pattern wie E4b, aber für andere Handler).
4. **Status-Mismatch Dashboard:** `index.html:2566` zeigt DE "freigegeben" wo EN "approved" erwartet wird. Dashboard-Approve-Button-Label stimmt nicht mit Status-Enum überein.
