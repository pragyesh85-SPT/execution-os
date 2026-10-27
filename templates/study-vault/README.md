# Study Vault

Your private Study OS folder. It stays on this PC: the git history here is local only (pushing is
blocked by a hook) and `.gitignore` keeps the database, backups, logs and the raw IITJ originals out
of even the local history.

| Folder / file | What it holds | Written by |
| --- | --- | --- |
| `STATE.md` | one-page brief every Claude session reads first | `study state` |
| `CLAUDE.md` | rules for Claude Code in this folder | you |
| `.claude/commands/` | one file per headless job | you |
| `semesters/s1/assessment.yaml` | exam dates, subjects, weights, deadlines | you / Claude |
| `semesters/s1/subjects/<subject>/syllabus.md` | the full course outline | you |
| `…/assets/` | IITJ originals, never edited | `study ingest` |
| `…/extracted/` | text, formulas, code from each asset | `study ingest` + `/ingest` |
| `…/concepts/` `paths/` `packs/` `labs/` `questions/` | the learning graph | Claude |
| `tests/<date>/` | 3-day test paper, submissions, grading, report | Claude + the hub |
| `inbox/` | captures from the phone | the hub |
| `portfolio/` | what you learned from world universities | `study portfolio` |
| `study.db` | evidence, attempts, verdicts (git-ignored) | the hub only |

Formats: `docs/FORMATS.md`.
