import type { DatabaseSync } from 'node:sqlite';

// Schema migrations for the hub database.
// - meta.schemaVersion records the layout the file is in. Version 1 = the v1.0 layout.
// - Each migration is pure SQL work on the open database, numbered, idempotent, and runs inside
//   a transaction at start-up, in order.
// - Before any pending migration runs, the hub writes backups/pre-migration-v{from}-to-v{to}-*.db.
//   Those backups are never pruned by the daily rotation.
// - Adding an empty collection never needs a migration: the tolerant loader ignores collections
//   it does not know, and newer code simply starts with an empty map.

export interface Migration {
  to: number; // schema version after this migration
  name: string;
  up: (db: DatabaseSync) => void;
}

export const MIGRATIONS: Migration[] = [];

export const latestVersion = (list: Migration[]) => list.reduce((v, m) => Math.max(v, m.to), 1);

export interface MigrationRun {
  from: number;
  to: number;
  ran: string[];
  backup: string | null;
}

/** Run every migration newer than `current`. `backup(from, to)` must write a full copy first. */
export function runMigrations(
  db: DatabaseSync,
  current: number,
  list: Migration[],
  backup: (from: number, to: number) => string,
  setVersion: (v: number) => void,
): MigrationRun {
  const pending = list.filter((m) => m.to > current).sort((a, b) => a.to - b.to);
  if (!pending.length) return { from: current, to: current, ran: [], backup: null };
  const to = pending.at(-1)!.to;
  const file = backup(current, to);
  db.exec('BEGIN');
  try {
    for (const m of pending) m.up(db);
    setVersion(to);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { from: current, to, ran: pending.map((m) => m.name), backup: file };
}
