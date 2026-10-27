# Study OS — build report

Built overnight, Oct 27–28 2026, on branch `feature/study-os` (from `main` at `b9efe68`, tag `pre-study-os`).
Nothing was merged into `main` and no release was created. The concept in `ARCHITECTURE.md` was followed
as written; every gap the document left open is listed in `DECISIONS.md` (D-01 … D-39).

## What was built, per phase

| Phase | Commit | Tag | What it added |
| --- | --- | --- | --- |
| P0 Foundations | `5d3e7af` | `study-p0-done` | `study` flag (off by default), Execution OS type changes (`Session.source/studySessionId/label`, `Proof.loggedVia: 'study'`, synced `study/summary`), `study.db` with its own migrations + pre-migration and daily backups, the vault template, `study init`, hub `/api/study/*` (404 while off), `study` CLI, `.gitignore` safety rules |
| P1 Ingestion + learning engine | `e310dd7` | `study-p1-done` | syllabus skeleton → concept stubs, asset classification and extraction (text, subtitles, html, ipynb, pptx, docx, pdf via pdftotext), hash-deduplicated ingest, vault indexer + watcher, status ladder, 8 mastery dimensions, FSRS reviews, repair rule, queue, coverage / readiness / pace / projected date, Start / Stop inside Execution OS (IIT block, swap, live block, block-less), proof fill, drift, `studySummary`, IITJ deadlines → `iit` tasks, `STATE.md` |
| P2 Tutor, labs, test, jobs | `b633933` | `study-p2-done` | pack-grounded Quick Tutor (providers from `src/lib/ai.ts`, none by default, mock in tests, cap, audit + re-grade), hints-only for live graded work, Python labs with hidden tests, the 3-day test (blueprint 40/25/20/15, fallback builder, check, timed start, per-subject submit, programming graded at once, finalize from `grading.yaml`, report), 8 job command files on Sonnet + `study-now`, `study run-job`, `npm run study:schedule` |
| P3 Surfaces | `e6fceed` | `study-p3-done` | Study tab (next up with embedded player, explain incl. speech, quick check, lab, reviews, repairs, test taking with photo answers, subject bars, IITJ track, proposals + undo, capture, concept list), Today Study card, offline pack + answer queue, 7 MCP study tools, study proposals with audit/undo, portfolio (md / html / json), graph report |

Main files: `server/study/*` (hub module, CLI, store, ingest, indexer, tutor, labs, exam, jobs, MCP,
portfolio), `src/core/study/*` (pure engine), `src/screens/Study.tsx`, `templates/study-vault/`,
`scripts/study-schedule.mjs`, `tests/study-*.test.ts`, `tests/fixtures/study-sample/` (synthetic only).

## Test results

`npm test` and `npm run typecheck` after every phase (Windows, Node 24, Python 3):

| After | Test files | Tests | Typecheck |
| --- | --- | --- | --- |
| baseline (`main`) | 16 | 160 | clean |
| P0 | 17 | 176 | clean |
| P1 | 19 | 203 | clean |
| P2 | 20 | 225 | clean |
| P3 | 21 | 235 | clean |

No existing test was skipped, deleted or weakened. `npm run build` (web + hub + CLI bundle) passes.
Lab / test-runner tests run real Python; the job-runner test uses a fake `claude` binary. The Study tab
was also checked in the real app: the built hub on a temporary database and temporary vault (port 47901,
never `%APPDATA%`), driven in headless Edge — watch → explain → Understood, with zero console errors.

## Decisions taken on my own

All 39 are in `DECISIONS.md` with the reason for each. The ones you are most likely to want to change:

- **D-01** the P0–P3 cut (the build-plan diagram did not export).
- **D-05** vault path and tutor key in `%APPDATA%\execution-os\study.json` (PC only, never synced).
- **D-08 / D-09** exact ladder thresholds and the 8 mastery dimensions.
- **D-12** queue order; **D-15** pace maths; **D-30** test schedule and "correct = 60 % of marks".
- **D-16 / D-17** how Start picks a block and when a proof is *done* vs *partial*.
- **D-24** without a provider the tutor uses a keyword matcher (always re-graded by Claude at night).
- **D-33** headless runs use `--permission-mode acceptEdits` plus the vault's `.claude/settings.json`.
- **D-36** on phones Study replaces Calendar in the bottom bar (Calendar moves to More).

## Known gaps

1. **The installed app does not have Study OS yet.** `E:\Execution OS` (v2.0.0 EXE) and the phone APK were
   not rebuilt — no release was made. Until you merge and release, run the hub from this repo (steps below);
   phones use the Study tab through the browser at the PC address.
