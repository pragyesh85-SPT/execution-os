# Study OS — build plan

The architecture (`ARCHITECTURE.md`) is the source of truth. Its "Build plan" diagram did not survive
the export, so the four phases below are cut from the architecture's own sections (see DECISIONS.md, D-01).
Every phase ships behind the `study` flag (Settings → Labs), with tags `study-pN-done` after it.

| Phase | Theme | Ships |
| --- | --- | --- |
| P0 | Foundations | flag, Execution OS type changes, `study.db` with migrations + backups, vault template, `study init`, hub `/api/study` skeleton, `study` CLI skeleton, git-ignore safety |
| P1 | Ingestion and the learning engine | ingest (classify, extract, syllabus skeleton), vault indexer, evidence, status ladder, mastery, repair rule, FSRS reviews, queue / next, progress and pace, Start/Stop inside Execution OS, `studySummary`, IITJ deadlines as tasks, `STATE.md` |
| P2 | Quick Tutor, labs and the 3-day test | pluggable tutor (ai.ts providers + mock), verdict log and nightly audit, Python labs with hidden tests, 3-day test plan / build / take / grade / report, headless job command files, runner and `study:schedule` |
| P3 | Surfaces | Study tab (home, player, check, lab, test), Today Study card, offline pack + answer queue, MCP study tools, study proposals with undo, portfolio, week-end graph cleanup |

---

## P0 — Foundations

Goal: the module exists, is switched off by default, and changes nothing in Execution OS while off.

1. `study` feature flag (default **off**) in `src/core/features.ts`; Labs shows it automatically.
2. Execution OS types: `Session.source: 'study'`, `Session.studySessionId`, `Session.label`;
   `Proof.loggedVia: 'study'`; new synced collection `study` holding only the `summary` record.
3. `server/study/store.ts`: `StudyDb` over `<vault>/study.db` — its own numbered migrations
   (reusing `runMigrations`), a labelled pre-migration backup, daily backups kept 14 days.
4. `templates/study-vault/`: `CLAUDE.md`, `STATE.md`, `.claude/commands/*`, `semesters/s1/assessment.yaml`,
   vault `.gitignore` (assets, `study.db`, backups, logs never committed).
5. `server/study/vault.ts`: `initVault(path)` copies the template, creates the folder layout, `git init`
   (when git exists), a pre-push hook that refuses pushes, and the `study` shims.
6. Hub: `/api/study/*` routes, refused with 404 while the flag is off; the vault path lives in
   `study.json` next to the Execution OS database (PC only, never synced) or `EOS_STUDY_VAULT`.
7. `study` CLI (`server/study/cli.ts` → `build/study.cjs`, `npm run study -- …`): `init`, `status`, `next`
   (P0: vault + store wiring; real numbers arrive in P1).
8. Repo `.gitignore`: vault folders, `study.db*`, assets; the template's `.claude/` is re-included.

Tests: flag default and parity, store migrations + backups, vault init idempotency, git-ignore rules,
hub routes off/on, CLI init/status.

---

## P1 — Ingestion and the learning engine

Goal: point the system at a folder of assets and get a real queue, real numbers and Execution OS sessions.

1. Pure engine (`src/core/study/`): syllabus parser, asset classifier, FSRS scheduler, status ladder
   and the 8 mastery dimensions from evidence, the repair rule, the queue, progress / pace / readiness.
2. `server/study/extract.ts`: text from md/txt/tex/py/csv/json, srt/vtt (timed), html, ipynb, pptx and
   docx (built-in zip reader), pdf through `pdftotext` when installed; everything else is flagged for Claude.
3. `server/study/ingest.ts`: hash-dedupe → classify (subject, week, type) → copy into `assets/` →
   `extracted/<asset>.md` → syllabus outline → concept stubs → index. Unknown subject → `inbox/unsorted/`.
4. `server/study/indexer.ts` + parsers: every vault file → `study.db` items; parse errors listed, never fatal;
   the hub re-indexes on file changes (debounced watcher).
5. `server/study/eos.ts`: Start inside an IIT block, or Quick Override swap, or a live block, or a
   block-less session; Stop fills the Proof (`loggedVia: 'study'`); 10 idle minutes mark drift;
   `studySummary` kept current; IITJ deadlines become `iit` tasks.
6. Service + API + CLI: `ingest`, `pending`, `concepts`, `concept`, `log`, `start`, `stop`, `progress`,
   `deadline submit`, `iitj lecture`, `state` (writes `STATE.md`), `assets`, `reindex`.
7. Synthetic sample subject in `tests/fixtures/study-sample/` (slides as md + pptx + docx, transcript,
   quiz, syllabus, plus the files Claude would write) and an end-to-end ingest test.

---

## P2 — Quick Tutor, labs, the 3-day test and headless jobs

Goal: instant checks graded only against Claude's packs, labs and tests graded by hidden tests on this PC,
and every heavy job runnable by Task Scheduler (registered by the owner, not by the build).

1. `src/core/study/tutor.ts` (pure): the pack-grounded prompts, strict verdict validation (ids must come
   from the pack — nothing invented), deterministic grading of numeric / mcq answers, and a keyword
   matcher used when no provider is set (always low confidence → re-graded by Claude that night).
2. `server/study/tutor.ts`: providers from `src/lib/ai.ts` (Claude API, OpenAI, Gemini, OpenAI-compatible,
   Ollama on this PC), none by default; monthly spend cap; verdict log with the raw answer; nightly audit
   list (all low-confidence + a sample) and `regrade`, which corrects mastery through the evidence overlay.
3. `server/study/labs.ts`: run submitted Python against hidden tests (`python -I`, temp folder, timeout).
4. `server/study/exam.ts`: test due date, blueprint (40 / 25 / 20 / 15 per subject + IITJ-style items),
   fallback paper builder from the bank, start (timed Execution OS focus session), submit per subject
   (programming graded at once), finalize from Claude's `grading.yaml`, report (`report.md`).
4. Vault template: `.claude/commands/` for ingest, curate, packs, labs, day-end, build-test, grade,
   week-end (model sonnet) and study-now (interactive); `.claude/settings.json` permissions.
5. `study run-job <job>`: gate (only when there is work), `claude -p` per command, log file, job row,
   `STATE.md`, vault commit. `npm run study:schedule` registers the Windows tasks (`--dry-run` prints them).
