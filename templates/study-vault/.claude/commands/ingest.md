---
description: Ingest new IITJ assets and phone captures, decompose them into concept cards
model: sonnet
---
<!-- study-os:managed — the app refreshes this file on update; delete this line to keep your own edits -->
You are running the Study OS **ingest** job in the Study Vault (current folder). Read `STATE.md` and
`CLAUDE.md` first. File formats: `docs/FORMATS.md`. Use `study` (`study.cmd` on Windows) for every
engine call. Never touch `study.db`. Safe to re-run: change only what is missing or wrong.

1. `study pending --json`. If `total` is 0, stop here and print "nothing to ingest".
2. Inbox files that are not captures: `study ingest inbox --move`. For each file left in
   `inbox/unsorted/`, decide its subject from its content and run
   `study ingest inbox/unsorted/<file> --subject <id> [--week N] [--type T] --move`.
3. Phone captures (`inbox/*-capture.md`): turn each into what it is (a question for the bank, a note on a
   concept card, a link to curate) and move it to `inbox/done/`.
4. For every asset with status `new` (`study assets --status new --json`):
   a. Read `extracted/<asset>.md`. When it says `needsClaude: true`, read the original in `assets/`
      (PDF, image, slides with figures) and complete the extracted file: text with page / slide
      references, every formula as LaTeX, code blocks. Keep the front matter.
   b. Decompose into concepts: one concept = one idea testable by one question, 20–40 minutes.
      Prefer filling an existing stub (`concepts/<id>.md`, `status: stub`) over creating a new card.
      Set `status: ready`, `released: true`, `week`, `minutes`, `examWeight` (1 default; higher when
      IITJ stresses it), `definition`, `formulas`, `sources` (asset id + slide / page), `notation` (IITJ
      symbols as used in the asset).
   c. Link: merge duplicates (`mergedInto`, never delete a card), then `prereqs`, `testedBy`,
      `confusedWith`.
   d. Quizzes, assignments, PYQs: add their questions to `questions/<asset>.yaml` with rubric and marks,
      `source: official|pyq`, `style: iitj`. Assignments with a due date: add them to `deadlines` in
      `assessment.yaml` (`graded: true` while live) and mark every concept they cover with `graded: <id>`.
      **Never write solutions for a live graded assignment.**
   e. `study asset-done <asset>`.
5. A syllabus or course outline arriving as an asset: complete `syllabus.md` for that subject (all weeks,
   released and upcoming), keeping existing topic ids.
6. `study reindex` — fix every file it reports as not parsing. Then print a short summary: assets
   processed, concepts created / filled / merged, questions added.
