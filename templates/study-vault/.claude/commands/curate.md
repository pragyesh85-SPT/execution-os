---
description: Map concepts to the best open resource segments, 3 days ahead of the queue
model: sonnet
---
<!-- study-os:managed — the app refreshes this file on update; delete this line to keep your own edits -->
You are running the Study OS **curate** job in the Study Vault. Read `STATE.md` and `CLAUDE.md` first;
formats in `docs/FORMATS.md`. You may use web search and fetch.

Goal: every concept in the next 3 days of the queue has a checked resource path. IITJ assets define the
scope; learning happens from world-class open resources.

1. `study next --json` and `study concepts --json`. Work list: concepts in the first ~3 days of the
   queue (about 12 per subject at 4/day) without `paths/<id>.yaml`, plus every path with a dead or
   unchecked link (`checkedAt` older than 14 days).
2. For each concept, read its card (definition, formulas, notation, IITJ sources) and choose a path of
   1–3 segments: **visual intuition first**, then the formal explanation or derivation where the exam
   needs it, then a worked example. Add 1–2 `alternates` (used after a missed check).
3. Ranking: covers this exact concept at IITJ depth → visual richness (animation, interactive) →
   shortest segment that teaches it → notation close to IITJ → the owner's results with that source
   (see weak concepts and missed checks in STATE.md).
   Starting candidates (verify each): 3Blue1Brown Essence of Linear Algebra, MIT 18.06 (Strang), MIT OCW
   numerical methods · Harvard Stat 110, Stanford CS109, Seeing Theory (Brown), MIT 18.05, StatQuest ·
   MIT 6.006, Harvard CS50, VisuAlgo · Python Data Science Handbook, Kaggle Learn, StatQuest.
4. **Fetch every URL before saving it.** Videos: **you cannot watch them — never estimate or invent a time.**
   For every YouTube candidate run `study transcript <url> --text`. Choose `start` and `end` ONLY from a
   `[m:ss]` transcript line or a chapter in that output: start = the line where the explanation of this
   concept begins, end = the line where it is finished. If the video has no transcript and no chapters,
   leave `start` / `end` out (the whole video) and add `timestampVerified: false`. Prefer a video whose
   transcript lets you cut the exact part. Other videos (no transcript tool): whole video + `timestampVerified: false`.
   Text resources: `pages` or the section. Fill `source`, `university` (for the portfolio), `course`,
   `lecture`, one line `why` (quote the transcript line you started on), `checkedAt` today.
5. Put the notation map on the concept card (`notation`: IITJ symbol beside the resource's symbol).
6. Dead links: mark `dead: true` and replace the segment the same night.
7. `study reindex`, fix parse errors, print what was curated.
