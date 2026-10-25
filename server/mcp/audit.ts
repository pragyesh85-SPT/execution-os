import { getRec, splitKey } from '../../src/core/sync';
import type { Synced } from '../../src/core/types';
import type { HubDb } from '../db';

// AI activity: one row per connector tool call (hub-private, never synced).
// Undo puts back the version of every record the call changed — but only if nobody edited
// that record since; otherwise it explains which later edit is in the way.

export interface AuditRow {
  seq: number;
  at: number;
  client: string;
  tool: string;
  args: string;
  ok: boolean;
  summary: string;
  changed: { key: string; r: number }[];
  revBefore: number;
  revAfter: number;
  undone: boolean;
}

export function ensureAuditTable(db: HubDb) {
  db.sql.exec(`
    CREATE TABLE IF NOT EXISTS mcp_audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, client TEXT, tool TEXT NOT NULL, args TEXT NOT NULL, ok INTEGER NOT NULL, summary TEXT, changed TEXT, rev_before INTEGER, rev_after INTEGER, undone INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS mcp_audit_at ON mcp_audit(at);
  `);
}

const truncate = (s: string, max: number) => (s.length > max ? s.slice(0, max - 1) + '…' : s);

export function writeAudit(db: HubDb, row: { client: string; tool: string; args: unknown; ok: boolean; summary: string; changed: string[]; revBefore: number; revAfter: number }): number {
  ensureAuditTable(db);
  const changed = row.changed.map((key) => {
    const { col, id } = splitKey(key);
    return { key, r: getRec(db.doc, col, id)?.r ?? 0 };
  });
  const res = db.sql
    .prepare('INSERT INTO mcp_audit (at, client, tool, args, ok, summary, changed, rev_before, rev_after) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(Date.now(), row.client, row.tool, truncate(JSON.stringify(row.args ?? {}), 4096), row.ok ? 1 : 0, truncate(row.summary, 500), JSON.stringify(changed), row.revBefore, row.revAfter);
  return Number(res.lastInsertRowid);
}

function toRow(r: Record<string, unknown>): AuditRow {
  return {
    seq: Number(r.seq),
    at: Number(r.at),
    client: String(r.client ?? ''),
    tool: String(r.tool),
    args: String(r.args),
    ok: !!r.ok,
    summary: String(r.summary ?? ''),
    changed: JSON.parse(String(r.changed ?? '[]')) as AuditRow['changed'],
    revBefore: Number(r.rev_before ?? 0),
    revAfter: Number(r.rev_after ?? 0),
    undone: !!r.undone,
  };
}

export function listAudit(db: HubDb, limit = 100): AuditRow[] {
  ensureAuditTable(db);
  return (db.sql.prepare('SELECT * FROM mcp_audit ORDER BY seq DESC LIMIT ?').all(Math.min(500, limit)) as Record<string, unknown>[]).map(toRow);
}

export function lastSuccess(db: HubDb): AuditRow | null {
  ensureAuditTable(db);
  const r = db.sql.prepare('SELECT * FROM mcp_audit WHERE ok = 1 ORDER BY seq DESC LIMIT 1').get() as Record<string, unknown> | undefined;
  return r ? toRow(r) : null;
}

export type UndoResult = { ok: true; restored: string[] } | { ok: false; reason: string; blocked: string[] };

export function undoAudit(db: HubDb, seq: number, device = 'undo'): UndoResult {
  ensureAuditTable(db);
  const raw = db.sql.prepare('SELECT * FROM mcp_audit WHERE seq = ?').get(seq) as Record<string, unknown> | undefined;
  if (!raw) return { ok: false, reason: 'That activity entry does not exist.', blocked: [] };
  const row = toRow(raw);
  if (row.undone) return { ok: false, reason: 'Already undone.', blocked: [] };
  if (!row.changed.length) return { ok: false, reason: 'That call did not change anything.', blocked: [] };
  const blocked: string[] = [];
  for (const c of row.changed) {
    const { col, id } = splitKey(c.key);
    const cur = getRec(db.doc, col, id);
    if ((cur?.r ?? 0) !== c.r) blocked.push(c.key);
  }
  if (blocked.length) {
    return { ok: false, reason: 'A later edit changed the same item, so undo would overwrite it. Open the record history instead.', blocked };
  }
  for (const c of row.changed) {
    const { col, id } = splitKey(c.key);
    const prev = db.versionBefore(col, id, c.r);
    const cur = getRec(db.doc, col, id) as Synced;
    db.restore(col, id, prev ? { ...prev } : { ...cur, del: true }, device);
  }
  db.sql.prepare('UPDATE mcp_audit SET undone = 1 WHERE seq = ?').run(seq);
  return { ok: true, restored: row.changed.map((c) => c.key) };
}
