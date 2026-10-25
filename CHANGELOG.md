# Changelog

All notable changes to Execution OS are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).
Every release has a git tag (`vX.Y.Z`); every phase of the v2 plan also has `pre-phase-N` and `phase-N-done` tags as rollback points.

## [Unreleased]

### Added
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
