# Execution OS + Study OS — User Manual

Version 2.1 · for Windows, Android and any browser

This manual explains how to install and use everything: **Execution OS** (your 24-hour command system)
and **Study OS** (the study module that runs inside it). Read Part 1 once, then keep Part 3 (daily use)
and Part 5 (Study OS daily use) open for the first week.

---

## Contents

1. [What these two systems do](#1-what-these-two-systems-do)
2. [Install](#2-install)
3. [Execution OS — daily use](#3-execution-os--daily-use)
4. [Execution OS — planning, rules, insights and settings](#4-execution-os--planning-rules-insights-and-settings)
5. [Study OS — set up once](#5-study-os--set-up-once)
6. [Study OS — daily use](#6-study-os--daily-use)
7. [Claude: the AI connector, Claude Code and the nightly jobs](#7-claude-the-ai-connector-claude-code-and-the-nightly-jobs)
8. [Phones, sync and working offline](#8-phones-sync-and-working-offline)
9. [Backups, updates and undo](#9-backups-updates-and-undo)
10. [Troubleshooting](#10-troubleshooting)
11. [Reference: the Study Vault folder and the `study` command](#11-reference-the-study-vault-folder-and-the-study-command)
12. [Glossary](#12-glossary)

---

## 1. What these two systems do

**Execution OS** always answers one question: *"Given what has actually happened today, what is the
single best thing I should do right now?"* It is a live 24-hour clock of your day. Every block (sleep,
devotion, study, deep work, meals, care) has **one mission**. When you drift, it notices; when the day
goes wrong, **Rescue** rebuilds the rest of the day instead of declaring it failed.

**Study OS** decides *what* to study and *how well you know it*. Your course material (for example the
IIT Jodhpur slides, transcripts, quizzes and assignments) defines what must be learned. Claude maps
every topic to the best short segment of a world-class open resource (MIT, Harvard, Stanford,
3Blue1Brown …), writes a check for it, and keeps a queue: **watch → explain → quick check → lab →
review → test**. Every answer is evidence; your level on each concept moves only with evidence.

How they work together:

- Study OS never waits for a block. Press **Start** in the Study tab at any time; Execution OS shows
  *"Studying: <concept> (Study OS)"*, runs the timer, turns Focus Guard on, and when you press **Stop**
  it fills the proof of work for you.
- Execution OS still plans how much of your day goes to study; anything started in Study OS counts.
- Your PC is the server for both. All study data stays on your PC; your phone gets a small daily
  summary and the Study tab when it can reach the PC.

---

## 2. Install

### 2.1 Windows (the PC is the hub)

**Easiest — one line.** Open PowerShell and paste:

```powershell
powershell -ExecutionPolicy Bypass -NoProfile -Command "irm https://raw.githubusercontent.com/pragyesh85-SPT/execution-os/main/scripts/install.ps1 | iex"
```

It downloads the latest release, checks its SHA-256 fingerprint, installs it and opens the welcome
wizard. Or download `ExecutionOS-<version>-setup.exe` from the
[Releases page](https://github.com/pragyesh85-SPT/execution-os/releases) and run it. (Windows SmartScreen
may warn once because the EXE is not code-signed: *More info → Run anyway*.)

The installed app updates itself: when a new release appears, it downloads it and asks to restart.
The **portable** EXE runs without installing but does not update itself.

Your data lives in `%APPDATA%\execution-os` (database, daily backups, Study OS settings). Uninstalling
the app does not delete it.

### 2.2 The welcome wizard (first start)

1. Your name and when your day starts (the end of sleep, e.g. 04:00).
2. The **master clock**: your default 24 hours. Keep the suggested blocks or edit them later in **Clock**.
3. **Wake Gate**: print the QR card it shows and stick it somewhere away from your bed.
4. **Pair your phone** (see 2.3) — you can also do it later from **Settings → Devices & sync**.

### 2.3 Android phone

1. Download `ExecutionOS-<version>.apk` from the Releases page on the phone and install it (allow
   "install unknown apps" for your browser once).
2. Open it → **Scan the QR on the PC** → on the PC open **Settings → Devices & sync** and
   scan the pairing QR code it shows. That is all: no address, no PIN.
3. Away from home Wi-Fi: install **Tailscale** on the PC and the phone (free) and sign in to both with
   the same account. The phone switches between home Wi-Fi and Tailscale by itself.

Allow notifications and exact alarms when the app asks (needed for block reminders and the wake alarm).

### 2.4 iPhone or any browser

Open the PC's address (shown in **Settings → Devices & sync**) in the browser and *Add to Home Screen*.
On a phone browser you pair by scanning the same QR.

### 2.5 Focus Guard for the browser (optional, recommended)

Chrome / Edge → `chrome://extensions` → switch on **Developer mode** → **Load unpacked** → choose the
`extension` folder (in the app's install folder under `resources\extension`, or in the source code).
It blocks distracting sites only while a focus block or a study session is running.

---

## 3. Execution OS — daily use

### 3.1 The Now screen

This is home. From top to bottom:

- **Status pill**: **On track** (green), **Drifting** (amber: a focus block has not started on time) or
  **Rescue** (red: a protected block was badly missed).
- **Study card** (when Study OS is on): minutes studied today, the next concept, coverage, pace, what is due.
- **Now card**: the current block, its **mission** ("Finish Assignment 3, Q1–Q5", never just "study"),
  its steps, and the time left. **Start** begins a timed session; **F** opens Focus Mode.
- **Next**: the next three blocks and their missions.
- **3 outcomes**: the three results that would make today a success. Tick them as you finish.
- **Banners** when something needs you: finished blocks without proof, a pending proposal, devices
  disagreeing about an edit.

### 3.2 Focus Mode and Focus Guard

Press **F** (or *Start* on the Now card). Focus Mode is a full-screen view of the mission, its steps and
the countdown. While it runs, **Focus Guard** blocks distracting sites (browser extension) and the
Windows app notices if Netflix or YouTube stays in front. An urge can be **parked** in the *Later*
list instead of followed; the app counts urges resisted.

### 3.3 Proof of work

When a focus block ends, Execution OS asks what actually happened: **Completed / Partially / Didn't
start**, a short note, links. GitHub commits and pull requests made during the block are detected
automatically. Remaining work becomes an inbox task. This is how the weekly review learns — be honest;
there are no streaks to protect.

### 3.4 "I'm doing something else" (Quick Override)

Inside a block you can choose honestly: **Swap** (this block's mission becomes the new thing; the old
mission returns to the inbox), **Borrow 15 / 30 minutes** (a short detour; the block keeps its end
time), or **Drift** (an honest log of time that went elsewhere). Each is recorded and can be undone.

### 3.5 Rescue Mode

Late start, a missed block, an unexpected event: tap **Rebuild my day**. Rescue keeps fixed anchors
(sleep, devotion) and pinned blocks, protects the minimums (for example 2 hours of study), trims the
lowest-priority work and explains every change in one sentence. It offers up to three strategies —
**Balanced, Protect study, Ship the deliverable, Light day** — as a proposal. Choose one and apply it
**for today** or **for the week**. Lateness is never pushed block by block through the rest of the day.

### 3.6 Wake Gate

The morning alarm (an escalating temple bell) stops only when you **scan the QR card** placed away from
your bed (or type its code). The emergency bypass exists but takes deliberate effort. Turn it off in
**Settings → Wake Gate**.

---

## 4. Execution OS — planning, rules, insights and settings

### 4.1 Plan

- **Today and the next days**: set each focus block's mission and steps, the 3 outcomes, and **pin**
  a block to its clock time ("4–5 PM is for this task" — Rescue never moves a pin).
- **Add a block** for a specific thing at a specific time; it cuts flexible blocks, never anchors or pins.
- **Task inbox**: everything not yet scheduled, with area (IIT, founder, personal), priority, deadline,
  estimate. IITJ deadlines from Study OS appear here automatically.
- **AI planner** (optional): picks the highest-value mission for each block from your inbox. Without an
  AI key there is a built-in smart fill and a *copy prompt → paste reply* flow for any chat AI.
- **Proposals**: plans from Rescue or AI arrive as a proposal showing before / after. Nothing structural
  changes until you apply it.

### 4.2 Clock (master clock)

Your default 24 hours. Each block has a category, start, length, whether it is **fixed** (an anchor),
whether it is a **focus** block (Focus Guard on), a minimum Rescue may compress it to, and a priority
(1 = protect first). The clock warns if sleep drops below 7 hours. **Day boundary** sets when your
logical day starts.

### 4.3 Calendar and Targets

Day / Week / Month views of what was planned and what actually happened. **Targets** go year → month →
week → day (hours, counts, done / not done, milestones) with an honest pace: on track, behind, at risk.

### 4.4 Insights and Coach

Plan-versus-reality numbers over 7, 28 or 90 days: on-time starts, mission completion, drift heat map,
rescues, plan accuracy, deep-work hours. Each week the **Coach** gives a grade the AI cannot round up,
the three facts behind it, the biggest leak, and **one** IF → THEN change you can add with one tap.

### 4.5 IF → THEN rules

Decisions made in advance, run automatically. Examples: *IF I miss 20 minutes of a study block THEN open
Rescue*; *IF a focus block starts THEN turn on Focus Guard*; *IF I feel an urge THEN save it for later*.

### 4.6 Settings — what each section is for

| Section | What you do there |
| --- | --- |
| Day & targets | Name, day start, protected minimums (e.g. study 2 h), daily targets, drift and rescue thresholds |
| Wake Gate | On / off, grace minutes, print the QR card again |
| Focus Guard | Sites to block, sites always allowed, window-title keywords for the Windows watcher |
| AI | Optional AI key for the planner (stored only on this device) |
| AI connector | Let Claude (or another MCP app) read and operate Execution OS — see section 7 |
| AI activity | Every AI action, with **Undo** |
| Devices & sync | Pair phones (QR), see devices, revoke one, private HTTPS address |
| Notifications | Block reminders, sounds |
| Integrations | GitHub username (automatic proof), class imports and Join links |
| IF → THEN rules | Same as the Rules screen |
| Data | Export, import, clear history, reset |
| Health | One-click health check with a fix for each problem |
| Labs | Switch any feature on or off — including **Study OS**. Nothing is deleted when a feature is off |
| About | Version, updates, the welcome wizard again |

---

## 5. Study OS — set up once

Do this on the PC. It takes about 15 minutes, plus waiting for Claude's first ingest.

### 5.1 What you need

- **Claude Code** installed and signed in on the PC (it does the heavy work: reading the course
  material, choosing resources, writing checks, labs and tests, grading). Check: open PowerShell, type
  `claude --version`.
- **Python 3** for labs and the programming part of tests (`python --version`). Get it from python.org.
- Optional: **Ollama** (free, local) or an API key for the Quick Tutor (5.6).

### 5.2 Switch it on

**Settings → Labs → Study OS → on.** A **Study** tab appears after Now (on phones it takes Calendar's
place; Calendar moves to *More*).

### 5.3 Create your Study Vault

Open **Study**. On the PC you see **Create your Study Vault**. Keep `C:\StudyOS` or choose another folder
**outside** the program folder → **Create my Study Vault**.

The vault is a private folder on your PC holding everything Study OS knows. It is also a local git
repository (every nightly change can be undone) that **refuses to be pushed** anywhere: your course
material never leaves your PC.

### 5.4 Tell it about your semester

Open the vault folder in File Explorer (or VS Code) and edit two kinds of files:

1. `semesters\s1\assessment.yaml` — exam start date, study start date, subjects (an id like `lana`, the
   title, the exam weight), graded components, and **deadlines** of assignments and quizzes:

   ```yaml
   examStart: "2026-11-30"          # ready date = 15 days before, unless you set readyBy
   deadlines:
     - { id: lana-a1, subject: lana, title: Assignment 1, kind: assignment, due: "2026-11-02", graded: true }
   ```

   Every deadline becomes an Execution OS task (area IIT) with its due date. `graded: true` means a
   **live graded assignment**: Study OS gives hints only, never solutions, until you mark it submitted.

2. `semesters\s1\subjects\<subject>\syllabus.md` — the **full** course outline, released and upcoming:

   ```markdown
   ## Week 1: Vectors
   - Vectors and linear combinations
   - Dot product
   ## Week 2: Matrices
   - Matrix multiplication (weight 2)
   ```

   Every bullet becomes a concept on day 1, so the whole course exists before IIT releases it. That is
   what makes finishing by the ready date possible. An outline file inside your asset folder also works.

### 5.5 Add your course assets

**Study → Study setup (this PC) → Add course assets**: paste the folder path (for example
`D:\IITJ\Semester 1`) → **Ingest**. Files are **copied** (your originals are never moved or changed),
sorted into subjects by their folder names, classified (slides, transcript, notes, assignment, quiz,
PYQ, practical, screenshot) with their week, and the readable text is extracted. The same file twice is
skipped. A file whose subject cannot be told goes to `inbox\unsorted` — choose the subject in the list
next to the path and ingest that file again, or let Claude file it.

### 5.6 Choose the Quick Tutor (optional)

**Study setup → Quick Tutor provider.** The Quick Tutor is a small, fast model that checks your
explanation instantly — but only against the check pack Claude wrote in advance; it cannot invent
questions, and it never sets your level.

| Choice | Cost | How |
| --- | --- | --- |
| None (built-in matcher) | free | Default. Numbers and multiple choice are exact; explanations are matched to key words and Claude re-checks every one at night |
| Ollama on this PC | free | Install Ollama, run `ollama pull llama3.2`, choose *Ollama*, model `llama3.2` |
| Claude / OpenAI / Gemini / compatible | pay per use | Choose it, paste the key, set a **monthly cap** (the tutor stops at the cap) |

Press **Save**, then **Test connection**. The key stays in `%APPDATA%\execution-os\study.json` on this PC
and is never shown to or synced with any other device.

### 5.7 Run the first ingest, then schedule the jobs

**Study setup → Scheduled Claude jobs.** First check that it shows your Claude Code version.

1. Press **Run now** next to **Ingest**. Claude reads the new material in the background (10–40 minutes
   the first time): it completes the extracted text (formulas, figures, scanned pages), turns the
   material into concept cards, finds resource segments, writes check packs and labs. The result appears
   on the Study tab ("last ingest ok" or "failed" with its log).
2. Press **Register all** once. From then on Windows Task Scheduler runs:

| Job | When | What it does |
| --- | --- | --- |
| Ingest | every 2 hours, only if something new arrived | material → concepts → resources → check packs → labs |
| Day-end | 1:00 every night | re-checks the Quick Tutor's verdicts, repairs, keeps resources 3 days ahead, refreshes the brief |
| Build-test | 5:00 every 3rd day, only when due | builds the cumulative 3-day test |
| Grade | every 30 minutes, only after you submit a test | grades the written part, writes the report |
| Week-end | Sunday 22:00 | cleans the concept graph, week summary, portfolio, pace re-plan |

The PC must be on and you must be signed in to Windows. Jobs use your Claude plan's usage limits,
which is why the heavy ones run at night. **Remove all** takes them out again.

---

## 6. Study OS — daily use

### 6.1 The Study tab

| Part | Meaning |
| --- | --- |
| Header | Exam in N days · ready date in M days · % of the syllabus done · pace |
| Next up | The concept, the subject, the segment (source, course, start–end), how long, and *why now* |
| Due today | Review cards, repair items, the 3-day test when due |
| Subjects | Per subject: coverage bar (orange) and readiness bar (green) |
| IITJ track | Lectures watched and assignments submitted, open deadlines with a *Submitted* button |
| More | Last test report, capture box, concept graph, proposals, recent AI changes with Undo |
| Study setup | (PC only) assets, Quick Tutor, scheduled jobs |

### 6.2 One concept, step by step

1. **Start studying** (top right). Execution OS records the session, shows *"Studying: … (Study OS)"* on
   Now and turns Focus Guard on. Inside an IIT block it uses that block; inside another block it swaps
   that block to study; with no block it adds one. Study whenever you like — the system follows you.
2. **Open** the Next up item. **Watch** the segment: it plays right there and stops at the chosen time.
   When it ends it is marked watched (or press *I watched it*). Status: **Seen**.
3. **Explain it in your own words** — type, or press **Speak**. The tutor marks which key points you
   covered or missed and gives 2–3 lines of feedback. Covering 80 % of the key points = **Understood**.
   If you miss, the next step offers an **alternate explanation** and a hint.
4. **Quick check**: 5–10 short questions from the pack. 80 % right (and the lab passed, if the concept
   has one) = **Applied**.
5. **Lab**: implement the formula or algorithm in Python; **Run hidden tests** runs them on your PC.
6. **Stop studying**. The Execution OS proof fills itself, e.g. *"3 concepts, 14 questions 79 %, lab
   passed"*, with a link to the session report.

If nothing happens in Study OS for 10 minutes during a session, Execution OS records drift. A session
left alone for 90 minutes stops itself.

### 6.3 The ladder (your level per concept)

| Rung | Needs this evidence |
| --- | --- |
| Seen | resource segment watched |
| Understood | your explanation covers ≥ 80 % of the key points |
| Applied | quick questions ≥ 80 % and the lab passes |
| Retained | correct recall at least 3 days later (review or test) |
| Exam-ready | correct in a timed test, including one transfer question |

Each concept also shows 8 mastery bars (exposure, understanding, recall, application, implementation,
retention, transfer, speed), each computed only from evidence, or "no evidence yet".

### 6.4 Reviews and repairs

- **Reviews**: every Applied concept is scheduled for review by a spaced-repetition algorithm (FSRS).
  Due reviews come first each study day: recall the concept without looking, then grade yourself
  **Forgot / Hard / Good / Easy**. Skipped reviews lower **readiness**.
- **Repairs**: the **same mistake twice** on a concept (same formula, same kind of mistake) puts a repair
  item at the top of the queue: watch the most visual explanation, then a retest. Get it right and the
  repair closes.

### 6.5 The 3-day test

Every 3 days Claude builds one cumulative test of everything studied so far, split by subject:
40 % concepts since the last test, 25 % older ones, 20 % past mistakes, 15 % mixed / transfer questions,
plus questions in the style of IITJ quizzes and assignments.

1. When it is due it appears under **Due today → Take the test**. Starting it starts a timed Execution OS
   focus session with Focus Guard on.
2. **Written part**: type your answer, or write on paper and add a **photo**.
3. **Programming part**: write Python; hidden tests run on your PC and score it at once.
4. **Submit**. Claude grades the written part against a rubric fixed before the test (the Grade job, within
   30 minutes) and writes the **report**: score per subject, concepts that moved, mistake types, repair
   items added, coverage, readiness and the new projected ready date (*More → Last 3-day test → Report*).

### 6.6 The numbers

| Number | Meaning |
| --- | --- |
| Syllabus coverage | concepts at Applied or above ÷ all concepts |
| Released coverage | the same, only for material released so far |
| Readiness | Retained and Exam-ready concepts, weighted by exam weight; drops when reviews are skipped |
| IITJ track | IITJ lectures watched and assignments submitted |
| Pace | concepts per day needed to finish by the ready date vs your 3-day average → *on pace* or *behind by N* |
| Projected ready date | when you reach 100 % at your current pace |

If the projected date slips past the ready date, the queue reorders the remaining concepts by exam
weight × weakness automatically.

### 6.7 Academic integrity

A concept that belongs to a **live graded assignment** shows *"hints only"*: the tutor gives hints,
never answers or solutions, until you press **Submitted** on that deadline (IITJ track).

### 6.8 Portfolio

Every week (or `study portfolio`) Study OS writes `portfolio\index.html` in your vault: every segment you
learned from world universities and open courses, by university, subject and concept, with your own
explanation, quick-check score and lab link. IITJ material never appears in it. It stays private until
you choose to publish it.

---

## 7. Claude: the AI connector, Claude Code and the nightly jobs

### 7.1 Claude on your phone or desktop (AI connector)

1. **Settings → AI connector** → switch on → **Publish** (needs Tailscale; only the connector is public,
   behind your token).
2. **Copy link** and **Copy token for Claude**.
3. In Claude: Settings → Connectors → *Add custom connector* → name `Execution OS`, the link, header
   `Authorization: Bearer <token>`.
4. In a chat: enable the connector. Try *"What's my current block?"*, *"Plan my day"*, *"Rescue my
   afternoon"*, *"What should I study next?"*.

With Study OS on, Claude also gets: **study_overview, study_next, study_progress, study_test_report,
study_capture** (save a doubt to your inbox), **study_log_attempt** (only after you confirm) and
**study_propose** (a better resource or concept links — it waits in the Study tab until you apply it,
with Undo). Every AI action is listed in **Settings → AI activity** with **Undo**; study file changes are
listed in **Study → More → Recent AI changes**.

### 7.2 Claude Code in the vault (terminal)

Open PowerShell in your vault (`cd C:\StudyOS`) and type `claude`. It reads `STATE.md` (a one-page brief
regenerated every night) and `CLAUDE.md` (its rules). Useful commands:

- `/study-now` — the tutor in the terminal: serves your queue, checks you, records evidence.
- `/ingest`, `/curate`, `/packs`, `/labs`, `/day-end`, `/build-test`, `/grade`, `/week-end` — any job
  by hand.

### 7.3 Watching the jobs

The Study tab shows a banner when the last run of a job failed, with its log file
(`C:\StudyOS\logs\…`). Run it again with **Study setup → Run now**. Every run commits the vault, so any
change Claude made can be undone with the vault's git history.

---

## 8. Phones, sync and working offline

- Every device keeps a full copy and works offline; changes upload when the PC is reachable again.
- If the same thing was changed differently on two devices, you are asked which version to keep —
  nothing is overwritten silently.
- **Study on the phone**: the Study tab works whenever the phone can reach the PC (home Wi-Fi or
  Tailscale). Offline it keeps today's pack — the next 3 items, their questions and due reviews — and
  queues your answers; they are checked when you are back online. The Today Study card always works.

---

## 9. Backups, updates and undo

| What | Where |
| --- | --- |
| Execution OS database | `%APPDATA%\execution-os\execution-os.db`, daily backups (14 kept) in `backups\`, plus a copy before every upgrade |
| Study OS database | `C:\StudyOS\study.db`, daily backups (14 kept) in `C:\StudyOS\.backups\` |
| Study OS files | the vault is a local git repository: every job run is a commit |
| Undo an AI action | Settings → AI activity → Undo · Study → More → Recent AI changes → Undo |
| Turn a feature off | Settings → Labs (nothing is deleted) |
| Updates | the installed app updates itself from GitHub Releases |
| A release misbehaves | install the previous release over it; your data stays |

---

## 10. Troubleshooting

| Problem | Fix |
| --- | --- |
| The phone says the PC is not reachable | PC on and the app running? Same Wi-Fi, or Tailscale on both? Re-pair from Settings → Devices & sync |
| Study tab: "Study OS is off on the PC" | Settings → Labs → Study OS on |
| Study tab: "Create your Study Vault on the PC" | Open the Study tab on the PC (not the phone) and create it |
| Next up is empty | Add the syllabus and the assets, then run the Ingest job (5.5, 5.7) |
| "No resource yet" on a concept | Curation runs ahead of your queue every night; run *Curate* now from Study setup |
| "No check pack yet" | Run *Packs* (part of Ingest) — Claude writes packs before you reach a concept |
| A job failed | Open its log from the banner; the most common cause is Claude Code not signed in (`claude` in PowerShell, then `/login`) |
| Claude Code: not found | Install Claude Code, open a new PowerShell, `claude --version` |
| Labs say Python was not found | Install Python 3 from python.org (tick *Add to PATH*) and restart the app |
| A file in the vault "did not parse" | `study status` (or the Study tab) names the file and the field; fix it or ask Claude to |
| Quick Tutor answers "built-in matcher" though a provider is set | the monthly cap was reached, or the provider failed — Study setup → Test connection |
| Anything else | Settings → Health → run the checks; each problem comes with a fix |

---

## 11. Reference: the Study Vault folder and the `study` command

```text
C:\StudyOS\
  STATE.md               one-page brief (rewritten nightly)
  CLAUDE.md              rules for Claude Code in this folder
  .claude\commands\      one file per job
  semesters\s1\assessment.yaml
  semesters\s1\subjects\<subject>\
      syllabus.md   assets\ (originals)   extracted\   concepts\   paths\   packs\   labs\   questions\
  tests\<date>\          paper, submissions, grading, report
  inbox\                 captures from your phone
  portfolio\             your learning portfolio
  logs\                  job logs
  study.db               the Study OS database (never edit)
  study.cmd              runs the `study` command
```

The `study` command (in PowerShell inside the vault: `.\study.cmd <command>`; `--json` for machine output):

| Command | Does |
| --- | --- |
| `status` · `next` · `progress` · `concepts [subject]` · `concept <id>` | look |
| `ingest <folder> [--subject s] [--week n] [--type t]` | add assets |
| `start [concept]` · `stop [note]` | study session |
| `log <kind> <concept> '<json>'` | record evidence (used by Claude) |
| `deadline submit <id>` · `iitj lecture <asset>` | IITJ track |
| `tutor status / set / audit / regrade` | Quick Tutor |
| `lab run <lab> <file.py>` | run a lab |
| `test plan / due / check / start / submit / finalize / report / list` | the 3-day test |
| `run-job <job> [--force]` · `jobs` · `schedule [--dry-run] [--remove] [--status]` | Claude jobs |
| `proposals [apply|reject <id>]` · `undo [<n>]` · `capture "<text>"` · `portfolio` · `dedupe` · `state` · `commit` | the rest |

---

## 12. Glossary

- **Block** — a stretch of the day with one category and one mission. **Anchor** — a fixed block (sleep,
  devotion) Rescue never moves. **Pin** — a block you fixed to its clock time for one day.
- **Mission** — the one concrete outcome of a block. **Outcomes** — the 3 results that make a day a success.
- **Proof** — what actually happened in a block. **Adherence** — share of meaningful blocks executed.
- **Rescue** — rebuilding the rest of the day (or week) to be feasible. **Proposal** — a change you review first.
- **Concept** — one idea, testable by one question, 20–40 minutes to learn. **Segment** — the part of a
  video or text that teaches it. **Check pack** — key points, misconceptions, quick questions and hints
  written by Claude before you reach the concept.
- **Evidence** — every watch, explanation, answer, lab run, review and test item; the only thing that
  moves your level. **Repair** — the retest after the same mistake twice.
- **Coverage / readiness / pace** — see 6.6. **Ready date** — exam start minus 15 days, by default.
- **Vault** — the private Study OS folder on your PC. **Hub** — your PC serving the app and the data.
