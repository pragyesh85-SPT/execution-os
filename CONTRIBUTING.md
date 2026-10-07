# Contributing to Execution OS

Thanks for considering a contribution. Execution OS is a small, opinionated, single-person system. Contributions are welcome as long as they keep it that way.

## Ground rules (the design is the product)

Please read [docs/PHILOSOPHY.md](docs/PHILOSOPHY.md) first. A pull request should not break these rules:

1. **Rules decide *when*, AI only suggests *what*.** No feature may let an AI model move anchors, sleep or protected minimums.
2. **Never carry lateness forward.** Schedule repairs go through Rescue Mode (`src/core/rescue.ts`), not by shifting every block.
3. **Local-first.** No required account, cloud service or telemetry. Everything must keep working offline on a device.
4. **No silent overwrites.** Sync changes must preserve the three-way merge and the user-decided conflicts (`src/core/sync.ts`).
5. **No streaks, badges, XP or fake urgency.**
6. **Calm UI.** Use the existing tokens in `src/styles/app.css`: one accent, one radius, two shadow levels. Motion confirms user actions (150–300 ms ease-out) and respects the Motion setting.
7. **Escape hatches need deliberate effort.** Anything that bypasses the Wake Gate or Focus Guard must take intent, not one tap.

## Setup

```bash
npm install
npm run build      # web app + hub + Electron bundles
npm run serve      # hub on http://localhost:4747
npm run dev        # live-reloading UI on http://localhost:5173
npm test           # must stay green
npm run typecheck
```

- Requirements: Node.js 22.5+ (24 recommended). The Android app needs JDK 21 and the Android SDK; see the README for the build variables.
- **Never point a dev or test hub at your real database.** Use `node scripts/e2e-hub.cjs` (port 4799, a throwaway database in your temp folder), or set `EOS_DB`.

## Where things live

| Change | Place |
|---|---|
| Scheduling logic, drift, scoring, stats | `src/core/` (pure TypeScript, no DOM, no Node) |
| Sync protocol | `src/core/sync.ts` (planner) · `src/state/sync.ts` (device) · `server/db.ts` (hub) |
| UI | `src/screens/`, `src/overlays/`, `src/components/` |
| Windows-only behaviour | `electron/` |
| Android-only behaviour | `android/` and `src/lib/notify.ts` |
| Focus Guard extension | `extension/` |

Logic belongs in `src/core/` with a test in `tests/`. UI components should stay thin.

## Pull requests

- Keep each PR to one concern, and explain the *why* in the description.
- Add or update tests for any change to `src/core/` or `server/`.
- Include a screenshot or short clip for UI changes, in light and dark themes.
- Make sure `npm test` and `npm run typecheck` pass.
- No new runtime services, trackers or remote calls without discussing them in an issue first.

## Good first contributions

- Translations of the UI.
- Accessibility: keyboard paths, screen-reader labels, contrast.
- A neutral starter template (the default clock reflects the author's own day).
- Android app blocking during focus blocks (accessibility service).
- Google Calendar / Gmail import into the planner context.

## License

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
