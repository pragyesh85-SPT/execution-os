# UX v3 — what the research says and what changed

Release 2.3.0. The owner's complaint: "the UX is too hard, the whole Study part especially". This page maps each
research finding to a concrete change, so every change can be traced (and undone) on its own.

## Sources

Research papers (owner's folder "UI UX Rp"):

| # | Paper | Finding used |
|---|---|---|
| rp1 | Hasan et al. 2026, *Adaptive UI for mobile banking apps* | Putting the functions a person needs *now* on the home screen raised effectiveness, efficiency and SUS scores over a static layout. |
| rp2 | Gajos, Weld, Wobbrock, *Supple* | Bigger targets and fewer navigation steps cut task time, most of all for people on touch / with motor strain (Fitts' law). |
| rp3 | Arora et al. 2026, *Responsive UI by task criticality and user context* | Match information density and interruption to the task: while a person is in a focused task, lower the density and do not interrupt with non-critical UI. |
| rp4 | Akiki, *Adaptive UIs for enterprise applications* | Feature-set minimisation: hide features a person does not need for the current task instead of showing everything ("training wheels"). |
| rp5 | Ergonomics in Design 2011, *Enterprise apps can be both feature-rich and easy to use* | Task-based (not feature-based) navigation, consistent templates, short wizards, error forgiveness, plain labels. |
| rp6 | Tappan et al., *Mobile application for utility field workers* | Design from the decisions the person must make in the field; glanceable "what do I do next". |
| rp7 | Bargas-Avila et al. 2011, *Date entry fields* | Format help next to the field; pickers remove format errors. |
| rp8 | Bargas-Avila et al. 2011, *Multiple selection elements* | Visible options (checkboxes / radio buttons) are faster and preferred over list boxes / drop-downs. |
| rp9 | Seckler 2011, *Location of error messages* | Errors next to the field (right side on wide screens) are corrected fastest. |
| rp10 | Inal 2016, *Error messages — eye tracking* | Inline messages beside the input are noticed fastest; users asked for hints that prevent the mistake up front. |
| rp11 | Lindgaard et al. 2006, *50 milliseconds* | Visual appeal is judged in ~50 ms and that first judgement sticks — the first screen must look calm and ordered. |
| rp12 | Stanford-Makovsky credibility study 2002 | "Arranged in a way that makes sense" and easy navigation are top credibility factors; hard navigation is the surest way to lose trust. |
| rp13 | Rodden et al., Google, *HEART framework* | Measure UX by goals → signals → metrics (Happiness, Engagement, Adoption, Retention, Task success). |

Design references from the owner's other apps (an admin panel, a field app and a website):
status always as text in a pill (never colour alone), phones use bottom sheets, toasts sit above the bottom bar,
empty states point to the next action, submit buttons explain why they are disabled, destructive actions get a
separate confirmation, one primary action per card.

## Changes

| Area | Before | After | Why (source) |
|---|---|---|---|
| Study home | Two different "Start" buttons (header "Start studying" and card "Open" + "Start session") — unclear which to press. | One hero card, **Start lesson**: starts the timer + Focus Guard *and* opens the lesson in one tap. "Preview" opens it without the timer. | rp2 fewer steps, rp5 task-based, design refs: one primary action |
| Study home | Header line packed with numbers ("ready date in 17 days · 0% done · behind by 1"). | One plain sentence: "32 days to the exam · 1 lesson behind the plan". | rp11, rp12 |
| Study home | Due items, subjects, IITJ track, capture, concept graph, AI changes and setup all open at once. | "Before the new lesson" appears only when something is due; tools (capture, graph, AI changes, test report) sit behind one **Tools** disclosure. | rp4 feature minimisation, rp3 density |
| Deadlines | A ghost button reading "Submitted" that looks like a status. | Due date in words ("in 4 days"), a **Mark as submitted** button, and a status pill. | rp12, design refs: status pills |
| Lesson | One long page: video, card, explain, quick check, lab and mastery stacked. | A guided lesson with steps **Watch → Explain → Check → (Lab) → Done**, one step on screen, step bar on top, Next/Back, live timer bar. | rp3, rp5 wizard, rp6 "what next" |
| Lesson | Jargon: "rung", "repair", "readiness". | "Stage", "Fix a weak spot", "exam-ready". | rp5 plain labels |
| Quick check | Answer options in a drop-down. | Options shown as radio buttons, result inline beside the answer with an icon. | rp8, rp9, rp10 |
| Explain | "Check" button silently disabled under 20 characters. | Hint under the box says how much more to write. | rp10, design refs |
| Now | Study summary card above the current block. | The current block comes first; the Study card follows with **Continue lesson** that opens the lesson directly. | rp1, rp6 |
| Interruptions | A rule could pop Rescue Mode over a lesson, a test or while typing. | During a lesson/test or while typing, it becomes a toast with a "Rebuild" button. | rp3 |
| Navigation | Seven or eight flat items; shortcut numbers out of order (Study was 8 but second). | Grouped rail (Daily · Look back · System), numbers in visual order. | rp5, rp12 |
| Touch | 30 px small buttons on phones. | 40–44 px on touch screens. | rp2 |
| Plan | "Add to this day" form always open. | Behind an **Add a block at a fixed time** button. | rp4 |

## How we will know it worked (HEART, rp13)

| Goal | Signal | Metric (read from the existing local data, no telemetry is sent anywhere) |
|---|---|---|
| Task success: starting to study is easy | Study sessions started from the Study tab | Sessions per day with a concept attached |
| Engagement: lessons get finished | Segments marked watched + quick checks answered in the same session | Share of sessions with ≥ 1 check answered |
| Happiness | The owner's own verdict after a week | "Easier / same / harder" |

## Rolling back

- Git: tag `pre-ux-v3` is the last commit before this work; every phase is tagged `ux-v3-pN-done`.
  `git checkout pre-ux-v3` (or revert the merge) restores the old UI exactly.
- Windows: the 2.2.0 installer stays on the GitHub release v2.2.0.
  Installing it over 2.3.0 brings the old UI back; data is untouched (this release changes no data formats).
- Android: Android refuses to install an older versionCode over a newer one. To go back: let the phone sync
  with the PC first (its data is copied on the PC hub), uninstall 2.3.0, install the 2.2.0 APK from the
  v2.2.0 release, then pair again with **Scan PC**.
