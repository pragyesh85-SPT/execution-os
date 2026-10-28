# Changelog

All notable changes to Execution OS are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).
Every release has a git tag (`vX.Y.Z`); every phase of the v2 plan also has `pre-phase-N` and `phase-N-done` tags as rollback points.

## [Unreleased]

## [2.3.0] - 2026-10-29

### Changed
- **Easier everywhere (UX v3), from 13 UX research papers** — see docs/ux-v3/RESEARCH.md for each finding and change.
  - **Study: one tap to study.** *Start lesson* starts the timer + Focus Guard and opens the lesson; *Preview without the timer* only opens it. The two competing Start buttons are gone.
  - **Guided lesson:** Watch → Explain → Check → Lab → Done, one step at a time, with a step bar, Next / Skip for now, a running-timer bar and a lesson summary.
  - Quick-check choices are buttons (not a drop-down) and each answer is checked right beside the question.
  - The Study tab speaks plainly ("32 days to the exam · 1 topic behind the plan"), shows *Do these first* only when something is due, IITJ deadlines say *due in N days* with **Mark as submitted**, and the extras sit behind one **Tools** fold.
  - Now: the current block comes first; the Study card has **Start / Continue lesson**.
  - Rescue Mode no longer jumps over a lesson, a test or typing — a notice with **Rebuild** appears instead.
  - Navigation grouped (Daily · Look back · System); number keys follow the order on screen (Study is now 2).
  - Phones: every button is at least 40 px tall.
  - Plan: the fixed-time form opens from **Add a block at a fixed time**, the start time uses a time picker, and **Reset day to master clock** asks for a second tap.

## [2.2.0] - 2026-10-28

### Added
- **Study OS — verified segment times.** `study transcript <url>` reads a YouTube video's transcript and chapters; segment start/end are used only when they match that text (Claude cannot watch videos), otherwise the whole video plays and the Study tab says "times not verified".
- **Speak your explanation in the Android app** (native speech-to-text), and in Chrome / Edge on the PC; typing always works.
- **Course pages, interactive sites and PDFs inside the Study tab** where the site allows it, with "Done — I studied it".
- **A drawn, zoomable concept graph** per subject (prerequisites, tested-by, often-confused; coloured by level).
- **The 3-day test timer is enforced:** live countdown, 1-minute warning, auto-submit at zero, autosave every 20 s, and the PC submits saved answers if the app is closed.

### Changed
- The vault's job files and file-format guide update themselves with the app (remove their marker line to keep your own edits).

## [2.1.0] - 2026-10-28

### Added
- **Study OS** (Settings → Labs → Study OS, off by default): a study module run from a private Study Vault on your PC.
  - Set up from the app: **Study → Create my Study Vault**, then **Study setup** to add course assets, choose the Quick Tutor provider and register the nightly Claude jobs.
  - Ingestion of slides, transcripts, notes, quizzes, assignments and PYQs (pptx, docx, subtitles, notebooks, PDFs through Claude) into concepts, with the full syllabus as concept stubs from day 1.
  - The Study tab: next video with an embedded player (start–end), explain (typed or spoken), quick check, Python labs with hidden tests, spaced reviews, repair items after the same mistake twice, the cumulative 3-day test (written + programming, photo answers) and its report, subject coverage and readiness, IITJ track, pace and projected ready date.
  - Quick Tutor that grades only against check packs Claude wrote in advance (Ollama, Claude, OpenAI, Gemini or OpenAI-compatible; none by default, monthly cap), re-checked by Claude every night.
  - Headless Claude jobs (ingest, curate, packs, labs, day-end, build-test, grade, week-end) with Windows Task Scheduler.
  - Execution OS link: Start/Stop anywhere shows "Studying now", runs the timer, turns Focus Guard on and fills the proof; idle time marks drift; IITJ deadlines become tasks; a Study card on Today (works offline).
  - Claude (MCP): study_overview, study_next, study_progress, study_test_report, study_capture, study_log_attempt, study_propose (with undo).
  - `study` command line and a weekly private learning portfolio.
- **User manual** for Execution OS and Study OS: docs/USER_MANUAL.md.

### Changed
- With Study OS on, the phone bar shows Study instead of Calendar (Calendar moves to More). With it off, nothing changes.

## [2.0.0] - 2026-10-25

