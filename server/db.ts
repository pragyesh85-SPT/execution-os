import './quiet';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { randomInt } from 'node:crypto';
import { dirname, join } from 'node:path';
import { normalizeDoc } from '../src/core/merge';
import { allKeys, getRec, sameRec, setRec, splitKey, type Change, type RecCol } from '../src/core/sync';
import { COLLECTIONS, type Doc, type Synced } from '../src/core/types';
import { latestVersion, MIGRATIONS, runMigrations, type Migration, type MigrationRun } from './migrations';

// The PC database: one SQLite file is the single source of truth for every device.
//   records — the current version of every record (one row per record)
//   history — every version ever accepted, with which device sent it (nothing is ever lost)
//   meta    — hub revision counter, pairing PIN, schema version
// An in-memory copy of the doc is kept for fast reads; every write goes to disk first.
// Rows in collections this version does not know (written by a newer version) are left
// untouched on disk and skipped on load, so rolling back to an older release is safe.

export interface PushResult {
  rev: number;
  accepted: number;
  rejected: { col: RecCol; id: string }[];
}

export interface MutateResult<R> {
  result: R;
  changed: string[]; // record keys "col/id"
  revBefore: number;
  rev: number;
}

export interface HubDbOptions {
  migrations?: Migration[];
}

const KNOWN = new Set<string>(['settings', 'template', ...COLLECTIONS]);

export const fileStamp = (d = new Date()) =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;

export class HubDb {
  readonly file: string;
  readonly backupDir: string;
  private db: DatabaseSync;
  rev = 0;
  pin = '';
  doc: Doc;
  readonly migration: MigrationRun;

