# Study OS — Architecture v2

Oct 27, 2026 · @Pragyesh Jain

## What changed and why

The concept is unchanged. The corrections below fit it to how you actually study, to Execution OS as built, and to the Nov 30 exam.

| Area | Concept PDF / first review | Architecture v2 | Why |
| --- | --- | --- | --- |
| When study happens | Execution OS block decides | Study OS is independent. Pressing Start anywhere makes Execution OS show "Studying now", turn on Focus Guard and log the session | You study whenever you choose; Execution OS records it and never gates it |
| Instant check after a video | Fast model (first review said drop it) | Kept as the Quick Tutor: a small fast model that only grades against check packs Claude wrote in advance | Instant feedback without the terminal; Claude still sets the quality |
| Heavy thinking | Claude through chat or MCP | Claude Code in the terminal plus scheduled headless Sonnet runs on your PC | Runs on your subscription, no API cost |
| Where learning comes from | IITJ plus external | IITJ assets define scope and the coverage %. Learning happens from world-class open resources | Degree scope, global-quality teaching |
| Tests | Adaptive, every few days or weekly | Every 3 days, cumulative, split by subject, written plus programming | Your rule |
| Mistakes | Failure map | Same mistake twice on a formula or concept puts a repair item at the top of the queue | Your rule |
| Mastery | 8 dimensions as percentages | Same dimensions, moved only by evidence; % computed from evidence | No fake precision |
| Pace | Exam Sprint near the exam | Ready date = exam start minus 15 days (Nov 15); pace measured from day 1 | Your target |
| Data | One vault | Separate Study store on the PC; only a small summary syncs into Execution OS | Execution OS copies its whole doc to every phone |
| Workspace | Native study surface | Kept: a Study tab in the Execution OS app with embedded video segments | "Open it, see the next video" |
| Portfolio | Not in PDF | Added | Record of everything learned from world universities |

## System map

&#91;embedded content: System map · 8 parts, hub at the centre\]

The Study tab, the Quick Tutor and Claude mobile talk only to the hub. Claude Code writes vault files and logs events through the `study` CLI, which calls the same hub API.

## Study OS and Execution OS

Study OS never waits for an Execution OS block; it pushes what you are doing into Execution OS. Execution OS still plans how much of the day goes to study, and anything started in Study OS counts toward it, inside or outside a planned block.

**Start studying (any time, phone or PC)**

- Inside an IIT study block: the session starts in that block.
- Outside one: Study OS applies the existing Quick Override ("swap to Study") on the current block, or adds a live block from now if the day has none.
- Execution OS shows "Studying: \<concept> (Study OS)", the timer runs and Focus Guard turns on.

**Stop**

- The Execution OS session ends and its Proof fills itself: done or partial, plus a note such as "3 concepts, 14 questions 79%, lab passed" and a link to the session report.
- No activity in Study OS for 10 minutes during a live session marks drift in Execution OS.

**Daily link**

- One small synced record, `studySummary`: minutes today, pace status, next item, tests due, projected ready date. The Execution OS Today screen shows it as a Study card, offline too.
- IITJ assignment and quiz deadlines become Execution OS tasks (area `iit`) with their due dates.

**Changes to Execution OS code**

- Sessions may start without a scheduled block; new fields `source: 'study'` and `studySessionId`.
- Proof gets `loggedVia: 'study'`.
- New `study` feature flag under Settings → Labs, so the whole module can be switched off without deleting anything.

## The Study Vault

Study OS keeps its own store on the PC, outside the Execution OS sync doc: Claude works on plain files, the hub owns one database. The hub runs it as a new module (`server/study/`) inside the existing Execution OS hub, reusing its auth, pairing, Tailscale and MCP gateway.

