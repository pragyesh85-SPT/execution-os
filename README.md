# Execution OS

**A personal 24-hour command system that always answers one question:**
*"Given what has actually happened today, what is the single best thing I should do right now?"*

Execution OS is not a calendar, an alarm app or a to-do list. It is a live clock of your whole day. It knows which block you are in, gives every block one clear mission, notices when you drift, and rebuilds the rest of the day when things go wrong instead of declaring it failed.

It runs on **Windows, Android and any browser**. Your own PC acts as the server and the database. There is no cloud account, no subscription and no telemetry.

> **Status:** v1.0, a working personal tool built for daily use. Expect rough edges.

---

## Why it was created

It was built for one person: a student-founder balancing university study, two startups, daily devotion and a fixed sleep schedule. A static timetable kept failing.

An alarm rings, gets dismissed, and the day slides. One late start breaks every block after it. Study has no protected time, so business work quietly eats it.

Execution OS changes the assumption. It does not assume "I know what to do, an alarm will remind me, I will do it." It assumes **you will sometimes oversleep, get distracted, or get absorbed in the wrong work**, and it is designed around that reality.

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
npm run dist:apk   # Android APK (debug-signed, for personal installs) -> release/
```

On Windows, `Build everything.bat` runs tests and builds both. Machine-specific settings go in `local-env.bat` (copy `local-env.example.bat`; it is git-ignored):

| Variable | Purpose |
|---|---|
| `EOS_BUILD_DIR` | Put build output and temp files on another drive |
| `EOS_ELECTRON_CACHE` | Where electron-builder caches the Electron download |
| `EOS_ANDROID_BUILD_DIR` | Gradle build output for the Android app |
| `EOS_JAVA_HOME`, `EOS_ANDROID_HOME`, `EOS_GRADLE_HOME` | JDK 21, Android SDK and Gradle cache locations |
| `EOS_PORT`, `EOS_DB` | Hub port (default 4747) and database file |

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

## Privacy and security

- All data stays on your devices and your PC. There is no account, no analytics and no third-party server.
- AI API keys are stored only on the device where you enter them and are never synced.
- Devices other than the hub PC must send the pairing PIN. Traffic on your local network is plain HTTP. Use Tailscale (encrypted) to reach the hub from outside your home network.

## Known limits (v1)

- Android cannot block other apps yet (that needs an accessibility service). It nudges with notifications and Focus Mode instead.
- The iPhone/web version loads its pages from the PC, so it needs the PC on. Offline use and push notifications on iPhone need HTTPS hosting.
- The default schedule, categories and labels reflect the author's own day (e.g. "IIT Jodhpur", devotion blocks). Everything is editable in the **Clock** and **Settings** screens.
- The APK is debug-signed for personal installs. It is not a Play Store build.

## License

[MIT](LICENSE) © 2026 Pragyesh Jain
