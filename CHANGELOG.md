# Changelog

All notable changes to Execution OS are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).
Every release has a git tag (`vX.Y.Z`); every phase of the v2 plan also has `pre-phase-N` and `phase-N-done` tags as rollback points.

## [Unreleased]

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