```text
StudyOS/                        private git repo on the PC
  CLAUDE.md                     rules for Claude Code in this folder
  STATE.md                      one-page brief every Claude session reads first
  .claude/commands/             one file per job (ingest, curate, test, grade, day-end)
  semesters/s1/
    assessment.yaml             exam dates, components, weights
    subjects/<subject>/
      syllabus.md               full topic skeleton, released and upcoming
      assets/                   IITJ originals, never edited
      extracted/                text, LaTeX formulas, code from each asset
      concepts/<id>.md          one card per concept
      paths/<id>.yaml           resource path: segments with timestamps
      packs/<id>.yaml           check pack: key points, rubric, quick questions
      labs/<id>/                notebook plus hidden tests for the practical
      questions/                bank: PYQ, official, external, generated
  tests/<date>/                 test paper, submissions, grading report
  inbox/                        captures from phone
  portfolio/                    generated portfolio
  study.db                      events, attempts, mastery, reviews (git-ignored)
```

**Write rules**

- Claude writes files (concepts, paths, packs, labs, tests). The hub watches the folder and indexes changes into `study.db`.
- Every event (start, answer, mistake, score) goes through the hub's Study API. Claude Code uses a `study` CLI that calls the same API, so `study.db` has one writer.
- Every AI change is audited and undoable, reusing Execution OS audit and undo.
- `study.db` is backed up daily (14 kept, like Execution OS); the vault is committed to git after every headless run.
- IITJ assets and `study.db` never leave the PC. Phones and MCP get summaries, never raw course files.

## Concepts and world-class resources

IITJ assets decide what must be learned; Claude maps every concept to the best open resource segment, so your coverage can run ahead of the university's weekly release.

**Syllabus skeleton first.** On day 1 each subject's full course outline is ingested, so every topic exists as a concept stub before IITJ releases that week. This is what makes finishing by Nov 15 possible.

**Ingestion (headless Claude)**

1. Classify each asset: subject, week, type (slides, transcript, notes, assignment, quiz, PYQ, practical, screenshot).
2. Extract text, formulas as LaTeX, and code, with page or slide references.
3. Decompose into concepts. One concept = one idea testable by one question, about 20–40 minutes to learn.
4. Link to existing concepts: merge duplicates, then prerequisite, tested-by and confused-with links.
5. Update the concept card: definition, formulas, IITJ source references, exam weight, notation used by IITJ.

**Resource curation (headless Claude, with web search and fetch)**

- A path is 1–3 segments: visual intuition first, then formal explanation or derivation where the exam needs it, then a worked example.
- Each segment stores the URL, start–end timestamps or page range, and one line on why it was chosen.
- Ranking: covers this exact concept at IITJ depth → visual richness (animation, interactive) → shortest segment that teaches it → notation close to IITJ → your own results with that source.
- Every link is fetched and checked before saving; dead links are re-curated that night.
- The concept card keeps a notation map: IITJ symbols beside the resource's symbols.
- Curation stays 3 days ahead of your queue.

**Starting candidate list (Claude verifies each before use)**

| Subject | Candidates |
| --- | --- |
| Linear Algebra and Numerical Analysis | 3Blue1Brown Essence of Linear Algebra, MIT 18.06 (Gilbert Strang), MIT OCW numerical methods |
| Foundations of Statistics and Probability | Harvard Stat 110 (Joe Blitzstein), Stanford CS109, Seeing Theory (Brown), MIT 18.05, StatQuest |
| Algorithmic Thinking and its Applications | MIT 6.006, Harvard CS50, VisuAlgo |
| Basics of Data Analytics | Python Data Science Handbook (Jake VanderPlas), Kaggle Learn, StatQuest |

**Academic integrity.** Live graded assignments are flagged; Study OS gives hints only, never solutions, until you submit.

## The learning loop

&#91;embedded content: Learning loop per concept · one decision, one retry loop, one repair rule\]

A concept moves on only after you explain it, pass the quick check and implement it; a miss sends you to an alternate segment, and the same mistake twice puts a repair item at the top of the queue.

