import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHub, type Hub } from '../server/hub';
import type { Tunnel } from '../server/tunnel';
import * as ops from '../src/core/ops';

const HUB = 47981;
const MCP = 47982;
const BASE = `http://localhost:${MCP}`;
const RESOURCE = `${BASE}/mcp`;
const CLAUDE_CB = 'https://claude.ai/api/mcp/auth_callback';
let hub: Hub;
let dir: string;

const quiet: Tunnel = {
  info: async () => ({ installed: false, running: false, dnsName: null, state: null }),
  funnelOn: async () => ({ ok: false, message: '' }),
  funnelOff: async () => ({ ok: true, message: '' }),
  funnelActive: async () => false,
  serveOn: async () => ({ ok: false, message: '' }),
  serveActive: async () => false,
};

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

async function register(name: string, redirect = CLAUDE_CB) {
  const r = await fetch(`${BASE}/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: name, redirect_uris: [redirect], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) });
  expect(r.status).toBe(201);
  return (await r.json()) as { client_id: string };
}

/** Start a sign-in; returns the pending id shown on the consent page. */
async function authorize(clientId: string, challenge: string, redirect = CLAUDE_CB) {
  const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 'st8', resource: RESOURCE, scope: 'mcp offline_access' });
  const r = await fetch(`${BASE}/authorize?${q}`, { redirect: 'manual' });
  const html = await r.text();
  return { status: r.status, id: /name="id" value="([^"]+)"/.exec(html)?.[1], html };
}

async function approveOnPc(id: string) {
  const r = await fetch(`http://127.0.0.1:${HUB}/api/oauth`, { method: 'POST', body: JSON.stringify({ action: 'approve', id }) });
  expect(r.status).toBe(200);
  const s = (await (await fetch(`${BASE}/oauth/consent/status?id=${id}`)).json()) as { status: string; redirect: string };
  expect(s.status).toBe('approved');
  return new URL(s.redirect);
}

async function token(body: Record<string, string>) {
  const r = await fetch(`${BASE}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  return { status: r.status, json: (await r.json()) as { access_token: string; refresh_token: string; expires_in: number; error?: string } };
}

const mcpList = (bearer: string) =>
  fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });

async function signIn(name: string) {
  const { client_id } = await register(name);
  const p = pkce();
  const a = await authorize(client_id, p.challenge);
  const back = await approveOnPc(a.id!);
  const t = await token({ grant_type: 'authorization_code', code: back.searchParams.get('code')!, code_verifier: p.verifier, client_id, redirect_uri: CLAUDE_CB, resource: RESOURCE });
  expect(t.status).toBe(200);
  return { client_id, ...t.json };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'eos-oauth-'));
  hub = await startHub({ port: HUB, mcpPort: MCP, dbFile: join(dir, 'x.db'), distDir: join(dir, 'dist'), tunnel: quiet, oauthAccessTtlMs: 1500, gateway: { rateLimitPerMin: 1000 } });
  hub.db.mutate(ops.setFeature('mcp', true), 'test');
  await hub.connector.enable();
});
afterAll(async () => {
  await hub.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('OAuth 2.1 sign-in', () => {
  it('publishes protected-resource and authorization-server metadata (S256 only)', async () => {
    const unauth = await fetch(`${BASE}/mcp`, { method: 'POST', body: '{}' });
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get('www-authenticate')).toContain('resource_metadata="http://localhost:47982/.well-known/oauth-protected-resource/mcp"');
    const prm = (await (await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`)).json()) as { resource: string; authorization_servers: string[] };
    expect(prm.resource).toBe(RESOURCE);
    const as = (await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json()) as { code_challenge_methods_supported: string[]; registration_endpoint: string };
    expect(as.code_challenge_methods_supported).toEqual(['S256']);
    expect(as.registration_endpoint).toBe(`${BASE}/register`);
  });

  it('a consent page alone grants nothing: approval on the PC is needed, then PKCE is checked and the code works once', async () => {
    const { client_id } = await register('Claude');
    const p = pkce();
    const a = await authorize(client_id, p.challenge);
    expect(a.status).toBe(200);
    expect(a.html).toContain('Claude wants to connect to Execution OS');
    expect(((await (await fetch(`${BASE}/oauth/consent/status?id=${a.id}`)).json()) as { status: string }).status).toBe('pending');
    const back = await approveOnPc(a.id!);
    expect(back.origin + back.pathname).toBe(CLAUDE_CB);
    expect(back.searchParams.get('state')).toBe('st8');
    const code = back.searchParams.get('code')!;
    const wrong = await token({ grant_type: 'authorization_code', code, code_verifier: pkce().verifier, client_id, redirect_uri: CLAUDE_CB });
    expect(wrong.status).toBe(400); // wrong PKCE verifier
    const a2 = await authorize(client_id, p.challenge);
    const back2 = await approveOnPc(a2.id!);
    const ok = await token({ grant_type: 'authorization_code', code: back2.searchParams.get('code')!, code_verifier: p.verifier, client_id, redirect_uri: CLAUDE_CB, resource: RESOURCE });
    expect(ok.status).toBe(200);
    expect(ok.json.expires_in).toBe(2);
    const reuse = await token({ grant_type: 'authorization_code', code: back2.searchParams.get('code')!, code_verifier: p.verifier, client_id, redirect_uri: CLAUDE_CB });
    expect(reuse.status).toBe(400); // single use
    const r = await mcpList(ok.json.access_token);
    expect(r.status).toBe(200);
  });

  it('can be approved with the PIN instead, and a wrong PIN is refused', async () => {
    const { client_id } = await register('ChatGPT', 'https://chatgpt.com/connector_platform_oauth_redirect');
    const p = pkce();
    const a = await authorize(client_id, p.challenge, 'https://chatgpt.com/connector_platform_oauth_redirect');
    const bad = await fetch(`${BASE}/oauth/consent`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ id: a.id!, pin: '000000' }) });
    expect(bad.status).toBe(400);
    const good = await fetch(`${BASE}/oauth/consent`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ id: a.id!, pin: hub.pin }) });
    expect(good.status).toBe(302);
    expect(new URL(good.headers.get('location')!).searchParams.get('code')).toBeTruthy();
  });

  it('refuses a redirect URI that was not registered, and plain PKCE', async () => {
    const { client_id } = await register('Strict');
    const p = pkce();
    expect((await authorize(client_id, p.challenge, 'https://evil.example.com/cb')).status).toBe(400);
    const q = new URLSearchParams({ response_type: 'code', client_id, redirect_uri: CLAUDE_CB, code_challenge: p.verifier, code_challenge_method: 'plain' });
    const r = await fetch(`${BASE}/authorize?${q}`, { redirect: 'manual' });
    expect([302, 400]).toContain(r.status);
    if (r.status === 302) expect(new URL(r.headers.get('location')!).searchParams.get('error')).toBe('invalid_request');
  });

  it('labels the client in history, refreshes silently, rotates refresh tokens and revokes on reuse', async () => {
    const s = await signIn('ChatGPT');
    const call = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${s.access_token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'add_tasks', arguments: { tasks: [{ title: 'From ChatGPT', area: 'founder' }] } } }),
    });
    expect(call.status).toBe(200);
    const task = Object.values(hub.db.doc.tasks).find((t) => t.title === 'From ChatGPT')!;
    expect(hub.db.history('tasks', task.id)[0].device).toBe('mcp:chatgpt');
    await new Promise((r) => setTimeout(r, 2000)); // the access token expires
    expect((await mcpList(s.access_token)).status).toBe(401);
    const r1 = await token({ grant_type: 'refresh_token', refresh_token: s.refresh_token, client_id: s.client_id });
    expect(r1.status).toBe(200);
    expect((await mcpList(r1.json.access_token)).status).toBe(200);
    const reuse = await token({ grant_type: 'refresh_token', refresh_token: s.refresh_token, client_id: s.client_id });
    expect(reuse.status).toBe(400); // the old refresh token was rotated away…
    expect((await mcpList(r1.json.access_token)).status).toBe(401); // …and its reuse revoked the whole sign-in
  });

  it('revoking one app does not affect another; turning OAuth off keeps header tokens working', async () => {
    const a = await signIn('App A');
    const b = await signIn('App B');
    await fetch(`http://127.0.0.1:${HUB}/api/oauth`, { method: 'POST', body: JSON.stringify({ action: 'revoke', clientId: a.client_id }) });
    expect((await mcpList(a.access_token)).status).toBe(401);
    expect((await mcpList(b.access_token)).status).toBe(200);
    const header = hub.connector.rotate('claude-code');
    await fetch(`http://127.0.0.1:${HUB}/api/oauth`, { method: 'POST', body: JSON.stringify({ action: 'disable' }) });
    expect((await mcpList(b.access_token)).status).toBe(401);
    expect((await fetch(`${BASE}/.well-known/oauth-authorization-server`)).status).toBe(404);
    expect((await mcpList(header)).status).toBe(200);
    await fetch(`http://127.0.0.1:${HUB}/api/oauth`, { method: 'POST', body: JSON.stringify({ action: 'enable' }) });
    const list = (await (await fetch(`http://127.0.0.1:${HUB}/api/oauth`)).json()) as { clients: { name: string; revokedAt: number | null }[] };
    expect(list.clients.find((c) => c.name === 'App A')?.revokedAt).toBeTruthy();
  });
});
