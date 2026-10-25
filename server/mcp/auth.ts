import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { HubDb } from '../db';

// Connector tokens. One 256-bit random token per AI client ("claude", "chatgpt", "claude-code"…).
// Only a SHA-256 hash is stored (hub-private table, never synced); the token itself is shown once.
// Comparison is constant-time. Tokens are never logged and never accepted in URLs.

export const CLIENT_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function ensureAuthTables(db: HubDb) {
  db.sql.exec(`
    CREATE TABLE IF NOT EXISTS mcp_tokens (client TEXT PRIMARY KEY, token_hash TEXT NOT NULL, created_at INTEGER NOT NULL, last_used INTEGER);
  `);
}

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest();

/** Create or replace the token for a client. Returns the token — the only time it exists in clear. */
export function rotateToken(db: HubDb, client: string): string {
  if (!CLIENT_RE.test(client)) throw new Error('Client name: lowercase letters, digits and dashes.');
  ensureAuthTables(db);
  const token = `eos_${randomBytes(32).toString('base64url')}`;
  db.sql
    .prepare('INSERT INTO mcp_tokens (client, token_hash, created_at) VALUES (?, ?, ?) ON CONFLICT(client) DO UPDATE SET token_hash = excluded.token_hash, created_at = excluded.created_at, last_used = NULL')
    .run(client, sha(token).toString('hex'), Date.now());
  return token;
}

export function revokeToken(db: HubDb, client: string) {
  ensureAuthTables(db);
  db.sql.prepare('DELETE FROM mcp_tokens WHERE client = ?').run(client);
}

export function listClients(db: HubDb): { client: string; createdAt: number; lastUsed: number | null }[] {
  ensureAuthTables(db);
  return (db.sql.prepare('SELECT client, created_at, last_used FROM mcp_tokens ORDER BY client').all() as { client: string; created_at: number; last_used: number | null }[]).map((r) => ({
    client: r.client,
    createdAt: r.created_at,
    lastUsed: r.last_used,
  }));
}

/** The client a bearer token belongs to, or null. Constant-time against every stored hash. */
export function verifyBearer(db: HubDb, header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(\S{20,200})$/i.exec(header.trim());
  if (!m) return null;
  ensureAuthTables(db);
  const given = sha(m[1]);
  let found: string | null = null;
  for (const row of db.sql.prepare('SELECT client, token_hash FROM mcp_tokens').all() as { client: string; token_hash: string }[]) {
    const stored = Buffer.from(row.token_hash, 'hex');
    if (stored.length === given.length && timingSafeEqual(stored, given)) found = row.client;
  }
  if (found) {
    const now = Date.now();
    db.sql.prepare('UPDATE mcp_tokens SET last_used = ? WHERE client = ? AND (last_used IS NULL OR last_used < ?)').run(now, found, now - 60_000);
  }
  return found;
}

// ---------- rate limit and lockout (in memory, per IP) ----------

export class Guard {
  private hits = new Map<string, number[]>();
  private fails = new Map<string, number[]>();
  private blocked = new Map<string, number>();
  constructor(
    private perMinute = 60,
    private maxFails = 10,
    private blockMs = 15 * 60_000,
  ) {}

  /** True when this IP is over the request rate or locked out after failed logins. */
  limited(ip: string, now = Date.now()): boolean {
    const until = this.blocked.get(ip);
    if (until && until > now) return true;
    if (until) this.blocked.delete(ip);
    const list = (this.hits.get(ip) ?? []).filter((t) => t > now - 60_000);
    list.push(now);
    this.hits.set(ip, list);
    return list.length > this.perMinute;
  }

  failed(ip: string, now = Date.now()) {
    const list = (this.fails.get(ip) ?? []).filter((t) => t > now - this.blockMs);
    list.push(now);
    this.fails.set(ip, list);
    if (list.length >= this.maxFails) {
      this.blocked.set(ip, now + this.blockMs);
      this.fails.delete(ip);
    }
  }

  succeeded(ip: string) {
    this.fails.delete(ip);
  }
}