### Added
- **Cards in chat (MCP Apps).** Rescue alternatives, day and week plans and class imports appear in Claude as a small card: the before/after of each day with pins outlined, the reasons, and *Apply for today*, *Apply for the week* or *Reject*. One self-contained 7.5 KB file, no network calls; the text reply stays for apps without MCP Apps.
- **Sign in instead of pasting a token (OAuth 2.1).** ChatGPT and other MCP clients connect with just the link: a sign-in page asks you to approve on the PC (Settings → AI connector → Connected AI apps) or with your PIN. PKCE (S256), dynamic client registration, exact redirect URIs, 1-hour access tokens bound to the connector, rotating refresh tokens (a reused one revokes the sign-in), per-app *Revoke*. Header tokens keep working.
- **"I'm doing something else"** inside a block: *Swap* the mission (the old one returns to the inbox), *Borrow 15/30 min* (the block keeps its end time) or *Mark as drift*. Recorded, undoable, and counted weekly on Insights so swaps never become a loophole. Pinned blocks ask once more.
- **Updates**: the installed Windows app updates itself (tray → *Restart to update*); the portable EXE and the Android app compare with the latest GitHub Release and offer the download; *Check for updates* in Settings → About works everywhere and fails gracefully offline.
- **Signed Android releases** when a keystore is provided through `EOS_KEYSTORE*` environment variables, and a GitHub release workflow that builds the EXEs and the APK, writes `SHA256SUMS.txt` and attaches `install.ps1`.

### Changed
- Every v2 feature is now on by default and can still be switched off in Settings → Labs.

### Upgrade notes
- **Android:** a release-signed APK cannot replace the debug-signed v1.0 app. Uninstall the old app once; your data is safe on the PC and comes back after scanning the QR (Settings → Devices & sync → Scan PC).
- **Windows:** install over v1.x; the database in `%APPDATA%\execution-os` is kept. The EXE is not code-signed, so SmartScreen may say "Windows protected your PC" → *More info* → *Run anyway*.

## [1.5.0] - 2026-10-25

### Added
- **Insights**: Analytics over 7 / 28 / 90 days — verified deep work, on-time starts, mission completion, drift heatmap (hour × weekday), rescues and their reasons, plan accuracy, anchors kept, entertainment vs budget, focus quality, rolling 7-day trends. No streaks.
- **Coach**: a weekly grade A–F computed by the engine (`score = 100 × (0.30 S + 0.35 C + 0.20 A + 0.15 D)`, not below 5 finished blocks), a behaviour profile with its numbers, three facts, the biggest leak and one IF → THEN change with one-tap *Add rule*. Coach tone: gentle / direct / drill (wording only).
- **Class imports**: `import_events` turns classes (e.g. found in email by Claude) into pinned blocks with a Join link and a reminder; re-imports never duplicate. Join opens only allow-listed https meeting sites; others show their real domain first (Settings → Integrations).
- Reminders with a *Join* action on Android; reminder notification and Join button on Windows and the web.
- Connector: `get_analytics` returns the engine's verdict; `post_coaching_note` (AI adds wording only); `import_events`.

## [1.4.0] - 2026-10-25

### Added
- **Targets** (year → month → week → day): hours (from linked missions or chosen categories), counts, done/not done or milestones; check-ins; roll-up to parents; an honest pace (ahead / on track / behind / at risk) against where you should be by now; *Break down* splits a target evenly over what is left.
- **Calendar tab** with the targets panel (bar = done, marker = expected, colour = pace) and Day / Week / Month views (✓ ◐ ✕, pins, rescue dots). Now shows "This week: X% of targets (expected Y%)". Missions and tasks get a *Counts toward* picker. Phones: Now, Plan, Calendar, Insights, More.
- **Guided logging**: the proof sheet records percent done, what is left (becomes a "Continue: …" task) and blockers, and offers *Log with Claude*. Finished focus blocks without a log get an amber dot.
- Connector: `get_goals`, `upsert_goals`, goals in `propose_week_plan`, `eos://goals`; `get_block_context` includes GitHub commits and PRs for the block.

## [1.3.0] - 2026-10-25

