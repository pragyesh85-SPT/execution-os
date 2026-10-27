# Study Vault — rules for Claude Code

You are working inside the owner's private Study Vault (Study OS, part of Execution OS). Read
`STATE.md` first, every session, interactive or headless. Open other files only as you need them.

## What this folder is

- IITJ assets (`semesters/*/subjects/*/assets/`) decide **what** must be learned and the coverage %.
- Learning happens from world-class **open** resources (MIT, Harvard, Stanford, 3Blue1Brown …) that you
  map to each concept, segment by segment.
- The hub (Execution OS on this PC) owns `study.db`. **Never open, edit or delete `study.db`** or anything
  in `.backups/`. You write vault files; the hub indexes them. Every event (attempt, score, mistake,
  regrade) goes through the `study` CLI (`study.cmd` on Windows, `./study` elsewhere).
- File formats: `docs/FORMATS.md`. Follow them exactly; a file that does not parse is skipped.

## Hard rules

1. Never edit or rename anything in `assets/` (originals). Write extracted text to `extracted/`.
2. Never move mastery yourself. Mastery is computed by the hub from evidence events.
3. The Quick Tutor only compares against check packs. Packs are yours: 5–8 key points,
   misconceptions, 5–10 quick questions with answers + rubric, formulas, 2 retry hints.
4. Academic integrity: a concept with `graded: <deadline>` belongs to a live graded assignment. Give
   hints only, never solutions or worked answers to that assignment, until `study deadline submit <id>`.
5. Fetch and check every link before saving it in a path (`checkedAt` = today). Prefer the shortest
   segment that teaches the concept at IITJ depth; record the notation map on the concept card.
6. Never put IITJ material into `portfolio/`. Never push this repository (a hook blocks it).
7. Never write API keys, passwords or tokens into any file here.
8. Every job must be safe to re-run: check what already exists, change only what is missing or wrong.
9. Rubrics for a test are written before the test is released and never changed after it.

## Useful commands

```text
study status                 what the vault contains, parse errors, last jobs
study next                   the queue: repairs, reviews, tests, next concepts
study pending                new files waiting in inbox/ or assets/
study ingest <folder>        copy, classify and extract new assets (engine part of /ingest)
study concepts [subject]     concept list with ladder status
study log <kind> <concept> '<json>'     record evidence (explain, quick, review, mistake, …)
study tutor audit            Quick Tutor verdicts to re-grade tonight
study tutor regrade <id> '<json>'       your verdict replaces the tutor's
study test plan              blueprint for the next 3-day test (40/25/20/15 mix)
study test finalize <date>   after grading.yaml is written
study state                  regenerate STATE.md from the data
study portfolio              regenerate the portfolio
study commit "<message>"     commit the vault (every headless run ends with this)
```

## Jobs (`.claude/commands/`)

`/ingest` → `/curate` → `/packs` → `/labs` run every 2 hours when new files arrive; `/day-end` nightly at
1:00; `/build-test` every 3rd day at 5:00; `/grade` when a test is submitted; `/week-end` on Sunday night.
`/study-now` is the interactive tutor for the terminal (queue, quick checks, tests by hand).
