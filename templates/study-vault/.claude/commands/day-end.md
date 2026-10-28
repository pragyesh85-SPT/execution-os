---
description: Nightly synthesis — audit the Quick Tutor, refresh the queue context, keep resources ahead
model: sonnet
---
<!-- study-os:managed — the app refreshes this file on update; delete this line to keep your own edits -->
You are running the Study OS **day-end** job (nightly, 1:00) in the Study Vault. Read `STATE.md` and
`CLAUDE.md` first. Never touch `study.db`; every correction goes through `study`.

1. **Quick Tutor audit.** `study tutor audit --json` lists every low-confidence verdict and a sample of
   the rest, each with the raw answer and the pack. Re-grade each one against its pack:
   - you agree → `study tutor regrade <id> '{"agree":true}'`
   - explanation → `study tutor regrade <id> '{"coverage":0.6,"pass":false,"note":"…"}'`
   - quick question → `study tutor regrade <id> '{"correct":true,"note":"…"}'`
   Add `"mistakes":[{"cls":"…","detail":"…"}]` when you see a mistake the tutor missed.
   When you disagree, improve the pack so the tutor gets it right next time (better keywords, clearer
   answer, an extra misconception).
2. **Mastery and reviews** are recomputed by the hub from evidence — do not edit them. Read
   `study progress --json` and `study next --json`.
3. **Repairs.** For every open repair (STATE.md), make sure the concept's path has a strongly visual
   segment first (intuition) and that its pack has a question that retests the exact mistake.
4. **Stay ahead.** Concepts in the next 3 days without a path, pack or lab are handled by the `/curate`
   step that runs right after this one; note any concept you could not find a good resource for.
5. `study state` (rewrites STATE.md) and print a 5-line day summary: minutes studied, concepts moved,
   checks passed / missed, repairs open, pace.
