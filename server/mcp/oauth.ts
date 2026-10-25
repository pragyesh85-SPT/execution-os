import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import express, { type Response } from 'express';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { HubDb } from '../db';
import { Guard } from './auth';

// OAuth 2.1 for AI clients that add a connector without a pasted token (ChatGPT, Claude, others).
// The MCP SDK's router does the protocol work (metadata, dynamic client registration, /authorize with
// exact redirect-URI matching, /token with PKCE S256 verification, revocation). This file only stores
// things — hashed, in hub-private tables — and adds the one rule that matters here: a sign-in is granted
// only after the owner approves it in the PC app or types the device PIN, so a leaked link grants nothing.
// Static bearer tokens (Settings → AI connector → Tokens) keep working alongside.

const ACCESS_TTL = 60 * 60_000; // 1 hour
const REFRESH_TTL = 30 * 86_400_000; // 30 days, rotated on every use
const CODE_TTL = 5 * 60_000;
const PENDING_TTL = 10 * 60_000;

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const rand = (n = 32) => randomBytes(n).toString('base64url');

export interface PendingAuth {
  id: string;
  clientId: string;
  clientName: string;
  params: { state?: string; scopes?: string[]; codeChallenge: string; redirectUri: string; resource?: string };
  at: number;
  status: 'pending' | 'approved' | 'denied';
  redirect?: string;
}

export interface OAuthClientRow {
  clientId: string;
  name: string;
  label: string;
  createdAt: number;
  revokedAt: number | null;
  lastUsed: number | null;
  activeTokens: number;
}

/** "ChatGPT" → "chatgpt": the label used in history (mcp:chatgpt), audit and proposals. */
export const labelFor = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'oauth-client';

export class OAuth {
  private pending = new Map<string, PendingAuth>();
  private pinGuard = new Guard(1000, 5, 15 * 60_000);
  readonly accessTtl: number;

  constructor(
    private db: HubDb,
    opts: { accessTtlMs?: number } = {},
  ) {
    this.accessTtl = opts.accessTtlMs ?? ACCESS_TTL;
    db.sql.exec(`
      CREATE TABLE IF NOT EXISTS oauth_clients (client_id TEXT PRIMARY KEY, data TEXT NOT NULL, label TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER);
      CREATE TABLE IF NOT EXISTS oauth_codes (code_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, challenge TEXT NOT NULL, redirect_uri TEXT NOT NULL, resource TEXT, scopes TEXT, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS oauth_tokens (token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL, client_id TEXT NOT NULL, family TEXT NOT NULL, scopes TEXT, resource TEXT, expires_at INTEGER NOT NULL, revoked_at INTEGER, last_used INTEGER);
    `);
  }

  get enabled(): boolean {
    return this.db.getMeta('oauth.enabled') !== '0';
  }

  setEnabled(on: boolean) {
    this.db.setMeta('oauth.enabled', on ? '1' : '0');
  }

  // ---------- storage ----------

  readonly clientsStore: OAuthRegisteredClientsStore = {
    getClient: (clientId) => {
      const row = this.db.sql.prepare('SELECT data, revoked_at FROM oauth_clients WHERE client_id = ?').get(clientId) as { data: string; revoked_at: number | null } | undefined;
      if (!row || row.revoked_at) return undefined;
      return JSON.parse(row.data) as OAuthClientInformationFull;
    },
    registerClient: (client) => {
      const full = { ...client, client_id: `eosc_${rand(12)}`, client_id_issued_at: Math.floor(Date.now() / 1000) } as OAuthClientInformationFull;
      this.db.sql.prepare('INSERT INTO oauth_clients (client_id, data, label, created_at) VALUES (?, ?, ?, ?)').run(full.client_id, JSON.stringify(full), labelFor(client.client_name ?? 'oauth-client'), Date.now());
      return full;
    },
  };

  private labelOf(clientId: string): string {
    const row = this.db.sql.prepare('SELECT label FROM oauth_clients WHERE client_id = ?').get(clientId) as { label: string } | undefined;
    return row?.label ?? 'oauth-client';
  }

