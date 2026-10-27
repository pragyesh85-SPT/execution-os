---
description: Grade the written part of a submitted 3-day test against its rubric and write the report
model: sonnet
---
You are running the Study OS **grade** job in the Study Vault. Read `STATE.md` and `CLAUDE.md` first;
format in `docs/FORMATS.md` (`tests/<date>/grading.yaml`).

For each test in `study test list --json` with status `submitted`:

1. Read `tests/<id>/paper.yaml` (items, rubrics, model answers) and every file in
   `tests/<id>/submissions/` — typed answers (`.md`), photos of paper answers (`.png` / `.jpg`; read the
   handwriting carefully), code (`.py`, already scored by the hidden tests; review method and clarity).
2. Grade every written item strictly by its rubric (the rubric was fixed before the test was released —
   never change it). Partial marks per rubric point. Short, specific `feedback`. For every lost mark,
   a `mistakes` entry: `concept`, `cls` (concept_gap, formula_recall, wrong_method, calculation,
   notation, misread, incomplete, confusion) and a `detail` (the formula or idea), so repeated mistakes
   become repair items.
3. `reviewNotes`: one line per programming item on method and clarity.
4. Write `tests/<id>/grading.yaml`, then `study test finalize <id>` — it records the evidence, moves the
   concepts, adds repair items and writes `tests/<id>/report.md`.
5. Print the score per subject and the three most important things to repair.