  constructor(file: string, legacyJson?: string, opts: HubDbOptions = {}) {
    this.file = file;
    this.backupDir = join(dirname(file), 'backups');
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS records (col TEXT NOT NULL, id TEXT NOT NULL, r INTEGER NOT NULL, u INTEGER NOT NULL, del INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL, PRIMARY KEY (col, id));
      CREATE TABLE IF NOT EXISTS history (seq INTEGER PRIMARY KEY AUTOINCREMENT, col TEXT NOT NULL, id TEXT NOT NULL, r INTEGER NOT NULL, u INTEGER NOT NULL, device TEXT, at INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS history_rec ON history (col, id, seq);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    this.rev = Number(this.getMeta('rev') ?? 0);
    this.pin = this.getMeta('pin') ?? '';
    if (!this.pin) {
      this.pin = String(randomInt(100000, 999999));
      this.setMeta('pin', this.pin);
    }

    const list = opts.migrations ?? MIGRATIONS;
    const count = (this.db.prepare('SELECT COUNT(*) AS n FROM records').get() as { n: number }).n;
    if (count === 0) {
      this.seed(legacyJson);
      // A file seeded by this version is already in the latest layout.
      if (!this.getMeta('schemaVersion')) this.setMeta('schemaVersion', String(latestVersion(list)));
    }
    const current = Number(this.getMeta('schemaVersion') ?? 1);
    if (!this.getMeta('schemaVersion')) this.setMeta('schemaVersion', '1');
    try {
      this.migration = runMigrations(
        this.db,
        current,
        list,
        (from, to) => this.backupNow(`pre-migration-v${from}-to-v${to}`),
        (v) => this.setMeta('schemaVersion', String(v)),
      );
    } catch (e) {
      this.db.close(); // never leave the file locked after a failed start
      throw e;
    }
    this.doc = this.load();
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string) {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  deleteMeta(key: string) {
    this.db.prepare('DELETE FROM meta WHERE key = ?').run(key);
  }

  get schemaVersion(): number {
    return Number(this.getMeta('schemaVersion') ?? 1);
  }

  /** Direct access for hub-private tables (devices, audit). Never use it for user records. */
  get sql(): DatabaseSync {
    return this.db;
  }

  /** First start: import the old JSON store if there is one, otherwise start from defaults. */
  private seed(legacyJson?: string) {
    let source = normalizeDoc(null);
    let pin: string | undefined;
    if (legacyJson && existsSync(legacyJson)) {
      try {
        const raw = JSON.parse(readFileSync(legacyJson, 'utf8')) as { doc?: Doc; pin?: string };
        source = normalizeDoc(raw.doc);
        pin = raw.pin;
        renameSync(legacyJson, `${legacyJson}.migrated-${Date.now()}`);
      } catch {
        /* unreadable legacy file: start fresh, leave it in place */
      }
    }
    if (pin) {
      this.pin = pin;
      this.setMeta('pin', pin);
    }
    this.db.exec('BEGIN');
    try {
      for (const key of allKeys(source)) {
        const { col, id } = splitKey(key);
        const rec = getRec(source, col, id);
        if (rec) this.write(col, id, rec, 'migration');
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      this.rev = Number(this.getMeta('rev') ?? 0);
      throw e;
    }
  }

  private load(): Doc {
    const doc = normalizeDoc(null);
    const rows = this.db.prepare('SELECT col, id, data FROM records').all() as { col: RecCol; id: string; data: string }[];
    for (const row of rows) {
      if (!KNOWN.has(row.col)) continue; // written by a newer version: keep on disk, ignore here
      setRec(doc, row.col, row.id, JSON.parse(row.data) as Synced);
    }
    return doc;
  }

  /** Store a new version. Caller manages the transaction. */
  private write(col: RecCol, id: string, record: Synced, device: string): Synced {
    this.rev++;
    const rec = { ...record, id: col === 'settings' || col === 'template' ? col : id, r: this.rev } as Synced;
    const data = JSON.stringify(rec);
    const now = Date.now();
    this.db
      .prepare(
        'INSERT INTO records (col, id, r, u, del, data) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(col, id) DO UPDATE SET r = excluded.r, u = excluded.u, del = excluded.del, data = excluded.data',
      )
      .run(col, id, rec.r!, rec.u ?? 0, rec.del ? 1 : 0, data);
    this.db.prepare('INSERT INTO history (col, id, r, u, device, at, data) VALUES (?, ?, ?, ?, ?, ?, ?)').run(col, id, rec.r!, rec.u ?? 0, device, now, data);
    this.setMeta('rev', String(this.rev));
    setRec(this.doc ?? normalizeDoc(null), col, id, rec);
    return rec;
  }

  /** After a failed transaction: bring the in-memory copy and counter back in step with disk. */
  private resync() {
    this.rev = Number(this.getMeta('rev') ?? 0);
    this.doc = this.load();
  }

  /**
   * Accept changes from a device. A change is accepted only if it was based on the version
   * the hub currently holds — otherwise someone else changed it first, and the device must
   * merge (or ask the user) before trying again.
   */
  push(changes: Change[], device: string): PushResult {
    const rejected: PushResult['rejected'] = [];
    let accepted = 0;
    this.db.exec('BEGIN');
    try {
      for (const ch of changes) {
        // A newer device may send a collection this hub version does not know yet: skip it
        // (the device keeps it locally and retries on a later cycle, after the hub is updated).
        if (!KNOWN.has(ch.col)) continue;
        const current = getRec(this.doc, ch.col, ch.id);
        const currentR = current?.r ?? 0;
        if (current && sameRec(current, ch.record)) continue; // already identical
        if (currentR !== ch.baseR) {
          rejected.push({ col: ch.col, id: ch.id });
          continue;
        }
        this.write(ch.col, ch.id, ch.record, device);
        accepted++;
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      this.resync();
      throw e;
    }
    return { rev: this.rev, accepted, rejected };
  }

  /**
   * Run a pure op (src/core/ops.ts) against a copy of the doc and persist every record it changed,
   * atomically, with full history under `device`. This is the only way hub-side code writes user data.
   */
  mutate<R>(op: (d: Doc, now: number) => R, device: string): MutateResult<R> {
    const before = this.doc;
    const revBefore = this.rev;
    const draft = structuredClone(before);
    const now = Date.now();
    const result = op(draft, now);
    const changed = allKeys(before, draft).filter((k) => {
      const { col, id } = splitKey(k);
      const next = getRec(draft, col, id);
      return !!next && !sameRec(getRec(before, col, id), next);
    });
    if (!changed.length) return { result, changed, revBefore, rev: this.rev };
    this.db.exec('BEGIN');
    try {
      for (const k of changed) {
        const { col, id } = splitKey(k);
        this.write(col, id, getRec(draft, col, id)!, device);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      this.resync();
      throw e;
    }
    return { result, changed, revBefore, rev: this.rev };
  }

  /** Put an earlier version of a record back (used by undo). Writes a new version; history keeps both. */
  restore(col: RecCol, id: string, record: Synced, device: string): Synced {
    this.db.exec('BEGIN');
    try {
      const rec = this.write(col, id, { ...record, u: Date.now() }, device);
      this.db.exec('COMMIT');
      return rec;
    } catch (e) {
      this.db.exec('ROLLBACK');
      this.resync();
      throw e;
    }
  }

  history(col: RecCol, id: string, limit = 30) {
    return (this.db.prepare('SELECT r, u, device, at, data FROM history WHERE col = ? AND id = ? ORDER BY seq DESC LIMIT ?').all(col, id, limit) as {
      r: number;
      u: number;
      device: string;
      at: number;
      data: string;
    }[]).map((h) => ({ ...h, data: JSON.parse(h.data) as Synced }));
  }

  /** The version of a record that was current just before revision `r` was written (null = it did not exist). */
  versionBefore(col: RecCol, id: string, r: number): Synced | null {
    const row = this.db.prepare('SELECT data FROM history WHERE col = ? AND id = ? AND r < ? ORDER BY r DESC LIMIT 1').get(col, id, r) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Synced) : null;
  }

  stats() {
    const records = (this.db.prepare('SELECT COUNT(*) AS n FROM records').get() as { n: number }).n;
    const versions = (this.db.prepare('SELECT COUNT(*) AS n FROM history').get() as { n: number }).n;
    return { records, versions, rev: this.rev, schemaVersion: this.schemaVersion };
  }

  integrity(): string {
    const row = this.db.prepare('PRAGMA integrity_check').get() as Record<string, string>;
    return Object.values(row)[0] ?? 'unknown';
  }

  /** One backup per day (kept 14 days). Safe while the app is running. */
  backupIfDue(keep = 14): string | null {
    mkdirSync(this.backupDir, { recursive: true });
    const d = new Date();
    const name = `execution-os-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.db`;
    const target = join(this.backupDir, name);
    if (!existsSync(target)) {
      this.db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    }
    const all = this.backups();
    for (const old of all.slice(keep)) rmSync(join(this.backupDir, old), { force: true });
    return existsSync(target) ? target : null;
  }

  /** A labelled full copy (pre-migration, pre-restore, manual). Never removed by the daily rotation. */
  backupNow(label: string): string {
    mkdirSync(this.backupDir, { recursive: true });
    const safe = label.replace(/[^a-z0-9._-]+/gi, '-').slice(0, 60) || 'manual';
    let target = join(this.backupDir, `${safe}-${fileStamp()}.db`);
    for (let i = 2; existsSync(target); i++) target = join(this.backupDir, `${safe}-${fileStamp()}-${i}.db`);
    this.db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    return target;
  }

  /** Daily backups (rotated), newest first. */
  backups(): string[] {
    if (!existsSync(this.backupDir)) return [];
    return readdirSync(this.backupDir)
      .filter((f) => f.startsWith('execution-os-') && f.endsWith('.db'))
      .sort()
      .reverse();
  }

  /** Labelled backups (pre-migration, pre-restore, manual), newest first. */
  labelledBackups(): string[] {
    if (!existsSync(this.backupDir)) return [];
    return readdirSync(this.backupDir)
      .filter((f) => !f.startsWith('execution-os-') && f.endsWith('.db'))
      .sort((a, b) => b.localeCompare(a));
  }

  close() {
    this.db.close();
  }
}
