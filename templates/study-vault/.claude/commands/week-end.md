---
description: Sunday — week synthesis, graph cleanup, portfolio update, pace re-plan
model: sonnet
---
<!-- study-os:managed — the app refreshes this file on update; delete this line to keep your own edits -->
You are running the Study OS **week-end** job (Sunday night) in the Study Vault. Read `STATE.md` and
`CLAUDE.md` first.

1. **Graph cleanup.** `study dedupe --json` lists likely duplicate concepts and broken links
   (prerequisites that do not exist, cycles). Merge real duplicates (`mergedInto` on the weaker card —
   never delete a card with evidence), fix or remove broken links, split any card that holds two ideas.
2. **Week synthesis.** From `study progress --json`, the last test report and STATE.md, write
   `sessions/week-<YYYY-MM-DD>.md`: hours, concepts moved per subject, test results, mistake classes,
   what worked (sources that led to passes), what did not.
3. **Pace re-plan.** If the projected ready date is after the target, say so plainly and list what the
   queue now prioritises (it orders the rest by exam weight × weakness automatically). Suggest at most
   one change to the daily study time for Execution OS.
4. **Portfolio.** `study portfolio` regenerates `portfolio/` from evidence (world-university sources
   only — IITJ material never appears there). Read `portfolio/index.md` and fix nothing by hand.
5. `study state`, then print the week summary in 8 lines.
