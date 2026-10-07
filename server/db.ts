import './quiet';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { randomInt } from 'node:crypto';
import { dirname, join } from 'node:path';
import { normalizeDoc } from '../src/core/merge';
import { allKeys, getRec, sameRec, setRec, splitKey, type Change, type RecCol } from '../src/core/sync';
import type { Doc, Synced } from '../src/core/types';

// The PC database: one SQLite file is the single source of truth for every device.
//   records — the current version of every record (one row per record)
//   history — every version ever accepted, with which device sent it (nothing is ever lost)
//   meta    — hub revision counter and the pairing PIN
// An in-memory copy of the doc is kept for fast reads; every write goes to disk first.

export interface PushResult {
  rev: number;
  accepted: number;
  rejected: { col: RecCol; id: string }[];
}

export class HubDb {
  readonly file: string;
  readonly backupDir: string;
  private db: DatabaseSync;
  rev = 0;
  pin = '';
  doc: Doc;

  constructor(file: string, legacyJson?: string) {
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
    this.rev = Number(this.meta('rev') ?? 0);
    this.pin = this.meta('pin') ?? '';
    if (!this.pin) {
      this.pin = String(randomInt(100000, 999999));
      this.setMeta('pin', this.pin);
    }

    const count = (this.db.prepare('SELECT COUNT(*) AS n FROM records').get() as { n: number }).n;
    if (count === 0) this.seed(legacyJson);
    this.doc = this.load();
  }

  private meta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }

  private setMeta(key: string, value: string) {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
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
      throw e;
    }
  }

  private load(): Doc {
    const doc = normalizeDoc(null);
    const rows = this.db.prepare('SELECT col, id, data FROM records').all() as { col: RecCol; id: string; data: string }[];
    for (const row of rows) setRec(doc, row.col, row.id, JSON.parse(row.data) as Synced);
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
      this.doc = this.load(); // in-memory copy back in step with disk
      throw e;
    }
    return { rev: this.rev, accepted, rejected };
  }

  /** Hub-side inserts (browser extension "save for later", distraction log). */
  insert(col: RecCol, record: Synced, device: string) {
    this.db.exec('BEGIN');
    try {
      this.write(col, record.id, record, device);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
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

  stats() {
    const records = (this.db.prepare('SELECT COUNT(*) AS n FROM records').get() as { n: number }).n;
    const versions = (this.db.prepare('SELECT COUNT(*) AS n FROM history').get() as { n: number }).n;
    return { records, versions, rev: this.rev };
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

  backups(): string[] {
    if (!existsSync(this.backupDir)) return [];
    return readdirSync(this.backupDir)
      .filter((f) => f.startsWith('execution-os-') && f.endsWith('.db'))
      .sort()
      .reverse();
  }

  close() {
    this.db.close();
  }
}
