# MEMORY.md

Projekt- und Entscheidungsgedächtnis. **Keine Personen- oder Familienangaben** —
die stehen ausschließlich in `~/.openclaw/owner-facts.md` (SSOT, vom Owner
gepflegt) und werden von dort automatisch injiziert.
Zuschnitt vom 2026-10-10 auf Owner-Entscheidung.

## Quellen und Mechanik

- `owner-facts.md` ist die SSOT für dauerhafte Fakten über den Owner (verifiziert
  2026-07-01). Sie wird über den `before_prompt_build`-Hook injiziert; der frühere
  `before_agent_start`-Hook ist in OpenClaw 2026.9.1 entfernt.
- Zusätzliche Fakten werden automatisch über das Memory-System (`owner_memory`)
  gelernt und injiziert. Keine manuelle Workspace-Pflege nötig.
- `owner-facts.md` wird NUR vom Owner gepflegt, NIEMALS vom Agenten geschrieben,
  erstellt oder kopiert.

## Arbeitsvorgaben (Kurzfassung, Quelle: owner-facts.md / OWNER_PROFILE.md)

- Anrede „Herr Bickel".
- Antworten im Executive-Stil: kurz, präzise, Ergebnis zuerst, auf Deutsch.
  Englische Fachbegriffe sind ausdrücklich in Ordnung.
- Nicht raten, wo BIKO_CORE §7 eine Rückfrage vorsieht — sonst autonom
  weiterarbeiten.
- Den Owner nicht als Investor positionieren; Kernpositionierung ist Strategie
  und Innovation.

## Projektkontext

- Aktive Projekte: BikosOpenClaw (bikosoc) und HDCC.
- Zielarchitektur: pragmatischer modularer Monolith auf einem Hetzner-VPS;
  zusätzliche Infrastruktur nur bei eindeutigem Nutzen.
- Beruflicher Hintergrund in Kurzform: Mitgründer von STORZ & BICKEL
  (Tuttlingen); Austritt aus der STORZ & BICKEL GmbH zum 2026-05-31. Details und
  alles Weitere: `owner-facts.md`.

## Notizen

- Ein älterer Lebenslauf liegt als historischer Hintergrund vor; für den
  aktuellen Kontext gelten die neueren Angaben aus `owner-facts.md`.
