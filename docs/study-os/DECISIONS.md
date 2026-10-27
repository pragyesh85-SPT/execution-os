# Study OS — decisions taken during the build

The build ran unattended. Wherever the architecture left something open, the most reasonable option
was picked and written here. Each entry: the decision, then why. Change any of them by editing the
named file; none of them changes the concept.

## Process

- **D-01 Phase cut.** The architecture's build-plan diagram (P0–P3) did not survive the Markdown export.
  The phases were cut from the document's own sections: P0 foundations, P1 ingestion + learning engine,
  P2 Quick Tutor + labs + 3-day test + headless jobs, P3 surfaces (Study tab, phone, MCP, portfolio).
  *Why:* each phase is testable on its own and the later ones only add surfaces on top of the engine.
- **D-02 Pushing.** The original brief said "never push"; the owner later allowed pushing with version
  control. Only the `feature/study-os` branch and the `pre-study-os` / `study-pN-done` tags are pushed.
  Nothing is merged into `main` and no release is created (the release workflow only fires on `v*` tags).

## Data and storage

- **D-03 Flag default off.** `study` defaults to off, unlike shipped v2 flags. *Why:* "with the flag off,
  Execution OS behaves exactly as today".
- **D-04 `study.db` lives in the vault** (`<vault>/study.db`, git-ignored), with backups in
  `<vault>/.backups/` (14 daily kept, labelled pre-migration copies never pruned). *Why:* the vault is
  the Study store on the PC; keeping the database beside its files makes the vault self-contained.
- **D-05 Vault path and PC-only settings.** Default `C:\StudyOS` on Windows (`~/StudyOS` elsewhere).
  `study init` remembers the path in `study.json` next to the Execution OS database
  (`%APPDATA%\execution-os\study.json`); `EOS_STUDY_VAULT` overrides it. The Quick Tutor provider and its
  key live in the same file. *Why:* PC-only, never synced, never inside the vault's git history, never in
  the repo, and the CLI can write it while the hub is not running.
- **D-06 One synced record.** Execution OS gets a new synced collection `study` that only ever holds
  `study/summary`. Adding a collection needs no hub migration (the loader already ignores unknown
  collections, and older apps skip it), so no Execution OS schema version was bumped. `study.db` has
  its own migration list and pre-migration backups.
- **D-07 YAML.** Vault files are YAML / Markdown with YAML front matter, parsed with `js-yaml` (pinned as
  a dev dependency and bundled into the hub; it was already in the tree). *Why:* Claude writes YAML
  reliably and the owner can read it.

## Learning engine (P1)

- **D-08 Ladder rules.** Each rung needs its own evidence, in any order; a rung is shown only when every
  rung below it has evidence too. Understood = an explanation covering ≥ 80 % of the key points.
  Applied = latest answer to each quick question, at least min(5, pack size) answered, ≥ 80 % right,
  plus the lab when the concept has one. Retained = a correct recall (review graded 2+ or a correct
  test item) at least 3 days after Applied. Exam-ready = a correct timed test item and a correct transfer
  item. Rungs never drop; **readiness** is what decays (FSRS recall), so skipped reviews show there.
