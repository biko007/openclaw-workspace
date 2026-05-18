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