- The repair item starts with the most visual explanation available, then a retest of the exact mistake.
- Labs are short Python notebooks with hidden tests, run on the PC; formulas are implemented, not only memorised.
- Every step writes an evidence event; the hub, not the tutor, moves mastery.

## Quick Tutor

A small fast model answers instantly after each video, but it only grades against a check pack Claude wrote in advance. Claude decides what correct looks like; the small model only compares.

**Check pack (written by headless Claude before you reach the concept)**

- Expected understanding: 5–8 key points your explanation must contain.
- Common misconceptions for this concept.
- 5–10 quick questions with answers and a rubric.
- Formula list and 2 retry hints.

**What the Quick Tutor does**

- Takes your explanation, typed or spoken (speech-to-text on phone or PC).
- Marks which key points you covered, missed or got wrong; gives 2–3 lines of feedback.
- Asks the quick questions and checks answers against the pack.
- Labels each mistake with its class (concept gap, formula recall, wrong method, and so on).
- Decides: pass, or re-explain with the alternate segment.

**What it may not do**

- Invent curriculum or questions outside the pack.
- Set mastery directly. It writes evidence events; the hub computes mastery.
- Grade the 3-day tests.

**Provider.** Pluggable, reusing the Execution OS AI layer (`src/lib/ai.ts`): any OpenAI-compatible endpoint, Gemini, the Claude API, or a free local model through Ollama on the PC. Set once in Settings, with a monthly spend cap.

**Audit.** Every verdict is logged with your raw answer. Each night Claude re-grades all low-confidence verdicts and a sample of the rest. When Claude disagrees, mastery is corrected and the pack is improved.

## The 3-day test

Every 3 days headless Claude builds one cumulative test of everything studied so far, split by subject, with a written part and a programming part.

**Question mix per subject**

| Share | What it checks |
| --- | --- |
| 40% | Concepts learned since the last test |
| 25% | Older concepts (retention) |
| 20% | Past mistakes (was the repair real?) |
| 15% | Mixed and transfer questions across concepts |

Each subject also gets 1–2 questions in the style of IITJ quizzes and assignments.

**Written part.** Conceptual, numerical and derivation questions. Answer on paper and upload a photo, or type. Claude grades against a rubric written before the test was released.

**Programming part.** Python tasks with hidden test cases, run locally on the PC and scored instantly. Claude then reviews the code for method and clarity.

**Taking it.** Starting a test starts a timed Execution OS focus session with Focus Guard on. Default length 60–90 minutes, set in Settings; a test can be split by subject across the day.

**Report.** Score per subject, concepts that moved up or down, mistake classes, repair items added, updated coverage and readiness, and the new projected ready date.

## Progress, pace and readiness

The target is 100% syllabus coverage by Nov 15 (exam start Nov 30 minus 15 days); Nov 16–29 is only tests, repair and IITJ-pattern practice.

**Concept status ladder (each step needs evidence)**

1. Seen: resource segment completed.
2. Understood: your explanation covers at least 80% of the key points.
3. Applied: quick questions at least 80% and the lab passes.
4. Retained: correct recall at least 3 days later, in review or a test.
5. Exam-ready: correct in a timed test, including one transfer question.

The PDF's mastery dimensions are still stored per concept; the ladder is the summary you see.

**The numbers on screen**

| Number | Meaning |
| --- | --- |
| Syllabus coverage % | Concepts at Applied or above ÷ all syllabus concepts, per subject and overall |
| Released coverage % | Same, counting only concepts from IITJ assets released so far |
| Readiness % | Retained and Exam-ready concepts, weighted by exam weight; drops when reviews are skipped |
| IITJ track % | IITJ lectures watched and assignments submitted |
| Pace | Concepts per day needed to reach 100% by Nov 15 vs your 3-day average → on pace, or behind by N |
| Projected ready date | The date you reach 100% at your current pace |
| Study hours | From Execution OS sessions |

**Spaced review.** Every Retained concept is scheduled for review by a spaced-repetition algorithm (FSRS). Due reviews open each study day as the first 10–15 minutes.