  private issue(clientId: string, scopes: string[], resource: string | undefined, family = rand(12)): OAuthTokens {
    const access = `eosa_${rand()}`;
    const refresh = `eosr_${rand()}`;
    const now = Date.now();
    const ins = this.db.sql.prepare('INSERT INTO oauth_tokens (token_hash, kind, client_id, family, scopes, resource, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    ins.run(sha(access), 'access', clientId, family, scopes.join(' '), resource ?? null, now + this.accessTtl);
    ins.run(sha(refresh), 'refresh', clientId, family, scopes.join(' '), resource ?? null, now + REFRESH_TTL);
    return { access_token: access, token_type: 'Bearer', expires_in: Math.round(this.accessTtl / 1000), refresh_token: refresh, ...(scopes.length ? { scope: scopes.join(' ') } : {}) };
  }

  // ---------- the provider the SDK router calls ----------

  readonly provider: OAuthServerProvider = {
    clientsStore: this.clientsStore,

    authorize: async (client: OAuthClientInformationFull, params: AuthorizationParams, res: Response) => {
      const id = rand(16);
      this.pending.set(id, {
        id,
        clientId: client.client_id,
        clientName: (client.client_name ?? 'An AI app').slice(0, 60),
        params: { state: params.state, scopes: params.scopes, codeChallenge: params.codeChallenge, redirectUri: params.redirectUri, resource: params.resource?.href },
        at: Date.now(),
        status: 'pending',
      });
      res.status(200).setHeader('Content-Type', 'text/html; charset=utf-8').setHeader('Cache-Control', 'no-store').send(consentPage(id, client.client_name ?? 'An AI app'));
    },

    challengeForAuthorizationCode: async (_client, code) => {
      const row = this.db.sql.prepare('SELECT challenge FROM oauth_codes WHERE code_hash = ?').get(sha(code)) as { challenge: string } | undefined;
      if (!row) throw new InvalidGrantError('Unknown or used authorization code');
      return row.challenge;
    },

    exchangeAuthorizationCode: async (client, code, _verifier, redirectUri, resource) => {
      const h = sha(code);
      const row = this.db.sql.prepare('SELECT * FROM oauth_codes WHERE code_hash = ?').get(h) as Record<string, unknown> | undefined;
      this.db.sql.prepare('DELETE FROM oauth_codes WHERE code_hash = ?').run(h); // single use, whatever happens next
      if (!row || Number(row.expires_at) < Date.now()) throw new InvalidGrantError('The authorization code expired or was already used');
      if (row.client_id !== client.client_id) throw new InvalidGrantError('This code was issued to another client');
      if (redirectUri && redirectUri !== row.redirect_uri) throw new InvalidGrantError('redirect_uri does not match the authorization request');
      if (row.resource && resource && resource.href !== row.resource) throw new InvalidGrantError('resource does not match the authorization request');
      return this.issue(client.client_id, String(row.scopes ?? '').split(' ').filter(Boolean), (row.resource as string | null) ?? resource?.href);
    },

    exchangeRefreshToken: async (client, refreshToken, scopes, resource) => {
      const h = sha(refreshToken);
      const row = this.db.sql.prepare("SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh'").get(h) as Record<string, unknown> | undefined;
      if (!row || row.client_id !== client.client_id) throw new InvalidGrantError('Unknown refresh token');
      if (row.revoked_at) {
        // A rotated refresh token came back: someone kept a copy. Revoke the whole sign-in.
        this.db.sql.prepare('UPDATE oauth_tokens SET revoked_at = ? WHERE family = ? AND revoked_at IS NULL').run(Date.now(), row.family as string);
        throw new InvalidGrantError('This refresh token was already used; the sign-in has been revoked. Connect again.');
      }
      if (Number(row.expires_at) < Date.now()) throw new InvalidGrantError('The refresh token expired. Connect again.');
      if (resource && row.resource && resource.href !== row.resource) throw new InvalidGrantError('resource does not match');
      this.db.sql.prepare('UPDATE oauth_tokens SET revoked_at = ? WHERE token_hash = ?').run(Date.now(), h);
      const granted = String(row.scopes ?? '').split(' ').filter(Boolean);
      const want = scopes?.length ? scopes.filter((s) => granted.includes(s)) : granted;
      return this.issue(client.client_id, want, (row.resource as string | null) ?? undefined, row.family as string);
    },

    verifyAccessToken: async (token) => {
      const info = this.verify(token);
      if (!info) throw new InvalidTokenError('Invalid or expired access token');
      return info;
    },

    revokeToken: async (client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest) => {
      this.db.sql.prepare('UPDATE oauth_tokens SET revoked_at = ? WHERE token_hash = ? AND client_id = ?').run(Date.now(), sha(request.token), client.client_id);
    },
  };

  /** Synchronous check used by the gateway: a valid, unexpired, unrevoked access token for one of our /mcp URLs. */
  verify(token: string, resources?: string[]): (AuthInfo & { label: string }) | null {
    if (!this.enabled || !token.startsWith('eosa_')) return null;
    const row = this.db.sql.prepare("SELECT t.*, c.revoked_at AS client_revoked FROM oauth_tokens t JOIN oauth_clients c ON c.client_id = t.client_id WHERE t.token_hash = ? AND t.kind = 'access'").get(sha(token)) as Record<string, unknown> | undefined;
    if (!row || row.revoked_at || row.client_revoked || Number(row.expires_at) < Date.now()) return null;
    if (resources && row.resource && !resources.includes(String(row.resource))) return null; // audience binding
    const now = Date.now();
    if (!row.last_used || Number(row.last_used) < now - 60_000) this.db.sql.prepare('UPDATE oauth_tokens SET last_used = ? WHERE token_hash = ?').run(now, sha(token));
    return {
      token,
      clientId: String(row.client_id),
      scopes: String(row.scopes ?? '').split(' ').filter(Boolean),
      expiresAt: Math.floor(Number(row.expires_at) / 1000),
      ...(row.resource ? { resource: new URL(String(row.resource)) } : {}),
      label: this.labelOf(String(row.client_id)),
    };
  }

  // ---------- approval ----------

  pendingList(): PendingAuth[] {
    const cutoff = Date.now() - PENDING_TTL;
    for (const [id, p] of this.pending) if (p.at < cutoff) this.pending.delete(id);
    return [...this.pending.values()].filter((p) => p.status === 'pending');
  }

  /** Approve (on the PC, or with the PIN): issue a single-use code and the redirect back to the AI app. */
  decide(id: string, approve: boolean): PendingAuth | null {
    const p = this.pending.get(id);
    if (!p || p.status !== 'pending' || p.at < Date.now() - PENDING_TTL) return null;
    if (!approve) {
      p.status = 'denied';
      const u = new URL(p.params.redirectUri);
      u.searchParams.set('error', 'access_denied');
      if (p.params.state) u.searchParams.set('state', p.params.state);
      p.redirect = u.href;
      return p;
    }
    const code = rand();
    this.db.sql
      .prepare('INSERT INTO oauth_codes (code_hash, client_id, challenge, redirect_uri, resource, scopes, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(sha(code), p.clientId, p.params.codeChallenge, p.params.redirectUri, p.params.resource ?? null, (p.params.scopes ?? []).join(' '), Date.now() + CODE_TTL);
    const u = new URL(p.params.redirectUri);
    u.searchParams.set('code', code);
    if (p.params.state) u.searchParams.set('state', p.params.state);
    p.status = 'approved';
    p.redirect = u.href;
    return p;
  }

  approveWithPin(id: string, pin: string, ip: string): { ok: true; redirect: string } | { ok: false; error: string } {
    if (this.pinGuard.limited(ip)) return { ok: false, error: 'Too many wrong PINs. Wait 15 minutes, or approve on the PC.' };
    const a = Buffer.from(sha(pin));
    const b = Buffer.from(sha(this.db.pin));
    if (!timingSafeEqual(a, b)) {
      this.pinGuard.failed(ip);
      return { ok: false, error: 'Wrong PIN.' };
    }
    const p = this.decide(id, true);
    return p?.redirect ? { ok: true, redirect: p.redirect } : { ok: false, error: 'This sign-in request expired. Start again from the AI app.' };
  }

  status(id: string): PendingAuth | undefined {
    return this.pending.get(id);
  }

  clients(): OAuthClientRow[] {
    const rows = this.db.sql.prepare('SELECT client_id, data, label, created_at, revoked_at FROM oauth_clients ORDER BY created_at DESC').all() as Record<string, unknown>[];
    return rows.map((r) => {
      const t = this.db.sql.prepare("SELECT COUNT(*) AS n, MAX(last_used) AS used FROM oauth_tokens WHERE client_id = ? AND revoked_at IS NULL AND expires_at > ? AND kind = 'refresh'").get(r.client_id as string, Date.now()) as { n: number; used: number | null };
      const used = this.db.sql.prepare('SELECT MAX(last_used) AS used FROM oauth_tokens WHERE client_id = ?').get(r.client_id as string) as { used: number | null };
      return {
        clientId: String(r.client_id),
        name: (JSON.parse(String(r.data)) as { client_name?: string }).client_name ?? String(r.label),
        label: String(r.label),
        createdAt: Number(r.created_at),
        revokedAt: r.revoked_at ? Number(r.revoked_at) : null,
        lastUsed: used.used ?? null,
        activeTokens: t.n,
      };
    });
  }

  revokeClient(clientId: string): boolean {
    const now = Date.now();
    const r = this.db.sql.prepare('UPDATE oauth_clients SET revoked_at = ? WHERE client_id = ? AND revoked_at IS NULL').run(now, clientId);
    this.db.sql.prepare('UPDATE oauth_tokens SET revoked_at = ? WHERE client_id = ? AND revoked_at IS NULL').run(now, clientId);
    return Number(r.changes) > 0;
  }

  // ---------- HTTP ----------

  private routers = new Map<string, express.Express>();

  /** Express app for one public base URL (the SDK pins the issuer to it). */
  private appFor(base: string): express.Express {
    let app = this.routers.get(base);
    if (app) return app;
    app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', 'loopback'); // Tailscale Funnel forwards from 127.0.0.1 with X-Forwarded-For
    app.use(
      mcpAuthRouter({
        provider: this.provider,
        issuerUrl: new URL(base),
        resourceServerUrl: new URL(`${base}/mcp`),
        scopesSupported: ['mcp', 'offline_access'],
        resourceName: 'Execution OS',
        clientRegistrationOptions: { clientSecretExpirySeconds: 0 },
      }),
    );
    app.use(express.urlencoded({ extended: false, limit: '8kb' }));
    app.post('/oauth/consent', (req, res) => {
      const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim();
      const r = this.approveWithPin(String(req.body?.id ?? ''), String(req.body?.pin ?? ''), ip);
      if (r.ok) return res.redirect(302, r.redirect);
      res.status(400).setHeader('Content-Type', 'text/html; charset=utf-8').send(consentPage(String(req.body?.id ?? ''), 'the AI app', r.error));
    });
    app.get('/oauth/consent/status', (req, res) => {
      const p = this.status(String(req.query.id ?? ''));
      res.setHeader('Cache-Control', 'no-store');
      res.json(p ? { status: p.status, ...(p.redirect ? { redirect: p.redirect } : {}) } : { status: 'expired' });
    });
    this.routers.set(base, app);
    return app;
  }

  static readonly PATHS = ['/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource', '/authorize', '/token', '/register', '/revoke', '/oauth/'];

  /** For the gateway: handle the OAuth routes; returns false for anything else. */
  handle(req: IncomingMessage, res: ServerResponse, url: URL, base: string): boolean {
    if (!OAuth.PATHS.some((p) => url.pathname === p || url.pathname.startsWith(p.endsWith('/') ? p : `${p}/`))) return false;
    if (!this.enabled) {
      res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'OAuth sign-in is turned off. Use a connector token.' }));
      return true;
    }
    this.appFor(base)(req as never, res as never);
    return true;
  }

  wwwAuthenticate(base: string): string {
    return this.enabled ? `Bearer realm="execution-os", resource_metadata="${getOAuthProtectedResourceMetadataUrl(new URL(`${base}/mcp`))}"` : 'Bearer realm="execution-os"';
  }
}

