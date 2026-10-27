# Study OS — decisions taken during the build

The build ran unattended. Wherever the architecture left something open, the most reasonable option
was picked and written here. Each entry: the decision, then why. Change any of them by editing the
named file; none of them changes the concept.

## Process

- **D-01 Phase cut.** The architecture's build-plan diagram (P0–P3) did not survive the Markdown export.
  The phases were cut from the document's own sections: P0 foundations, P1 ingestion + learning engine,
  P2 Quick Tutor + labs + 3-day test + headless jobs, P3 surfaces (Study tab, phone, MCP, portfolio).
  *Why:* each phase is testable on its own and the later ones only add surfaces on top of the engine.
- **D-02 Pushing.** The original brief said "never push"; the owner later allowed pushing with version
  control. Only the `feature/study-os` branch and the `pre-study-os` / `study-pN-done` tags are pushed.
  Nothing is merged into `main` and no release is created (the release workflow only fires on `v*` tags).

## Data and storage

- **D-03 Flag default off.** `study` defaults to off, unlike shipped v2 flags. *Why:* "with the flag off,
  Execution OS behaves exactly as today".
- **D-04 `study.db` lives in the vault** (`<vault>/study.db`, git-ignored), with backups in
  `<vault>/.backups/` (14 daily kept, labelled pre-migration copies never pruned). *Why:* the vault is
  the Study store on the PC; keeping the database beside its files makes the vault self-contained.
- **D-05 Vault path.** Default `C:\StudyOS` on Windows (`~/StudyOS` elsewhere). The hub remembers it in
  its own meta table (`study.vault`, PC only, never synced); `EOS_STUDY_VAULT` overrides it.
- **D-06 One synced record.** Execution OS gets a new synced collection `study` that only ever holds
  `study/summary`. Adding a collection needs no hub migration (the loader already ignores unknown
  collections, and older apps skip it), so no Execution OS schema version was bumped. `study.db` has
  its own migration list and pre-migration backups.
- **D-07 YAML.** Vault files are YAML / Markdown with YAML front matter, parsed with `js-yaml` (pinned as
  a dev dependency and bundled into the hub; it was already in the tree). *Why:* Claude writes YAML
  reliably and the owner can read it.
