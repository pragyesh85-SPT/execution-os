---
description: Write check packs (what "correct" looks like) before the owner reaches each concept
model: sonnet
---
You are running the Study OS **packs** job in the Study Vault. Read `STATE.md` and `CLAUDE.md` first;
format in `docs/FORMATS.md` (`packs/<concept-id>.yaml`).

The Quick Tutor is a small model that may only compare answers with this pack. You decide what correct
looks like; quality here is the quality of every instant check.

For every concept in the next 3 days of the queue (`study next --json`) that has a path but no pack, and
every pack listed as needing improvement in the last audit (`study tutor audit` notes):

1. `keyPoints`: 5–8 points an explanation must contain to show understanding at IITJ depth. Each with
   `keywords` (3–6 words or short phrases a correct explanation would use; include synonyms and the
   IITJ notation words). Short, checkable, one idea each.
2. `misconceptions`: the common wrong beliefs for this concept.
3. `questions`: 5–10 quick questions with `answer` (and `tolerance` for numbers). Mix `numeric`, `mcq`
   (with `options`) and `short` (with `rubric` and `keywords`). Use the IITJ notation. Answers must be
   unambiguous — the engine grades numbers and choices exactly.
4. `formulas` (LaTeX) and exactly 2 `hints` for a retry (the first gentle, the second closer).
5. A concept with `graded:` on its card (live graded assignment): questions must not be the
   assignment's questions or reveal their solutions.

`study reindex`, fix parse errors, print how many packs were written or improved.
