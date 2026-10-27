import '../quiet';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileStamp } from '../db';
import { latestVersion, runMigrations, type Migration, type MigrationRun } from '../migrations';
import type { EventKind, EventSource, StudyEvent } from '../../src/core/study/types';
import { STUDY_MIGRATIONS } from './migrations';

// study.db — the Study OS store inside the vault. One writer: the hub (or the `study` CLI when the hub
// is not running). Claude never writes here directly; it writes vault files, which the indexer reads,
// and logs events through the `study` CLI.

export interface StudyDbOptions {
  migrations?: Migration[];
  backupDir?: string; // default <vault>/.backups
}

export interface ItemRow {
  kind: string;
  id: string;
  subject: string | null;
  file: string;
  data: unknown;
  at: number;
}

export class StudyDb {
  readonly file: string;
  readonly backupDir: string;
  readonly migration: MigrationRun;
  private db: DatabaseSync;

  constructor(file: string, opts: StudyDbOptions = {}) {
    this.file = file;
    this.backupDir = opts.backupDir ?? join(dirname(file), '.backups');
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    const list = opts.migrations ?? STUDY_MIGRATIONS;
    const stored = this.getMeta('schemaVersion');
    const current = stored === undefined ? 0 : Number(stored);
    try {
      this.migration = runMigrations(
        this.db,
        current,
        list,
        // A brand-new file has nothing to lose: only an existing store is copied first.
        (from, to) => (current === 0 ? '' : this.backupNow(`pre-migration-v${from}-to-v${to}`)),
        (v) => this.setMeta('schemaVersion', String(v)),
      );
    } catch (e) {
      this.db.close();
      throw e;
    }
    if (this.getMeta('schemaVersion') === undefined) this.setMeta('schemaVersion', String(latestVersion(list)));
  }

  get sql(): DatabaseSync {
    return this.db;
  }

  get schemaVersion(): number {
    return Number(this.getMeta('schemaVersion') ?? 0);
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string) {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  /** Run `fn` in one transaction (nested calls join the outer one). */
  tx<R>(fn: () => R): R {
    if (this.depth > 0) return fn();
    this.db.exec('BEGIN');
    this.depth++;
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    } finally {
      this.depth--;
    }
  }
  private depth = 0;

  // ---------- evidence ----------

  addEvent(e: { kind: EventKind; concept?: string; session?: string; source: EventSource; data?: Record<string, unknown>; at?: number }): number {
    const r = this.db
      .prepare('INSERT INTO events (at, kind, concept, session, source, data) VALUES (?, ?, ?, ?, ?, ?)')
      .run(e.at ?? Date.now(), e.kind, e.concept ?? null, e.session ?? null, e.source, JSON.stringify(e.data ?? {}));
    return Number(r.lastInsertRowid);
  }

  events(filter: { concept?: string; kind?: EventKind; since?: number; session?: string; limit?: number } = {}): StudyEvent[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filter.concept) (where.push('concept = ?'), args.push(filter.concept));
    if (filter.kind) (where.push('kind = ?'), args.push(filter.kind));
    if (filter.since !== undefined) (where.push('at >= ?'), args.push(filter.since));
    if (filter.session) (where.push('session = ?'), args.push(filter.session));
    const sql = `SELECT * FROM events${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY at, seq${filter.limit ? ` LIMIT ${Math.floor(filter.limit)}` : ''}`;
    return (this.db.prepare(sql).all(...args) as Record<string, unknown>[]).map((r) => ({
      seq: Number(r.seq),
      at: Number(r.at),
      kind: r.kind as EventKind,
      ...(r.concept ? { concept: String(r.concept) } : {}),
      ...(r.session ? { session: String(r.session) } : {}),
      source: r.source as EventSource,
      data: JSON.parse(String(r.data)) as Record<string, unknown>,
    }));
  }

  // ---------- indexed vault items ----------

  putItem(kind: string, id: string, subject: string | undefined, file: string, data: unknown) {
    this.db
      .prepare('INSERT INTO items (kind, id, subject, file, data, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(kind, id) DO UPDATE SET subject = excluded.subject, file = excluded.file, data = excluded.data, at = excluded.at')
      .run(kind, id, subject ?? null, file, JSON.stringify(data), Date.now());
  }

  items<T = unknown>(kind: string): T[] {
    return (this.db.prepare('SELECT data FROM items WHERE kind = ? ORDER BY id').all(kind) as { data: string }[]).map((r) => JSON.parse(r.data) as T);
  }

  item<T = unknown>(kind: string, id: string): T | undefined {
    const r = this.db.prepare('SELECT data FROM items WHERE kind = ? AND id = ?').get(kind, id) as { data: string } | undefined;
    return r ? (JSON.parse(r.data) as T) : undefined;
  }

  removeItemsOfFile(file: string) {
    this.db.prepare('DELETE FROM items WHERE file = ?').run(file);
  }

  fileHashes(): Map<string, string> {
    return new Map((this.db.prepare('SELECT path, hash FROM files').all() as { path: string; hash: string }[]).map((r) => [r.path, r.hash]));
  }

  setFile(path: string, hash: string, kind: string | null, error: string | null) {
    this.db
      .prepare('INSERT INTO files (path, hash, kind, error, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET hash = excluded.hash, kind = excluded.kind, error = excluded.error, at = excluded.at')
      .run(path, hash, kind, error, Date.now());
  }

  removeFile(path: string) {
    this.db.prepare('DELETE FROM files WHERE path = ?').run(path);
    this.removeItemsOfFile(path);
  }

  fileErrors(): { path: string; error: string }[] {
    return this.db.prepare('SELECT path, error FROM files WHERE error IS NOT NULL ORDER BY path').all() as { path: string; error: string }[];
  }

  // ---------- backups ----------

  /** One backup per day (kept `keep` days). Safe while the hub is running. */
  backupIfDue(keep = 14): string | null {
    mkdirSync(this.backupDir, { recursive: true });
    const d = new Date();
    const name = `study-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.db`;
    const target = join(this.backupDir, name);
    if (!existsSync(target)) this.db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    for (const old of this.backups().slice(keep)) rmSync(join(this.backupDir, old), { force: true });
    return existsSync(target) ? target : null;
  }

  /** A labelled full copy (pre-migration, manual). Never removed by the daily rotation. */
  backupNow(label: string): string {
    mkdirSync(this.backupDir, { recursive: true });
    const safe = label.replace(/[^a-z0-9._-]+/gi, '-').slice(0, 60) || 'manual';
    let target = join(this.backupDir, `${safe}-${fileStamp()}.db`);
    for (let i = 2; existsSync(target); i++) target = join(this.backupDir, `${safe}-${fileStamp()}-${i}.db`);
    this.db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    return target;
  }

  /** Daily backups, newest first. */
  backups(): string[] {
    if (!existsSync(this.backupDir)) return [];
    return readdirSync(this.backupDir)
      .filter((f) => /^study-\d{4}-\d{2}-\d{2}\.db$/.test(f))
      .sort()
      .reverse();
  }

  integrity(): string {
    const row = this.db.prepare('PRAGMA integrity_check').get() as Record<string, string>;
    return Object.values(row)[0] ?? 'unknown';
  }

  close() {
    this.db.close();
  }
}