2. The `study` CLI runs from the repo checkout (`build/study.cjs`); it is not bundled into the EXE.
3. PDFs: the engine extracts text only when `pdftotext` (Poppler) is installed; otherwise every PDF is
   flagged and Claude reads it during `/ingest` (Claude Code reads PDFs natively). Scans and images always
   need Claude.
4. The job command files were exercised with a fake `claude`, not with real Claude runs — the first real
   `/ingest` should be watched once (step 8 below).
5. Tutor provider settings are CLI-only (`study tutor set …`); there is no settings form in the Study tab.
6. Task Scheduler runs jobs only while you are signed in to Windows and the PC is on (no stored password).
7. The concept graph in the Study tab is a list of chips per subject, not a drawn graph.
8. Offline answers are checked when they reach the PC, so their evidence carries the sync time.
9. Speech input needs a browser with speech recognition (Chrome / Edge); the Android WebView may not offer it.
10. React components have no unit tests (the repo has no DOM test setup); they were verified in the built app.
11. The test timer is shown, not enforced; the Execution OS focus session records the real time.

## Tomorrow morning, step by step (PowerShell, in the repo folder)

1. **Get the build.** Quit Execution OS (tray icon → Quit). Then:
   ```powershell
   git checkout feature/study-os
   npm install
   npm run build
   ```
2. **Start the hub from this build** (same database as the app, `%APPDATA%\execution-os`, nothing is migrated):
   `npm run serve` — or double-click `Start Execution OS (web).bat`. Leave it running.
   Open http://localhost:4747 → Settings → Labs → switch on **Study OS**.
3. **Create the vault:** `npm run study -- init C:\StudyOS` (any folder outside the repo works; it
   creates `C:\StudyOS\study.cmd`, a local git repo with a push-blocking hook, and remembers the path).
4. **Fill in the semester** in `C:\StudyOS\semesters\s1\assessment.yaml`: exam start, subjects (ids,
   titles, exam weights), IITJ deadlines (`graded: true` while live), end-term format. The four subjects are
   already there with equal weights.
5. **Paste each subject's full outline** into `C:\StudyOS\semesters\s1\subjects\<subject>\syllabus.md`
   (`## Week N: title` + one bullet per topic). An outline file in the asset folder also fills it.
6. **Put the assets in place and ingest:**
   ```powershell
   npm run study -- ingest "D:\path\to\IITJ assets"
   ```
   Folders named after the subjects are filed automatically; otherwise run one ingest per subject with
   `--subject lana` (or `fsp`, `ata`, `bda`). Anything unclear lands in `C:\StudyOS\inbox\unsorted\`.
   Then `npm run study -- status` and `npm run study -- concepts`.
7. **Set the Quick Tutor provider** (optional — without one the built-in matcher works and Claude re-grades):
   ```powershell
   npm run study -- tutor set ollama llama3.2                                  # free, local (install Ollama first)
   npm run study -- tutor set anthropic claude-haiku-4-5 --key sk-ant-... --cap 5 --price-in 1 --price-out 5
   npm run study -- tutor status
   ```
8. **Run the first ingest with Claude once, watching it:** `cd C:\StudyOS`, then `claude` and type
   `/ingest` (then `/curate`, `/packs`, `/labs`) — or headless: `C:\StudyOS\study.cmd run-job ingest --force`.
   Afterwards `study next` shows the queue and the Study tab shows the next video.
9. **Register the scheduled jobs:**
   ```powershell
   npm run study:schedule -- --vault C:\StudyOS --dry-run   # look at the five tasks
   npm run study:schedule -- --vault C:\StudyOS             # register them (remove later with --remove)
   ```
   Ingest every 2 h (only when there is something new), day-end 01:00, build-test every 3rd day 05:00
   (only when due), grade every 30 min (only after a submission), week-end Sunday 22:00.
10. **Study.** Open the Study tab (PC, or the phone browser at the PC address); press Start — Execution OS
    shows "Studying: … (Study OS)" and Focus Guard turns on. Until you are comfortable, `/study-now` in
    Claude Code serves the same queue in the terminal.

## Inputs I still need from you

1. **Full syllabus / course outline** for all four subjects (Linear Algebra and Numerical Analysis,
   Foundations of Statistics and Probability, Algorithmic Thinking and its Applications, Basics of Data
   Analytics) — released and upcoming weeks.
2. **Exam weights per subject and the end-term format** (written / MCQ / programming, duration, marks)
   and the graded components with their dates.
3. **Quick Tutor provider:** a hosted small model (which one, with a monthly cap) or local Ollama.
4. **Vault location** (default `C:\StudyOS`).
5. **Portfolio and labs repo:** public or private (nothing is published until you decide).