const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

function consentPage(id: string, clientName: string, error?: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect to Execution OS</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f4ef;color:#1c1b19;font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
@media (prefers-color-scheme:dark){body{background:#121110;color:#edeae3}.box{background:#1c1b19!important;border-color:#2c2a27!important}input{background:#121110;color:#edeae3}}
.box{max-width:420px;margin:16px;padding:24px;background:#fff;border:1px solid #e2ded4;border-radius:12px}h1{font-size:20px;margin:0 0 8px}p{margin:0 0 12px}
input{font:inherit;font-size:20px;letter-spacing:.3em;width:100%;padding:10px;border:1px solid #cfcabe;border-radius:8px;box-sizing:border-box}
button{margin-top:12px;width:100%;padding:11px;font:inherit;font-weight:600;border:0;border-radius:8px;background:#d9480f;color:#fff;cursor:pointer}.err{color:#c0392b}.muted{color:#8a857b;font-size:13px}</style></head>
<body><div class="box"><h1>${escHtml(clientName)} wants to connect to Execution OS</h1>
<p>It will be able to read your plan and propose changes. Every change it makes is listed under AI activity with Undo.</p>
<p><strong>Approve it on your PC</strong> (Execution OS → Settings → AI connector), or type your 6-digit pairing PIN here.</p>
${error ? `<p class="err">${escHtml(error)}</p>` : ''}
<form method="post" action="/oauth/consent"><input type="hidden" name="id" value="${escHtml(id)}"><input name="pin" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="PIN"><button type="submit">Approve with PIN</button></form>
<p class="muted" id="wait">Waiting for approval on the PC…</p></div>
<script>setInterval(async()=>{try{const r=await fetch('/oauth/consent/status?id=${encodeURIComponent(id)}');const j=await r.json();if(j.redirect)location.href=j.redirect;else if(j.status==='expired')document.getElementById('wait').textContent='This request expired. Start again from the AI app.'}catch(e){}},2000)</script></body></html>`;
}
