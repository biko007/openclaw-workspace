---
name: daily-briefing-lite
description: Generate a concise daily briefing message for chat delivery. Use when the user asks for a daily briefing, morning update, start-of-day summary, or compact status recap with priorities and next actions.
---

# Daily Briefing Lite

Create a short, human daily briefing that is easy to skim on messaging apps.

## Workflow

1. Determine date/time context (user timezone if known, otherwise UTC).
2. Gather available context from the current conversation and workspace memory.
3. Produce a compact briefing in this order:
   - Greeting + date
   - Top 3 priorities for today
   - Schedule / deadlines (if known)
   - Risks or blockers (if known)
   - Recommended next 3 actions
4. If information is missing, state it briefly instead of inventing facts.

## Output rules

- Keep it short: 8-16 lines total.
- Prefer bullet points over long paragraphs.
- Use clear action language.
- Never fabricate meetings, deadlines, or metrics.
- If almost no context exists, provide a lightweight “planning briefing” with assumptions clearly labeled.

## Default template

Good {morning/afternoon/evening} — {Weekday}, {Month} {D}, {YYYY}.

**Top priorities**
- ...
- ...
- ...

**Schedule / deadlines**
- ...

**Risks / blockers**
- ...

**Next 3 actions**
- ...
- ...
- ...

Close with one encouraging sentence.
