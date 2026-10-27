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
6. Hub: `/api/study/*` routes, refused with 404 while the flag is off; the vault path lives in hub
   meta (`study.vault`, PC only, never synced) or `EOS_STUDY_VAULT`.
7. `study` CLI (`server/study/cli.ts` → `build/study.cjs`, `npm run study -- …`): `init`, `status`, `next`
   (P0: vault + store wiring; real numbers arrive in P1).
8. Repo `.gitignore`: vault folders, `study.db*`, assets; the template's `.claude/` is re-included.

Tests: flag default and parity, store migrations + backups, vault init idempotency, git-ignore rules,
hub routes off/on, CLI init/status.
