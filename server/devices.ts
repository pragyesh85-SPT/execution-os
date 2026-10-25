import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { hostname } from 'node:os';
import type { HubDb } from './db';

// Device pairing. The PC shows one QR; the phone claims a single-use pairing token and gets a
// long-lived device token (stored hashed, revocable). Devices then send X-EOS-TOKEN; the PIN keeps
// working as a fallback until the owner turns PIN pairing off.

export interface DeviceRow {
  id: string;
  name: string;
  platform: string | null;
  createdAt: number;
  lastSeen: number | null;
  revokedAt: number | null;
}

export interface PairStart {
  pairToken: string;
  expiresAt: number;
  hubId: string;
  hubName: string;
}

export interface Claim {
  claimId: string;
  deviceName: string;
  platform: string;
  at: number;
  status: 'pending' | 'approved' | 'denied';
  result?: { deviceId: string; deviceToken: string };
}

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

export class Devices {
  private active: { token: string; expiresAt: number } | null = null;
  private claims = new Map<string, Claim>();
  readonly hubId: string;
  readonly ttlMs: number;

  constructor(
    private db: HubDb,
    opts: { ttlMs?: number; clock?: () => number } = {},
  ) {
    this.ttlMs = opts.ttlMs ?? 5 * 60_000;
    this.clock = opts.clock ?? Date.now;
    db.sql.exec(`
      CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT, token_hash TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen INTEGER, revoked_at INTEGER);
    `);
    let id = db.getMeta('hub.id');
    if (!id) {
      id = randomBytes(16).toString('hex');
      db.setMeta('hub.id', id);
    }
    this.hubId = id;
  }

  private clock: () => number;

  get hubName(): string {
    return this.db.getMeta('hub.name') ?? hostname();
  }

  get requireApproval(): boolean {
    return this.db.getMeta('pair.requireApproval') === '1';
  }

  get pinDisabled(): boolean {
    return this.db.getMeta('pair.pinDisabled') === '1';
  }

  setOption(key: 'requireApproval' | 'pinDisabled', on: boolean) {
    this.db.setMeta(`pair.${key}`, on ? '1' : '0');
  }

  /** A new single-use pairing token (128-bit, 5 minutes). Starting again replaces the previous one. */
  start(): PairStart {
    const token = randomBytes(16).toString('base64url');
    this.active = { token, expiresAt: this.clock() + this.ttlMs };
    return { pairToken: token, expiresAt: this.active.expiresAt, hubId: this.hubId, hubName: this.hubName };
  }

  private consume(t: string): boolean {
    const a = this.active;
    if (!a || a.expiresAt < this.clock()) return false;
    const x = Buffer.from(sha(a.token), 'hex');
    const y = Buffer.from(sha(String(t)), 'hex');
    if (!timingSafeEqual(x, y)) return false;
    this.active = null; // single use
    return true;
  }

  private issue(name: string, platform: string) {
    const deviceId = `dev-${randomBytes(6).toString('hex')}`;
    const deviceToken = `eosd_${randomBytes(32).toString('base64url')}`;
    this.db.sql.prepare('INSERT INTO devices (id, name, platform, token_hash, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)').run(deviceId, name, platform, sha(deviceToken), this.clock(), this.clock());
    return { deviceId, deviceToken };
  }

  /** Phone side. null = wrong/expired token. */
  claim(t: string, deviceName: string, platform: string): { status: 'approved'; deviceId: string; deviceToken: string } | { status: 'pending'; claimId: string } | null {
    if (!this.consume(t)) return null;
    const name = (deviceName || 'Device').slice(0, 60);
    const plat = (platform || 'web').slice(0, 30);
    if (!this.requireApproval) return { status: 'approved', ...this.issue(name, plat) };
    const claimId = randomBytes(12).toString('base64url');
    this.claims.set(claimId, { claimId, deviceName: name, platform: plat, at: this.clock(), status: 'pending' });
    return { status: 'pending', claimId };
  }

  claimStatus(claimId: string): Claim | undefined {
    const c = this.claims.get(claimId);
    if (c && c.status !== 'pending') this.claims.delete(claimId); // the token is handed out once
    return c;
  }

  pending(): Claim[] {
    const cutoff = this.clock() - this.ttlMs;
    return [...this.claims.values()].filter((c) => c.status === 'pending' && c.at > cutoff);
  }

  decide(claimId: string, approve: boolean): boolean {
    const c = this.claims.get(claimId);
    if (!c || c.status !== 'pending') return false;
    c.status = approve ? 'approved' : 'denied';
    if (approve) c.result = this.issue(c.deviceName, c.platform);
    return true;
  }

  /** The device a token belongs to (not revoked), or null. Updates last_seen at most once a minute. */
  verify(token: string | undefined): DeviceRow | null {
    if (!token || token.length < 20 || token.length > 200) return null;
    const row = this.db.sql.prepare('SELECT id, name, platform, created_at, last_seen, revoked_at FROM devices WHERE token_hash = ?').get(sha(token)) as Record<string, unknown> | undefined;
    if (!row || row.revoked_at) return null;
    const now = this.clock();
    if (!row.last_seen || Number(row.last_seen) < now - 60_000) this.db.sql.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').run(now, row.id as string);
    return { id: String(row.id), name: String(row.name), platform: (row.platform as string) ?? null, createdAt: Number(row.created_at), lastSeen: now, revokedAt: null };
  }

  list(): DeviceRow[] {
    return (this.db.sql.prepare('SELECT id, name, platform, created_at, last_seen, revoked_at FROM devices ORDER BY created_at DESC').all() as Record<string, unknown>[]).map((r) => ({
      id: String(r.id),
      name: String(r.name),
      platform: (r.platform as string) ?? null,
      createdAt: Number(r.created_at),
      lastSeen: r.last_seen ? Number(r.last_seen) : null,
      revokedAt: r.revoked_at ? Number(r.revoked_at) : null,
    }));
  }

  revoke(id: string): boolean {
    const r = this.db.sql.prepare('UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(this.clock(), id);
    return Number(r.changes) > 0;
  }
}

// ---------- QR payload (shared shape with the web app, see src/lib/pairing.ts) ----------

export interface PairPayload {
  v: 1;
  h: string; // hub id
  n: string; // hub name
  t: string; // pairing token
  u: string[]; // hub URLs, LAN first, then Tailscale
}

export function pairUrl(base: string, p: PairPayload): string {
  return `${base.replace(/\/$/, '')}/#pair=${Buffer.from(JSON.stringify(p), 'utf8').toString('base64url')}`;
}
