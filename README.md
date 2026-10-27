# Execution OS

**A personal 24-hour command system that always answers one question:**
*"Given what has actually happened today, what is the single best thing I should do right now?"*

Execution OS is not a calendar, an alarm app or a to-do list. It is a live clock of your whole day. It knows which block you are in, gives every block one clear mission, notices when you drift, and rebuilds the rest of the day when things go wrong instead of declaring it failed.

It runs on **Windows, Android and any browser**. Your own PC acts as the server and the database. There is no cloud account, no subscription and no telemetry.

> **Status:** v1.0, a working personal tool built for daily use. Expect rough edges.

**[Who it's for](#who-should-use-it) · [Why](#why-use-it-instead-of-a-calendar-a-to-do-list-or-a-timer) · [Principles](#the-principles-in-one-screen) · [Features](#what-it-does) · [How it works](#how-it-works) · [Get started](#getting-started) · [Philosophy](docs/PHILOSOPHY.md) · [Contribute](CONTRIBUTING.md)**

---

## Why it was created

It was built for one person: a student-founder balancing university study, two startups, daily devotion and a fixed sleep schedule. A static timetable kept failing.

An alarm rings, gets dismissed, and the day slides. One late start breaks every block after it. Study has no protected time, so business work quietly eats it.

Execution OS changes the assumption. It does not assume "I know what to do, an alarm will remind me, I will do it." It assumes **you will sometimes oversleep, get distracted, or get absorbed in the wrong work**, and it is designed around that reality.

---

## Who should use it

Execution OS is for people whose problem is not *knowing* what to do, but *doing it at the right time, every day*.

- **Students with a second life.** You study (online degree, university, exam prep) while also running a business, a job or a big side project, and study keeps losing to the work that feels more urgent.
- **Solo founders and indie builders** splitting one day across several products, who need deep-work blocks protected from admin, email and context switching.
- **People with non-negotiable anchors.** Prayer or devotion, gym, family time, caregiving, a fixed sleep window: blocks that must happen at a set time, with everything else arranged around them.
- **People who dismiss alarms and drift.** You have tried calendars, to-do apps and Pomodoro timers. They tell you the plan but do nothing when the plan breaks at 10:17 AM.
- **People who want to own their data.** No account, no subscription, no cloud. Your PC is the server; your phone and laptop work offline.
- **Developers who like hackable, local-first software.** One TypeScript codebase for web, Windows and Android, a readable sync protocol, SQLite on your own machine and a test suite. Fork it and make it yours.

## Who it is *not* for

Be honest with yourself before installing.

- **Teams.** There is no sharing, no assignments, no shared calendar. It is a single-person system.
- **Fully reactive work.** If your day is decided by incoming tickets, on-call pages or customers walking in, time blocks will fight your job.
- **Anyone looking for gamification.** There are no streaks, badges, XP or leaderboards, on purpose (see [Philosophy](docs/PHILOSOPHY.md)).
- **iPhone-only users who want hard blocking.** On iPhone it runs as a home-screen web app and cannot block other apps.
- **Anyone wanting a polished commercial product.** This is a v1 personal tool, shared openly. It works daily for its author, but you will find rough edges.

## Why use it instead of a calendar, a to-do list or a timer

| | Calendar | To-do app | Pomodoro timer | **Execution OS** |
|---|:---:|:---:|:---:|:---:|
| Tells you what to do *right now* | partly | no | no | **yes** — one mission per block |
| Notices you have not started | no | no | no | **yes** — drifting → rescue |
| Repairs the day when you are late | no | no | no | **yes** — Rescue Mode |
| Protects minimums (sleep, study) | no | no | no | **yes** |
| Makes distraction harder | no | no | no | **yes** — Focus Guard |
| Gets you out of bed | alarm only | no | no | **yes** — QR wake gate |
| Learns which slots actually work | no | no | no | **yes** — weekly review |
| Works offline, data on your own machine | rarely | rarely | yes | **yes** |

## The principles in one screen

1. **Answer one question:** what is the single best thing to do *now*? Everything in the interface serves that.
2. **Rules decide *when*. AI only suggests *what*.** The clock is the authority; the AI is a strategist that can never move your sleep or your study block.
3. **Never carry lateness forward.** A missed hour is not pushed through every later block. The rest of the day is rebuilt to be feasible.
4. **Protect, don't maximise.** Sleep, devotion and a study minimum are defended first. Low-priority work is trimmed first.
5. **Missions, not activities.** "Study" is not a plan. "Finish Assignment 3, Q1–Q5" is.
6. **Environment beats willpower.** A QR card across the room and a blocked site beat a promise to yourself.
7. **Decide in advance.** IF → THEN rules turn decisions into defaults before the moment of weakness.
8. **Proof over presence.** Eight hours at a desk is not eight hours of work. Record what actually got done.
9. **Adherence, not streaks.** One missed day does not break anything. The trend matters, not the chain.
10. **One change per week.** Observe → measure → adjust → repeat. Not ten changes at once.
11. **Entertainment gets a budget, not a ban.** A planned movie is part of the schedule; an accidental three hours is not.
12. **Your data, your machine.** Local-first, no telemetry, and no silent overwrites between devices.

The reasoning behind each principle is in **[docs/PHILOSOPHY.md](docs/PHILOSOPHY.md)**.

---

## What it does

| | |
|---|---|
| **Live 24-hour clock** | Every block of the day (sleep, devotion, study, deep work, meals, care) on one dial, with a "now" hand and a live countdown. |
| **One mission per block** | Not "study" but "Finish Assignment 3, Q1–Q5". Plus **3 daily outcomes**. Everything else is secondary. |
| **On track → Drifting → Rescue** | The status turns amber when a focus block is not started on time and red when it is badly missed. |
| **Rescue Mode** | Rebuilds the rest of the day. Fixed anchors stay put, protected minimums (e.g. 2 h of study) are kept, and low-priority work is trimmed. Lateness is never carried forward block by block. Missions that no longer fit go back to the task inbox. |
| **Wake Gate** | The morning alarm (an escalating temple bell) only stops when you scan a printed QR card placed away from your bed, or type its code. The emergency bypass needs deliberate effort. |
| **Focus Guard** | Blocks distracting sites during focus blocks (Chrome/Edge extension). The Windows app notices when Netflix/YouTube stays in the foreground. Urges can be "parked" in a Later list. |
| **Proof of work** | At the end of a focus block: Completed / Partially / Didn't start, plus a note and links. GitHub commits and PRs made during the block are detected automatically. |
| **IF → THEN rules** | Implementation intentions that run automatically ("IF I miss 20 minutes of a study block THEN open Rescue Mode"). |
| **Weekly review** | Adherence (not streaks), success rate per time slot, your strongest work window, and **one** recommended change for next week. |
| **Entertainment budget** | Movies and videos are allowed as planned exceptions drawn from a weekly budget, not as accidents. |
| **AI planner (optional)** | Picks the highest-value mission for each block from your task inbox. It works with Claude, OpenAI, Gemini or any OpenAI-compatible endpoint. Without a key there is a built-in smart fill, and a copy-prompt → paste-reply flow for any chat AI. **The rules decide when; the AI only suggests what.** |

---

## New in v2

| | |
|---|---|
| **Pinned blocks + Rescue v2** | "4–5 PM is for this task" means 4–5 PM. Rescue rebuilds everything else around pins and anchors, explains every change in one sentence, offers up to three strategies (Balanced, Protect study, Ship, Light day) and can apply for today or the whole week. |
| **Proposals** | Rescue and AI plans arrive as a reviewable proposal (banner on Now). Nothing structural changes silently; a proposal made against an older plan is re-checked first. |
| **AI connector (MCP)** | Claude (web, desktop, mobile, Claude Code) — and ChatGPT or other MCP clients through sign-in — can read your day, plan it, rescue it, add tasks, log sessions you confirm and import classes. Every AI change is listed under **AI activity** with Undo. In Claude, proposals show as an interactive card. |
| **One-scan pairing** | Scan one QR on the PC and the phone is set up — no address, no PIN. It switches between home Wi-Fi and Tailscale by itself. |
| **Targets + Calendar** | Year → month → week → day targets with an honest pace, and Day / Week / Month views of what actually happened. |
| **Insights + Coach** | Plan-versus-reality analytics and a weekly grade the AI cannot round up, with one IF → THEN change you add with one tap. |
| **Class imports** | Classes become pinned blocks with a Join button and a reminder; re-imports never duplicate. |
| **Setup, health, updates** | One-line Windows install, `doctor` health checks, a welcome wizard, auto-update and signed releases. |

Every v2 feature can be switched off in **Settings → Labs** (nothing is deleted).

### Connect Claude (once)

1. Settings → **AI connector** → switch on → **Publish** (uses Tailscale Funnel; only the connector is public, behind your token — the sync hub never is).
2. **Copy link** and **Copy token for Claude**.
3. Claude → Settings → Connectors → *Add custom connector*: name `Execution OS`, URL = the link, request header `Authorization: Bearer <token>`. (Apps that support sign-in only need the link; approve them under *Connected AI apps*.)
4. In a chat: "+" → Connectors → enable Execution OS; reads *Always allow*, writes *Ask*. Try "What's my current block in Execution OS?".
5. Claude Code on this PC: `claude mcp add --transport http execution-os http://127.0.0.1:4748/mcp --header "Authorization: Bearer <token>"`.

Turn it off any time from Settings or the tray (*AI connector: Off*).

### If something goes wrong (rollback)

| Situation | What to do |
|---|---|
| A new feature misbehaves | Settings → Labs → switch it off. Nothing is deleted. |
| The AI did something unwanted | Settings → AI activity → *Undo*. To stop all AI access: tray → *AI connector: Off*. |
| A whole release is bad | Install the previous version from GitHub Releases over it. Data stays in `%APPDATA%\execution-os`; older versions open newer databases safely. |
| Data looks wrong after an update | Quit the app (tray → Quit), then `node build/server.cjs restore "%APPDATA%\execution-os\backups\pre-migration-….db"`. Phones re-sync. |
| One record is wrong | Its full history is kept (`/api/history`); restore the version you want. |
| Code rollback | Every release has a git tag (`v1.1.0` … `v2.0.0`) and every phase `pre-phase-N` / `phase-N-done`. |

## How it works

```
                 ┌──────────────────────────────────────────┐
                 │  YOUR PC — the hub                       │
                 │  • serves the app on your network        │
                 │  • SQLite database (single source of     │
                 │    truth, full version history,          │
                 │    daily backups)                        │
                 └──────────────┬───────────────────────────┘
          home Wi-Fi / Tailscale│(pairing PIN for other devices)
        ┌───────────────────────┼───────────────────────┐
   Windows app             Android app            Browser / iPhone
   (runs the hub)          (works offline)        (home-screen web app)
```

- **The PC is the database.** The Windows app (or `npm run serve`) runs a small HTTP hub that stores everything in one SQLite file (`%APPDATA%\execution-os\execution-os.db`). It keeps every version of every record, with the device it came from, and makes a daily backup (last 14 kept).
- **Every device is offline-first.** Each device keeps a full local copy. When the PC is off or out of reach, edits are saved locally and queued. When it is reachable again, they upload automatically.
- **No silent overwrites.** Sync compares each record three ways: the last shared version, this device, and the PC. If different fields changed, they are merged automatically. If the *same* field changed differently on two devices, the user is asked which version to keep. The hub only accepts an edit if it was based on its latest version, and device clocks are never trusted to pick a winner.
- **Reach your PC from anywhere** with [Tailscale](https://tailscale.com) (free for personal use). Requests from other devices must carry the 6-digit pairing PIN.

---

## Getting started

### Requirements

- **Node.js 22.5+** (24 recommended; the hub uses the built-in `node:sqlite`)
- Windows 10/11 for the desktop app (the web hub and the UI also run on macOS/Linux)
- For the Android app: **JDK 21** and the **Android SDK** (platform 36)

### Install on Windows (one line)

```powershell
powershell -ExecutionPolicy Bypass -NoProfile -Command "irm https://raw.githubusercontent.com/pragyesh85-SPT/execution-os/main/scripts/install.ps1 | iex"
```

It downloads the latest release, verifies its SHA-256, installs it silently, offers Tailscale, and opens the welcome wizard. Developers: `npm run setup` (add `-- --service` to start the hub at logon, `-- --tailscale` for a private HTTPS address). Health: `node build/server.cjs doctor` or Settings → Health.

### Run it (web + local hub)

```bash
npm install
npm start          # builds everything and starts the hub on http://localhost:4747
```

Open http://localhost:4747. Other devices on your network use the address and PIN shown under **Settings → Devices & sync**.

### Develop

```bash
npm run serve      # hub + database on :4747 (after one `npm run build`)
npm run dev        # live-reloading UI on http://localhost:5173 (proxies /api to the hub)
npm test           # unit + integration tests (rules engine, rescue, sync, database)
npm run typecheck
```

### Build the apps

```bash
npm run dist:exe   # Windows installer + portable EXE  -> release/
npm run dist:apk   # Android APK -> release/ (release-signed when EOS_KEYSTORE* is set, otherwise debug-signed)
```

On Windows, `Build everything.bat` runs tests and builds both. Machine-specific settings go in `local-env.bat` (copy `local-env.example.bat`; it is git-ignored):

| Variable | Purpose |
|---|---|
| `EOS_BUILD_DIR` | Put build output and temp files on another drive |
| `EOS_ELECTRON_CACHE` | Where electron-builder caches the Electron download |
| `EOS_ANDROID_BUILD_DIR` | Gradle build output for the Android app |
| `EOS_JAVA_HOME`, `EOS_ANDROID_HOME`, `EOS_GRADLE_HOME` | JDK 21, Android SDK and Gradle cache locations |
| `EOS_PORT`, `EOS_DB` | Hub port (default 4747) and database file |

### Backups, restore and emergency tools

The hub keeps one backup per day for 14 days in `%APPDATA%\execution-os\backups`, plus labelled copies that are never rotated away (`pre-migration-*` before any database upgrade, `pre-restore-*` before any restore, `manual-*` when you ask for one).

```bash
node build/server.cjs info              # database path, records, schema version, backups, is the hub running?
node build/server.cjs backup            # write backups/manual-<time>.db (safe while the app runs)
node build/server.cjs restore <file.db> # replace the database with a backup (quit the app first;
                                        # the current database is saved as backups/pre-restore-<time>.db)
node build/server.cjs version
```

Set `EOS_DB` to point any command at another database file. A new feature that misbehaves can be switched off in **Settings → Labs** without reinstalling; nothing is deleted.

### Browser extension (Focus Guard)

Chrome/Edge → `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select the `extension/` folder. It asks the hub every 30 seconds whether a focus block is active. If the hub cannot be reached, nothing is blocked (it fails open).

---

## Project structure

```
src/core/        Rules engine — pure TypeScript shared by every platform:
                 schedule, drift detection, Rescue Mode, day score, weekly stats,
                 planner prompts, three-way sync merge
src/screens/     Now · Plan · Clock · Review · Rules · Settings
src/overlays/    Focus Mode, Wake Gate, Rescue, Proof of work, conflict resolution
src/state/       Store, device sync, 1-second runtime (block changes, alarms, rules)
src/lib/         AI providers, notifications, synthesized sounds, GitHub proof, platform bridges
server/          The hub: HTTP API + SQLite database (history, backups, pairing PIN)
electron/        Windows shell: tray, wake alarm, foreground-window Focus Guard
android/         Capacitor Android project (exact alarms, camera for the wake QR)
extension/       Chrome/Edge Focus Guard (Manifest V3)
tests/           Vitest: engine, rescue, sync protocol, hub + database integration
```

**Stack:** React 19, TypeScript, Motion, Zustand, Vite · Node `http` + `node:sqlite` · Electron · Capacitor 8 · Vitest.

---

## Research it builds on

Execution OS turns a handful of well-replicated findings into mechanisms. They are not used as decoration.

| Finding | Where it shows up |
|---|---|
| Deciding *"when X happens, I do Y"* in advance has a medium-to-large effect on goal attainment, across 94 independent tests — Gollwitzer & Sheeran (2006) | IF → THEN rules |
| Habit automaticity took 18–254 days in a real-world study, and a single missed day did not materially derail it — Lally et al. (2010) | Adherence % instead of streaks; no punishment for one bad day |
| Procrastination is linked to task aversiveness, delay, low self-efficacy, distractibility and impulsiveness — Steel (2007) | One concrete mission per block; small steps; distractions made harder to reach |
| Blocking distracting sites increased self-rated productivity and focus duration, most for people distracted by social media — Mark, Czerwinski & Iqbal (2017) | Focus Guard (extension + Windows watcher) |
| Switching between tasks has a measurable cost that grows with task complexity — Rubinstein, Meyer & Evans (2001) | Long single-purpose blocks; one mission at a time |
| Time-management behaviour is moderately related to performance, academic achievement and well-being — Aeon, Faber & Panaccio (2021) | The whole premise: structure helps, when it is maintained |
| Adults need ≥ 7 h of sleep; teenagers 8–10 h — AASM consensus statements (Watson et al. 2015; Paruthi et al. 2016) | Sleep is a fixed anchor; the clock editor warns below 7 h |

Full references are in [docs/PHILOSOPHY.md](docs/PHILOSOPHY.md#references).

## Contributing

Issues and pull requests are welcome, especially:
- iOS and Android blocking;
- calendar and email integrations;
- translations;
- accessibility.

Read **[CONTRIBUTING.md](CONTRIBUTING.md)** first. It explains the setup and the few design rules a change must respect.

## Privacy and security

- All data stays on your devices and your PC. There is no account, no analytics and no third-party server.
- AI API keys are stored only on the device where you enter them and are never synced.
- Devices other than the hub PC must be paired (one-scan device token, revocable) or send the pairing PIN. Traffic on your local network is plain HTTP. Use Tailscale (encrypted) to reach the hub from outside your home network, or turn on the private HTTPS address.
- The AI connector is off by default. It listens on `127.0.0.1:4748` only and reaches the internet only through Tailscale Funnel when you publish it, behind a token or an approved sign-in. It has no delete tools, validates every input, rate-limits, audits every call and offers Undo. The sync API (port 4747) is never published.

## Known limits

- Android cannot block other apps yet (that needs an accessibility service). It nudges with notifications and Focus Mode instead.
- The iPhone/web version loads its pages from the PC. With the private HTTPS address (Tailscale Serve) it can be installed and works offline; push notifications on iPhone are not supported.
- Claude reaches the AI connector only while the PC is on and awake.
- The default schedule, categories and labels reflect the author's own day (e.g. "IIT Jodhpur", devotion blocks). Everything is editable in the **Clock** and **Settings** screens.
- The APK is not a Play Store build, and the Windows EXE is not code-signed (SmartScreen warns once).

## License

[MIT](LICENSE) © 2026 Pragyesh Jain

---

## Study OS (Labs)

An optional study module, switched off by default (Settings → Labs → **Study OS**). It turns a course's
material into a queue of short lessons from world-class open resources, instant checks graded against
packs written in advance by Claude, Python labs with hidden tests, a cumulative test every 3 days and an
honest pace meter — and pushes every study session into Execution OS. All study data lives in a private
**Study Vault** folder on your PC; only a small daily summary syncs to your phone.

- Start here: [docs/study-os/BUILD_REPORT.md](docs/study-os/BUILD_REPORT.md) (setup, step by step)
- Design: [docs/study-os/ARCHITECTURE.md](docs/study-os/ARCHITECTURE.md) · decisions: [docs/study-os/DECISIONS.md](docs/study-os/DECISIONS.md)
- Command line: `npm run build:node`, then `npm run study -- help`
