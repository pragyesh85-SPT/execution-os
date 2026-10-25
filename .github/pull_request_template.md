## What and why

<!-- One concern per pull request. Explain the why. -->

## Phase acceptance checklist

<!-- Paste the phase's acceptance criteria from the implementation guide and tick each box, or explain. -->

- [ ] Spec implemented; deviations listed and approved by the owner
- [ ] `npm run typecheck`, `npm test`, `npm run build` green locally and in CI
- [ ] New pure logic in `src/core` with unit tests; hub/API changes with integration tests
- [ ] Feature flag present and defaulting as specified; turning it off hides the feature and keeps data
- [ ] No new secret in the repository; no new public port
- [ ] README and CHANGELOG updated; screenshots updated where UI changed
- [ ] Rollback tag created (`pre-phase-N`); previous release still downloadable
- [ ] Manual check performed on Windows and Android (or listed for the owner)