### Added
- **One-scan pairing.** Settings → Devices & sync on the PC shows one QR. The phone camera (browser) or the Android app's *Scan PC* pairs in seconds — no address, no PIN. Paired devices are listed with *Revoke*; optional "Require approval"; PIN pairing can be turned off. Deep link `executionos://pair`.
- **Automatic failover** between home Wi-Fi and Tailscale (same hub only, recognised by its hub id). The status pill shows the path in use.
- **Secure address** (Tailscale Serve, private HTTPS inside your tailnet) so the browser version works offline and installs on iPhone.
- **One-command install** for Windows (`scripts/install.ps1`, verifies SHA-256), `npm run setup` for developers (with `--service`, `--tailscale`), and `node build/server.cjs pair | doctor | connector`.
- **Settings → Health** (same checks as `doctor`) and a 5-step **welcome wizard** that can be reopened from Settings → About.

### Security
- A loopback request forwarded by a local proxy (Tailscale Serve and similar) is no longer treated as "this PC".

## [1.2.0] - 2026-10-25

### Added
- **AI connector (self-hosted MCP server).** Settings → AI connector: one switch starts a separate listener on `127.0.0.1:4748`; *Publish* exposes only that listener through Tailscale Funnel (`https://<pc>.ts.net:8443/mcp`). Claude (web, desktop, mobile) and Claude Code can read and operate Execution OS with a per-app token (shown once, stored as a SHA-256 hash, revocable).
- 19 tools: `get_overview`, `get_day`, `get_week`, `list_tasks`, `get_block_context`, `get_analytics`, `get_principles`, `list_proposals`, `get_playbook`, `add_tasks`, `set_mission`, `set_outcomes`, `pin_block`, `log_session` (requires the user's confirmation), `propose_day_plan`, `propose_week_plan`, `propose_rescue`, `apply_proposal`, `reject_proposal`. Resources `eos://principles`, `eos://today`, `eos://week`; prompts `plan_my_day`, `plan_my_week`, `rescue_my_day`, `log_my_execution`, `weekly_review`, `import_class_schedule`, `morning_brief`, `shutdown`.
- **AI activity** (Settings, every device): every AI call with one-tap Undo, refused when a later edit would be overwritten.
- Tray menu: *AI connector: On/Off* (off closes the listener and removes the Funnel).
- Security: no delete tools, strict input schemas with size caps, 256 KB request limit, 20 s per call, 50 KB results, rate limit 60/min/IP, 15-minute lockout after 10 failed tokens, Host-header check, no CORS, the sync API refuses connector tokens.

## [1.1.0] - 2026-10-25

### Added
- **Pinned blocks.** Pin any block of a day to its clock time (pin icon, or long-press / right-click → block sheet). "Add to this day" puts a specific task at a specific time, pinned by default. Rescue never moves, shortens or drops a pin.
- **Rescue v2.** Up to three strategies (Balanced, Protect study, Ship the deliverable, Light day), a before/after timeline with fixed blocks greyed, one sentence explaining every change, "Includes N pinned blocks", and *Apply for the week* (today's dropped missions move into this week's matching focus blocks). Priority-1 focus work goes into the hours where it usually succeeds (only with ≥ 50% history). Over-constrained days name the pins responsible.
- **Proposals.** Rescue plans (and, from v1.2, AI plans) arrive as reviewable proposals: banner on Now, review sheet with before/after per day, Apply for today / for the week / Reject. A proposal made against an older plan is re-checked, never applied blindly. Proposals expire at the end of their day or week.
- A *Rebuild* button on the day card opens Rescue at any time.
- Shared mutation layer (`src/core/ops.ts`): the app, the hub and future AI connector make identical, versioned edits.
- Feature flags (Settings → Labs) so every new feature can be switched off without reinstalling.
- Schema versioning with numbered migrations and an automatic `pre-migration-*` backup before any migration runs.
- Labelled backups that the 14-day rotation never deletes.
- Hub command line: `backup`, `restore <file>`, `info`, `version` (`node build/server.cjs <command>`).
- `npm run version:bump <major|minor|patch>` keeps package.json, Android versionName/versionCode and this file in step.
- Continuous integration on every push and pull request (typecheck, tests, build).

### Fixed
- An older hub no longer crashes when its database contains a collection written by a newer version (tolerant loader). This makes rolling back a release safe.
- The hub's revision counter is restored correctly when a write transaction fails.

## [1.0.0] - 2026-10-07

### Added
- First release: 24-hour master clock, one mission per block, drift detection, Rescue Mode, Wake Gate, Focus Guard (Windows watcher + browser extension), proof of work, weekly review, IF → THEN rules, local-first sync with the PC hub (SQLite, full history, daily backups), Windows EXE and Android APK.
