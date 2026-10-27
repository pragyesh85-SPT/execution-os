import type { Migration } from '../migrations';

// Schema of study.db (the Study OS store inside the vault). Same rules as the hub database:
// numbered, run in order inside one transaction, and an existing file is copied to
// .backups/pre-migration-v{from}-to-v{to}-*.db before any of them runs.
//
//   meta      schema version and small settings
//   files     every vault file the indexer has seen (hash, kind, parse error)
//   items     parsed vault files: concepts, paths, packs, labs, questions, syllabus, assessment, tests
//   assets    IITJ originals copied in by ingestion (hash-deduplicated)
//   events    evidence — the only thing that moves mastery (append-only)
//   sessions  Study OS sessions and their Execution OS session
//   verdicts  every Quick Tutor verdict with the raw answer, and Claude's re-grade
//   tests     3-day tests: status, submissions, grading, report
//   jobs      headless Claude runs (ok / failed, log path)
//   proposals graph or path changes proposed through MCP
//   audit     every AI change to the vault, with the file content before it (undo)
//   spend     Quick Tutor spend per month

export const STUDY_MIGRATIONS: Migration[] = [
  {
    to: 1,
    name: 'study-v1',
    up: (db) =>
      db.exec(`
        CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, hash TEXT NOT NULL, kind TEXT, error TEXT, at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS items (kind TEXT NOT NULL, id TEXT NOT NULL, subject TEXT, file TEXT NOT NULL, data TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (kind, id));
        CREATE INDEX IF NOT EXISTS items_file ON items (file);
        CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY, subject TEXT, week INTEGER, type TEXT NOT NULL, title TEXT NOT NULL, original TEXT, path TEXT NOT NULL, extracted TEXT, sha TEXT NOT NULL UNIQUE, needs_claude INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL, concept TEXT, session TEXT, source TEXT NOT NULL, data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS events_concept ON events (concept, at);
        CREATE INDEX IF NOT EXISTS events_kind ON events (kind, at);
        CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, kind TEXT NOT NULL, concept TEXT, test_id TEXT, start INTEGER NOT NULL, end INTEGER, last_activity INTEGER NOT NULL, drift_marked INTEGER NOT NULL DEFAULT 0, eos_session TEXT, eos_date TEXT, eos_block TEXT, summary TEXT);
        CREATE TABLE IF NOT EXISTS verdicts (id TEXT PRIMARY KEY, at INTEGER NOT NULL, concept TEXT NOT NULL, kind TEXT NOT NULL, question TEXT, answer TEXT NOT NULL, verdict TEXT NOT NULL, provider TEXT NOT NULL, confidence TEXT NOT NULL, final TEXT, audited_at INTEGER);
        CREATE TABLE IF NOT EXISTS tests (id TEXT PRIMARY KEY, status TEXT NOT NULL, started INTEGER, submitted INTEGER, graded INTEGER, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS jobs (seq INTEGER PRIMARY KEY AUTOINCREMENT, job TEXT NOT NULL, ok INTEGER NOT NULL, started INTEGER, ended INTEGER NOT NULL, log TEXT, note TEXT);
        CREATE TABLE IF NOT EXISTS proposals (id TEXT PRIMARY KEY, at INTEGER NOT NULL, client TEXT, kind TEXT NOT NULL, title TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, decided INTEGER);
        CREATE TABLE IF NOT EXISTS audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, before TEXT, after TEXT, undone INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS spend (month TEXT PRIMARY KEY, usd REAL NOT NULL, calls INTEGER NOT NULL);
      `),
  },
];
