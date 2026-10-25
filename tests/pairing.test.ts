import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHub, type Hub } from '../server/hub';
import type { Tunnel } from '../server/tunnel';
import { encodePair, findHub, orderUrls, parsePair, urlKind, type PairPayload } from '../src/lib/pairing';

const PORT = 47995;
const base = `http://127.0.0.1:${PORT}`;
// A forwarded request (like one arriving through Tailscale Serve) is not "this PC".
const REMOTE = { 'X-Forwarded-For': '192.168.1.50' };
let hub: Hub;
let dir: string;

const quietTunnel: Tunnel = {
  info: async () => ({ installed: false, running: false, dnsName: null, state: null }),
  funnelOn: async () => ({ ok: false, message: 'no' }),
  funnelOff: async () => ({ ok: true, message: 'ok' }),
  funnelActive: async () => false,
  serveOn: async () => ({ ok: false, message: 'no' }),
  serveActive: async () => false,
};

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

async function pairOnce(name = 'Pixel 8') {
  const s = (await (await post('/api/pair/start', {})).json()) as { pairToken: string; qrText: string; hubId: string };
  const r = await post('/api/pair/claim', { t: s.pairToken, deviceName: name, platform: 'android' }, REMOTE);
  return { start: s, res: r, body: (await r.json()) as { deviceId: string; deviceToken: string; hubId: string; urls: string[]; claimId?: string } };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'eos-pair-'));
  hub = await startHub({ port: PORT, mcpPort: 47996, dbFile: join(dir, 'execution-os.db'), distDir: join(dir, 'dist'), tunnel: quietTunnel, pairTtlMs: 400 });
});
afterAll(async () => {
  await hub.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('loopback trust', () => {
  it('a proxied (forwarded) loopback request needs auth; a direct one does not', async () => {
    expect((await fetch(`${base}/api/sync?rev=-1`)).status).toBe(200);
    expect((await fetch(`${base}/api/sync?rev=-1`, { headers: REMOTE })).status).toBe(401);
    expect((await fetch(`${base}/api/sync?rev=-1`, { headers: { Forwarded: 'for=10.0.0.2' } })).status).toBe(401);
    expect((await fetch(`${base}/api/sync?rev=-1`, { headers: { 'Tailscale-User-Login': 'someone@example.com' } })).status).toBe(401);
    expect((await fetch(`${base}/api/info`, { headers: REMOTE })).status).toBe(401);
  });

  it('ping reports the hub id and name (not secret)', async () => {
    const j = (await (await fetch(`${base}/api/ping`, { headers: REMOTE })).json()) as { hubId: string; hubName: string };
    expect(j.hubId).toMatch(/^[0-9a-f]{32}$/);
    expect(j.hubName.length).toBeGreaterThan(0);
  });
});

describe('pairing', () => {
  it('claims once, then refuses the same token; a wrong token is refused', async () => {
    const { start, res, body } = await pairOnce();
    expect(res.status).toBe(200);
    expect(body.deviceToken).toMatch(/^eosd_/);
    expect(body.hubId).toBe(start.hubId);
    const again = await post('/api/pair/claim', { t: start.pairToken, deviceName: 'x' }, REMOTE);
    expect(again.status).toBe(401);
    expect((await post('/api/pair/claim', { t: 'nope', deviceName: 'x' }, REMOTE)).status).toBe(401);
  });

  it('expires after its lifetime', async () => {
    const s = (await (await post('/api/pair/start', {})).json()) as { pairToken: string };
    await new Promise((r) => setTimeout(r, 500));
    expect((await post('/api/pair/claim', { t: s.pairToken, deviceName: 'late' }, REMOTE)).status).toBe(401);
  });

  it('only the PC can start pairing or manage devices', async () => {
    expect((await post('/api/pair/start', {}, { ...REMOTE, 'X-EOS-PIN': hub.pin })).status).toBe(403);
    expect((await fetch(`${base}/api/devices`, { headers: { ...REMOTE, 'X-EOS-PIN': hub.pin } })).status).toBe(403);
  });

  it('the QR text carries the payload in the fragment, under 400 characters', async () => {
    const s = (await (await post('/api/pair/start', {})).json()) as { qrText: string; pairToken: string; hubId: string };
    const p = parsePair(s.qrText)!;
    expect(p.t).toBe(s.pairToken);
    expect(p.h).toBe(s.hubId);
    expect(s.qrText.split('#')[0]).not.toContain(s.pairToken);
  });
});

describe('device tokens', () => {
  it('work on every route that accepts the PIN, and stop working when revoked', async () => {
    const { body } = await pairOnce('Revokable phone');
    const h = { ...REMOTE, 'X-EOS-TOKEN': body.deviceToken };
    for (const path of ['/api/sync?rev=-1', '/api/focus', '/api/history?col=tasks&id=x', '/api/ai-activity']) {
      expect((await fetch(`${base}${path}`, { headers: h })).status, path).toBe(200);
    }
    expect((await post('/api/later', { url: 'https://example.com', title: 'x' }, h)).status).toBe(200);
    const list = (await (await fetch(`${base}/api/devices`)).json()) as { devices: { id: string; name: string; lastSeen: number }[]; recent: { name: string }[] };
    expect(list.devices.find((d) => d.id === body.deviceId)?.name).toBe('Revokable phone');
    expect(list.recent.some((r) => r.name === 'Revokable phone')).toBe(true);
    expect((await post('/api/devices/revoke', { id: body.deviceId })).status).toBe(200);
    expect((await fetch(`${base}/api/sync?rev=-1`, { headers: h })).status).toBe(401);
    // the change history names the device
    const hist = hub.db.history('later', Object.keys(hub.db.doc.later)[0]);
    expect(hist[0].device).toBe('Revokable phone');
  });

  it('the PIN keeps working until PIN pairing is turned off', async () => {
    expect((await fetch(`${base}/api/sync?rev=-1`, { headers: { ...REMOTE, 'X-EOS-PIN': hub.pin } })).status).toBe(200);
    await post('/api/devices/options', { pinDisabled: true });
    expect((await fetch(`${base}/api/sync?rev=-1`, { headers: { ...REMOTE, 'X-EOS-PIN': hub.pin } })).status).toBe(401);
    await post('/api/devices/options', { pinDisabled: false });
  });

  it('with "require approval", the phone waits until the PC approves', async () => {
    await post('/api/devices/options', { requireApproval: true });
    const { res, body } = await pairOnce('Needs approval');
    expect(res.status).toBe(202);
    const claimId = body.claimId!;
    expect(((await (await fetch(`${base}/api/pair/status?claimId=${claimId}`, { headers: REMOTE })).json()) as { status: string }).status).toBe('pending');
    const pending = (await (await fetch(`${base}/api/pair/pending`)).json()) as { pending: { claimId: string }[] };
    expect(pending.pending.map((p) => p.claimId)).toContain(claimId);
    await post('/api/pair/approve', { claimId });
    const done = (await (await fetch(`${base}/api/pair/status?claimId=${claimId}`, { headers: REMOTE })).json()) as { status: string; deviceToken: string };
    expect(done.status).toBe('approved');
    expect(done.deviceToken).toMatch(/^eosd_/);
    expect((await fetch(`${base}/api/pair/status?claimId=${claimId}`, { headers: REMOTE })).status).toBe(404); // handed out once
    await post('/api/devices/options', { requireApproval: false });
  });
});

describe('QR payload and failover (device side)', () => {
  const payload: PairPayload = {
    v: 1,
    h: '0123456789abcdef0123456789abcdef',
    n: 'Pragyesh-PC',
    t: 'AbCdEfGhIjKlMnOpQrStUv',
    u: ['http://192.168.1.20:4747', 'http://100.101.102.103:4747', 'https://pragyesh-pc.tail1234.ts.net'],
  };

  it('round-trips and stays scannable (< 400 characters)', () => {
    const text = encodePair('https://pragyesh-pc.tail1234.ts.net', payload);
    expect(text.length).toBeLessThan(400);
    expect(parsePair(text)).toEqual(payload);
    expect(parsePair(text.replace('https://pragyesh-pc.tail1234.ts.net/', 'executionos://pair'))).toEqual(payload);
    expect(parsePair('https://example.com/#pair=garbage')).toBeNull();
  });

  it('orders LAN first, then Tailscale', () => {
    expect(orderUrls([...payload.u].reverse())).toEqual(payload.u);
    expect(payload.u.map(urlKind)).toEqual(['wifi', 'tailscale', 'https']);
  });

  const fakeFetch = (up: Record<string, string | null>) =>
    (async (input: string) => {
      const origin = new URL(input).origin;
      const id = up[origin];
      if (id === undefined || id === null) throw new TypeError('network error');
      return new Response(JSON.stringify({ app: 'execution-os', hubId: id }), { status: 200 });
    }) as unknown as typeof fetch;

  it('uses Tailscale when the LAN address is down', async () => {
    const r = await findHub(payload.u, payload.h, { fetchFn: fakeFetch({ 'http://100.101.102.103:4747': payload.h }), lastGood: payload.u[0] });
    expect(r).toEqual({ ok: true, url: 'http://100.101.102.103:4747' });
  });

  it('refuses an address that now belongs to a different hub', async () => {
    const r = await findHub(payload.u, payload.h, { fetchFn: fakeFetch({ 'http://192.168.1.20:4747': 'ffffffffffffffffffffffffffffffff' }) });
    expect(r).toEqual({ ok: false, reason: 'other_hub', url: 'http://192.168.1.20:4747' });
  });

  it('reports unreachable when nothing answers', async () => {
    expect(await findHub(payload.u, payload.h, { fetchFn: fakeFetch({}) })).toEqual({ ok: false, reason: 'unreachable' });
  });
});