**Honest load.** Oct 28 to Nov 15 is 19 days; at 3–4 hours a day that is about 57–76 hours for four subjects. The pace meter shows from day 2 whether this holds. If the projected date slips past Nov 15, the queue reorders remaining concepts by exam weight × weakness.

## Claude automation

All heavy work runs as scheduled headless Claude Code jobs on the PC (Sonnet by default, changeable per job). Windows Task Scheduler runs `claude -p` in the StudyOS folder; each job is a command file in `.claude/commands/`, so the same job can also be run by hand in the terminal.

| When | Job |
| --- | --- |
| Every 2 hours, if new files are in `inbox/` or `assets/` | Ingest → concepts → resource paths → check packs → labs |
| Nightly, 1:00 | Day-end synthesis, mastery recompute, Quick Tutor audit, review queue, keep resources 3 days ahead, refresh `STATE.md`, git commit |
| Every 3rd day, 5:00 | Build the 3-day test |
| When a test is submitted | Grade the written part, write the report |
| Sunday night | Week synthesis, graph cleanup (merge duplicates), portfolio update, pace re-plan |

- Jobs use your Claude plan's usage limits, so heavy jobs run at night.
- Every job is safe to re-run; a failed run shows on the Study home screen ("last ingest failed") with its log.
- `STATE.md` is the persistent context: subjects, ready date, pace, weak concepts, open repairs, next 10 queue items. Every Claude session, interactive or headless, reads it first and opens other files only as needed.

## Study home, phone and MCP

Opening Study OS shows the next video, how complete the course is, and what is due; nothing else is on the default screen.

**Study tab (Execution OS app on PC, Android and browser)**

1. Header: exam in N days · ready date in M days · overall % · pace status.
2. Next up: concept, subject, video thumbnail and segment length, one line on why now, Start.
3. Due today: review cards, repair items, the 3-day test when due.
4. Four subject bars: coverage and readiness.
5. IITJ track: lectures pending, assignments with deadlines.
6. Last test report and portfolio links; concept graph on demand.

Videos play embedded, starting and stopping at the chosen timestamps; the player reports completion and re-watches as learning evidence.

**Phone.** The same Study tab, live whenever the PC is reachable (home Wi-Fi or Tailscale). Offline it keeps today's pack: next 3 items, their check packs and due reviews. Answers queue and sync later; the Quick Tutor needs internet.

**MCP (Claude mobile and desktop).** Added to the existing Execution OS connector: `study_overview`, `study_next`, `study_progress`, `study_test_report`, `study_capture` (to inbox), `study_log_attempt`, and `study_propose` for graph or path changes, which arrive as proposals with undo. Heavy work never runs through MCP.

## Portfolio

Everything you learn from world universities becomes a portfolio, generated weekly and private until you choose to publish it.

- Each entry: university or source, course, lecture and segment, concept, date, minutes, your own explanation, quick-check score, lab link.
- Views: by university (MIT, Harvard, Stanford and others), by subject, by concept; totals for hours, concepts and labs.
- Your lab notebooks can live in a separate public GitHub repo.
- IITJ material never appears in the portfolio.

## Build plan to Nov 15

Study starts Oct 28, not after the build: until the Study tab exists, Claude Code in the terminal serves the queue, the quick checks and the first 3-day test by hand.

&#91;embedded content: Build plan · 4 phases, ready date, sprint, exams\]

- Claude Code builds while you study; you only review and approve.
- Each phase ships behind the `study` flag in Labs, with git tags before and after, as in Execution OS v2.

**Open decisions**

- [ ] Full syllabus or course outline for all 4 subjects (needed to plan beyond the weeks IITJ has released)
- [ ] Quick Tutor provider: which hosted small model, or a local model through Ollama
- [ ] Exam weights per subject and the end-term format (written, MCQ, programming)
- [ ] Vault location on the PC
- [ ] Portfolio and labs repo: public or private
