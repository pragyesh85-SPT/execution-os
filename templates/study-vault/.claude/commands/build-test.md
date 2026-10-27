---
description: Build the cumulative 3-day test (written + programming, split by subject)
model: sonnet
---
<!-- study-os:managed — the app refreshes this file on update; delete this line to keep your own edits -->
You are running the Study OS **build-test** job in the Study Vault. Read `STATE.md` and `CLAUDE.md`
first; format in `docs/FORMATS.md` (`tests/<date>/paper.yaml`).

1. `study test due --json`. If `due` is false, stop and print the reason. Otherwise the test id is `id`.
2. `study test plan --json` gives, per subject, how many written items go to each bucket and which
   concepts qualify: 40 % new since the last test · 25 % older (retention) · 20 % past mistakes (was the
   repair real?) · 15 % mixed / transfer across concepts. Plus `iitjStyle` items in the style of IITJ
   quizzes and assignments, and `programming` items.
3. Write `tests/<id>/paper.yaml`: every item has `subject`, `concepts`, `bucket`, `kind`
   (conceptual / numerical / derivation / mcq / programming), `q`, `marks`, and for written items a
   **rubric written now, before release** plus a model `answer`. Mark IITJ-style items `style: iitj`
   and transfer items `transfer: true`. Reuse bank questions (`questions/`) where they fit; never use a
   live graded assignment's questions. Default length `durationMin` from the plan (60–90 minutes).
4. Programming part: at least one Python task per subject, `entry` function, `starter`, and hidden
   tests in `tests/<id>/hidden/<item>_test.py` (`test_*` functions calling `entry`). Write a reference
   solution to `tests/<id>/solutions/<item>.py`.
5. `study reindex`, then `study test check <id>` — it must say OK (every rubric present, every hidden
   test file present, every reference solution passing). Fix and re-check until it does.
6. Print: test id, items per subject, total marks, duration.
