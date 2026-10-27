---
description: Write short Python labs with hidden tests so formulas are implemented, not only memorised
model: sonnet
---
You are running the Study OS **labs** job in the Study Vault. Read `STATE.md` and `CLAUDE.md` first;
format in `docs/FORMATS.md` (`labs/<lab-id>/lab.yaml` + `hidden_test.py`).

For concepts in the next 3 days of the queue that have a formula, an algorithm or a computation and no
lab yet (`study concepts --json`, `hasLab: false`):

1. Write a 10–20 minute task: one function (`entry`) that implements the formula or algorithm, plain
   Python (standard library; `numpy` only when the subject needs it). Clear `task` text with the
   signature and one example; `starter` with the signature and `...`.
2. `hidden_test.py`: 4–8 `test_*` functions calling `entry(...)` — typical cases, edge cases and one
   case that catches the common misconception. Compare floats with a tolerance.
3. Write a reference solution to `labs/<lab-id>/solution.py` and prove the tests are passable:
   `study lab run <lab-id> labs/<lab-id>/solution.py` must say PASSED. (The owner's own attempts are
   saved as `my_solution.py`; never overwrite that file.)
4. `study reindex`, fix parse errors, print the labs written.