- **D-09 The 8 mastery dimensions** (the concept PDF's list was not in v2): exposure, understanding,
  recall, application, implementation, retention, transfer, speed — each 0–1 from evidence, or "no
  evidence yet". Shown per concept; the ladder stays the summary.
- **D-10 FSRS v4.5** with the published default weights. A review card starts when a concept reaches
  Applied (first review ≈ 4 days later) and is replayed from evidence every time, so a re-grade re-plans.
- **D-11 Repair key** = concept + mistake class + detail (e.g. formula id). Two of the same → repair item
  at the top of the queue; it closes when its retest is passed (`repair_done`).
- **D-12 Queue order.** Repairs → due reviews → the 3-day test → concepts: started ones first, then those
  with a resource path, prerequisites first, then the subject with the lowest coverage (weighted by exam
  weight), then syllabus order. From day 2, if the projected ready date is after the target (or there is
  no pace yet), concepts are ordered by exam weight × subject weight × weakness.
- **D-13 Coverage denominator** = every concept card of the semester except merged duplicates — including
  extra concepts Claude splits out of one syllabus topic.
- **D-14 Released** = the card says `released: true`, or a teaching asset (slides, transcript, notes,
  assignment, quiz, practical) of the same or a later week has been ingested for that subject.
- **D-15 Pace and projection.** 3-day average of concepts reaching Applied (shorter in the first days);
  "behind by N" compares with a straight line from studyStart to readyBy; the projected date counts
  from tomorrow.

## Execution OS link (P1)

- **D-16 Start.** In an IIT block → the session runs in it. In another (non-sleep) block with Quick
  Override on → "swap to Study" once (a second Start in the same block does not swap again). Quick
  Override off → the session runs in that block. No block now → a live IIT block from now until the next
  block (max 60 min). During sleep or when nothing fits → a session without a block (it counts as study
  time; there is no block to attach a proof to).
- **D-17 Stop.** Proof status *done* when a concept moved up a rung in the session, otherwise *partial*;
  the note is the session line ("3 concepts, 14 questions 79%, lab passed") and the link is
  `#study/session/<id>`. A session with no activity for 90 minutes is stopped as partial.
- **D-18 Drift** = one Execution OS distraction ("Study OS (no activity)", 10 min) per idle stretch;
  any Study OS activity resets it.
- **D-19 Study minutes.** Sessions started from Study OS or in an IIT block count. A Study OS session in a
  swapped block counts toward study, not the block's category, and a Study OS proof never stands in for
  untimed minutes (sessions are always timed).
- **D-20 Extraction.** Text, Markdown, code, CSV, subtitles (with timestamps), HTML, notebooks, pptx and
  docx (built-in zip reader) are read by the engine. PDFs use `pdftotext` when it is installed and are
  always flagged for Claude, which reads PDFs (text, formulas, figures) natively; images likewise.
  A file whose subject cannot be told from its path goes to `inbox/unsorted/`; an outline file fills an
  empty `syllabus.md`; phone captures (`*-capture.md`) are left in the inbox for Claude.
- **D-21 Submissions** are recorded as evidence (`study deadline submit <id>`) instead of rewriting
  `assessment.yaml`, so your comments in that file survive.
- **D-22 IITJ lectures** are counted from slides / transcript assets grouped by subject, week and
  lecture number; `study iitj lecture <asset>` marks one watched.
- **D-23 Summary churn.** `studySummary.minutesToday` is floored to 5 minutes and the record is rewritten
  only when something in it changed, so phones are not woken every minute.

## Quick Tutor, labs, tests and jobs (P2)

- **D-24 No provider by default → built-in matcher.** Until a provider is set, the tutor still answers:
  numbers and choices are graded exactly, explanations and short answers by the pack's keywords. Those
  verdicts are always *low confidence*, so Claude re-grades every one of them that night. *Why:* the
  learning loop works on day 1 without a key, and Claude still decides what is correct.
- **D-25 The tutor can never pass anything by itself.** Its JSON is validated: ids not in the pack are
  dropped, every key point not covered counts as missed, and the pass (≥ 80 % covered, nothing wrong) is
  computed by the engine. Numbers and multiple choice never go to the model at all.
- **D-26 Provider config** lives in `study.json` on the PC (`study tutor set …` or `/api/study/tutorConfig`
  from the PC only); the key is never returned to any device. Ollama = OpenAI-compatible at
  `http://localhost:11434/v1`. Spend is estimated at 4 characters per token with the prices you set
  (0 for Ollama); at the monthly cap the tutor falls back to the matcher until the next month.
- **D-27 Audit sample** = every low-confidence verdict plus a deterministic ~1 in 5 of the others.
  A re-grade is an overlay on the original evidence (nothing is rewritten), so mastery and reviews follow
  at once; a tutor-labelled mistake is dropped when Claude says the answer was right.
- **D-28 Hints only** while a concept's graded assignment is live: wrong answers get a hint instead of
  the expected answer, missed key points are not spelled out, and the prompt forbids solutions.
- **D-29 Labs and test code run with `python -I`** in a temp folder with a minimal environment and a
  timeout (default 20 s, tests 30 s). Python is found as `STUDY_PYTHON`, `python3`, `python`, `py -3`.
  Your latest lab code is kept as `labs/<id>/my_solution.py` (portfolio link). Claude writes a reference
  `solution.py` and proves the hidden tests are passable (`study lab run`, `study test check`).
- **D-30 Test schedule.** First test on studyStart + 3 days, then 3 days after the previous test was
  taken. Per subject: 5 written items (40/25/20/15 by largest remainder; empty buckets hand their share
  on), 1–2 IITJ-style, 1 programming. An item is "correct" evidence at ≥ 60 % of its marks; every test
  item is timed evidence and transfer items (or the transfer bucket) count as transfer.
- **D-31 Fallback paper.** `study test build --auto` builds a paper from the question bank, packs and
  labs when Claude cannot run; `/build-test` normally writes it. Either way `study test check` must pass.
- **D-32 Splitting a test by subject.** `study test start <id> --subject s` serves that part with a
  proportional time; the test counts as submitted when every subject's part is in.
- **D-33 Job runner.** `study run-job <job>` feeds the command file (front matter stripped) to
  `claude -p` on stdin with `--model <front matter model> --permission-mode acceptEdits`; tool access
  comes from the vault's `.claude/settings.json` (study CLI, file tools, web; `study.db`, backups,
  originals and `git push` denied). Chains: ingest → curate → packs → labs; day-end → curate. A failure
  stops the chain. Grade runs every 30 minutes but only when a test is submitted (instead of the hub
  spawning Claude). Tasks run while you are signed in to Windows.
