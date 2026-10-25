import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { lanAddresses, startHub, type Hub } from '../server/hub';
import { CORE_TOOLS } from '../server/mcp/tools';
import type { Tunnel } from '../server/tunnel';
import * as ops from '../src/core/ops';

const HUB = 47993;
const MCP = 47994;
const DATE = '2026-10-07';
const NOW = new Date(2026, 9, 7, 13, 0).getTime();
let hub: Hub;
let dir: string;
let token: string;
const mcpUrl = `http://127.0.0.1:${MCP}/mcp`;

const fakeTunnel: Tunnel = {
  info: async () => ({ installed: true, running: true, dnsName: 'pc.tail0000.ts.net', state: 'Running' }),
  funnelOn: async () => ({ ok: true, message: 'Funnel on' }),
  funnelOff: async () => ({ ok: true, message: 'Funnel off' }),
  funnelActive: async () => false,
  serveOn: async () => ({ ok: true, message: 'ok' }),
  serveActive: async () => false,
};

async function connect(tok = token) {
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${tok}` } } }));
  return client;
}
type CallResult = { isError?: boolean; content: { type: string; text: string }[]; structuredContent?: Record<string, unknown> };
const call = async (c: Client, name: string, args: Record<string, unknown> = {}) => (await c.callTool({ name, arguments: args })) as unknown as CallResult;

function raw(path: string, init: { method?: string; headers?: Record<string, string>; body?: string; port?: number } = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = request({ host: '127.0.0.1', port: init.port ?? MCP, path, method: init.method ?? 'GET', headers: init.headers }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
    });
    r.on('error', reject);
    if (init.body) r.write(init.body);
    r.end();
  });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'eos-mcp-'));
  hub = await startHub({ port: HUB, mcpPort: MCP, dbFile: join(dir, 'execution-os.db'), distDir: join(dir, 'dist'), tunnel: fakeTunnel, gateway: { ctx: { clock: () => NOW } } });
  hub.db.mutate((d, now) => {
    d.wake[DATE] = { id: DATE, u: now, verifiedAt: now, method: 'qr', lateMin: 0 };
    d.settings = { ...d.settings, features: { ...(d.settings.features ?? {}), mcp: true }, u: now };
  }, 'test');
  await hub.connector.enable();
  token = hub.connector.rotate('test');
});

afterAll(async () => {
  await hub.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('gateway security', () => {
  it('refuses missing and wrong tokens with 401, then locks out after 10 failures', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const h = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Host: `127.0.0.1:${MCP}` };
    expect((await raw('/mcp', { method: 'POST', headers: h, body })).status).toBe(401);
    expect((await raw('/mcp', { method: 'POST', headers: { ...h, Authorization: 'Bearer eos_wrongwrongwrongwrongwrongwrong' }, body })).status).toBe(401);
    const attacker = { ...h, 'X-Forwarded-For': '203.0.113.9', Authorization: 'Bearer eos_wrongwrongwrongwrongwrongwrong' };
    for (let i = 0; i < 10; i++) await raw('/mcp', { method: 'POST', headers: attacker, body });
    expect((await raw('/mcp', { method: 'POST', headers: { ...attacker, Authorization: `Bearer ${token}` }, body })).status).toBe(429);
  });

  it('checks the Host header, allows only POST on /mcp and leaks nothing on /healthz', async () => {
    expect((await raw('/healthz', { headers: { Host: 'evil.example.com' } })).status).toBe(421);
    const health = await raw('/healthz', { headers: { Host: `localhost:${MCP}` } });
    expect(JSON.parse(health.body)).toEqual({ ok: true, app: 'execution-os-mcp' });
    expect((await raw('/mcp', { headers: { Host: `localhost:${MCP}`, Authorization: `Bearer ${token}` } })).status).toBe(405);
    expect((await raw('/other', { headers: { Host: `localhost:${MCP}` } })).status).toBe(404);
  });

  it('the MCP port refuses the PIN; the sync port refuses an MCP token', async () => {
    const r = await raw('/mcp', { method: 'POST', headers: { Host: `127.0.0.1:${MCP}`, 'X-EOS-PIN': hub.pin, 'Content-Type': 'application/json' }, body: '{}' });
    expect(r.status).toBe(401);
    const ip = lanAddresses()[0];
    if (!ip) return;
    const s = await fetch(`http://${ip}:${HUB}/api/sync?rev=-1`, { headers: { Authorization: `Bearer ${token}` } });
    expect(s.status).toBe(401);
  });
});

describe('tools', () => {
  it('lists exactly the catalogue, with annotations and strict schemas', async () => {
    const c = await connect();
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...CORE_TOOLS].sort());
    for (const t of tools) {
      expect(t.annotations?.openWorldHint).toBe(false);
      expect(t.annotations?.destructiveHint).toBe(false);
      expect((t.inputSchema as { additionalProperties?: boolean }).additionalProperties).toBe(false);
    }
    expect(tools.find((t) => t.name === 'get_day')?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === 'add_tasks')?.annotations?.readOnlyHint).toBe(false);
    const bad = await call(c, 'add_tasks', { tasks: [{ title: 'x', area: 'iit' }], extra: 1 });
    expect(bad.isError).toBe(true);
    const tooMany = await call(c, 'add_tasks', { tasks: Array.from({ length: 21 }, (_, i) => ({ title: `t${i}`, area: 'iit' })) });
    expect(tooMany.isError).toBe(true);
    await c.close();
  });

  it('get_overview returns HH:MM times and the time zone', async () => {
    const c = await connect();
    const r = await call(c, 'get_overview');
    expect(r.isError).toBeFalsy();
    const o = r.structuredContent as { now: string; timeZone: string; date: string; current: { start: string } };
    expect(o.date).toBe(DATE);
    expect(o.now).toMatch(/^\d{2}:\d{2}$/);
    expect(o.timeZone.length).toBeGreaterThan(0);
    expect(o.current.start).toMatch(/^\d{2}:\d{2}$/);
    await c.close();
  });

  it('add_tasks is labelled mcp:test in history, audited, and undo restores the previous state', async () => {
    const c = await connect();
    const r = await call(c, 'add_tasks', { tasks: [{ title: 'Read chapter 5', area: 'iit', priority: 1 }] });
    expect(r.isError).toBeFalsy();
    const id = (r.structuredContent as { ids: string[] }).ids[0];
    expect(hub.db.history('tasks', id)[0].device).toBe('mcp:test');
    const act = (await (await fetch(`http://127.0.0.1:${HUB}/api/ai-activity`)).json()) as { entries: { seq: number; tool: string; ok: boolean }[] };
    const entry = act.entries.find((e) => e.tool === 'add_tasks' && e.ok)!;
    expect(entry).toBeTruthy();
    const undo = await fetch(`http://127.0.0.1:${HUB}/api/ai-activity/undo`, { method: 'POST', body: JSON.stringify({ seq: entry.seq }) });
    expect(undo.status).toBe(200);
    expect(hub.db.doc.tasks[id].del).toBe(true);
    const again = await fetch(`http://127.0.0.1:${HUB}/api/ai-activity/undo`, { method: 'POST', body: JSON.stringify({ seq: entry.seq }) });
    expect(again.status).toBe(409);
    await c.close();
  });

  it('undo refuses when a later edit changed the same record', async () => {
    const c = await connect();
    const r = await call(c, 'add_tasks', { tasks: [{ title: 'Edited later', area: 'founder' }] });
    const id = (r.structuredContent as { ids: string[] }).ids[0];
    hub.db.mutate(ops.updateTask(id, { title: 'Changed by the user' }), 'PC');
    const act = (await (await fetch(`http://127.0.0.1:${HUB}/api/ai-activity`)).json()) as { entries: { seq: number; summary: string }[] };
    const entry = act.entries.find((e) => e.summary.includes('Added 1 task'))!;
    const undo = (await (await fetch(`http://127.0.0.1:${HUB}/api/ai-activity/undo`, { method: 'POST', body: JSON.stringify({ seq: entry.seq }) })).json()) as { ok: boolean; blocked: string[] };
    expect(undo.ok).toBe(false);
    expect(undo.blocked).toContain(`tasks/${id}`);
    await c.close();
  });

  it('propose_day_plan restores sleep with a warning, and refuses to overlap a pin (naming it)', async () => {
    const c = await connect();
    const r = await call(c, 'propose_day_plan', {
      date: '2026-10-08',
      blocks: [
        { title: 'Lecture 7', category: 'iit', start: '10:00', end: '12:00', mission: { title: 'Notes for lecture 7' } },
        { title: 'Late build', category: 'founder', start: '20:00', end: '22:00' },
        { title: 'Sleep', category: 'sleep', start: '23:00', end: '04:00' },
      ],
      rationale: 'test',
    });
    expect(r.isError).toBeFalsy();
    const p = (r.structuredContent as { proposal: { id: string; warnings: string[]; days: { plan: string[] }[] } }).proposal;
    expect(p.warnings.join(' ')).toMatch(/trimmed|anchors are fixed/);
    expect(p.days[0].plan.some((x) => x.startsWith('21:00–04:00 Sleep'))).toBe(true);
    hub.db.mutate(ops.addDayBlock('2026-10-08', { title: 'Doctor', category: 'care', start: (15 - 4) * 60, end: (16 - 4) * 60 }), 'PC');
    const r2 = await call(c, 'propose_day_plan', { date: '2026-10-08', blocks: [{ title: 'Deep work', category: 'founder', start: '14:30', end: '16:30' }] });
    expect(r2.isError).toBe(true);
    expect(r2.content[0].text).toMatch(/Doctor/);
    await c.close();
  });

  it('propose_rescue → apply today changes only today; a second apply says already applied', async () => {
    const c = await connect();
    const before = JSON.stringify(hub.db.doc.days['2026-10-09'] ?? null);
    const r = await call(c, 'propose_rescue', { scope: 'today' });
    expect(r.isError).toBeFalsy();
    const options = (r.structuredContent as { options: { proposalId: string; headline: string }[] }).options;
    expect(options.length).toBeGreaterThanOrEqual(1);
    const first = options[0].proposalId;
    const a = await call(c, 'apply_proposal', { proposalId: first, scope: 'today' });
    expect(a.isError).toBeFalsy();
    expect((a.structuredContent as { dates: string[] }).dates).toEqual([DATE]);
    expect(JSON.stringify(hub.db.doc.days['2026-10-09'] ?? null)).toBe(before);
    expect(hub.db.doc.days[DATE].rescue).toBeTruthy();
    const b = await call(c, 'apply_proposal', { proposalId: first, scope: 'today' });
    expect(b.isError).toBe(true);
    expect(b.content[0].text).toMatch(/already applied/);
    for (const o of options.slice(1)) expect(hub.db.doc.proposals[o.proposalId].status).toBe('superseded');
    await c.close();
  });

  it('log_session requires userConfirmed: true and turns remaining work into a task', async () => {
    const c = await connect();
    const no = await call(c, 'log_session', { date: DATE, blockId: 'b-temple', status: 'partial', note: 'x', links: [] });
    expect(no.isError).toBe(true);
    const ok = await call(c, 'log_session', { date: DATE, blockId: 'b-iit', status: 'partial', percent: 60, note: 'Q1–Q3 done', links: ['https://example.com/a3'], remaining: 'Q4 and Q5', userConfirmed: true });
    expect(ok.isError).toBeFalsy();
    const proof = hub.db.doc.proofs[`${DATE}:b-iit`];
    expect(proof).toMatchObject({ status: 'partial', loggedVia: 'mcp', confirmed: true, percent: 60 });
    expect(Object.values(hub.db.doc.tasks).some((t) => t.title.startsWith('Continue:') && !t.del)).toBe(true);
    await c.close();
  });

  it('serves resources and prompts', async () => {
    const c = await connect();
    const { resources } = await c.listResources();
    expect(resources.map((r) => r.uri).sort()).toEqual(['eos://goals', 'eos://principles', 'eos://today', 'eos://week']);
    const { prompts } = await c.listPrompts();
    expect(prompts.map((p) => p.name)).toContain('rescue_my_day');
    const p = await c.getPrompt({ name: 'plan_my_day', arguments: {} });
    expect(JSON.stringify(p.messages)).toContain(DATE);
    const pb = await call(c, 'get_playbook', { name: 'shutdown' });
    expect(pb.content[0].text).toMatch(/shutdown/i);
    await c.close();
  });
});

describe('targets through the connector', () => {
  it('creates a month → week tree and reads its progress', async () => {
    const c = await connect();
    const m = await call(c, 'upsert_goals', { goals: [{ level: 'month', period: '2026-10', title: 'Finish 4 modules', area: 'iit', metric: { kind: 'count', unit: 'modules' }, target: 4 }] });
    expect(m.isError).toBeFalsy();
    const monthId = (m.structuredContent as { ids: string[] }).ids[0];
    const w = await call(c, 'upsert_goals', { goals: [{ level: 'week', period: '2026-10-07', parentId: monthId, title: '1 module', area: 'iit', metric: { kind: 'count', unit: 'modules' }, target: 1 }] });
    expect(w.isError).toBeFalsy();
    const g = await call(c, 'get_goals', { level: 'week', period: '2026-10-05' });
    const goals = (g.structuredContent as { goals: { title: string; pace: string; period: string }[] }).goals;
    expect(goals.map((x) => x.title)).toContain('1 module');
    expect(goals[0].period).toBe('2026-10-05');
    const bad = await call(c, 'upsert_goals', { goals: [{ level: 'month', period: '2026', title: 'x', metric: { kind: 'binary' } }] });
    expect(bad.isError).toBe(true);
    await c.close();
  });
});

describe('analytics and coaching through the connector', () => {
  it('get_analytics carries the engine verdict, and post_coaching_note cannot change it', async () => {
    const c = await connect();
    const a = await call(c, 'get_analytics', { from: '2026-10-05', to: '2026-10-11' });
    expect(a.isError).toBeFalsy();
    const coach = (a.structuredContent as { coach: { grade: string; score: number; profile: string; evidence: string[] } }).coach;
    expect(coach.evidence).toHaveLength(3);
    const p = await call(c, 'post_coaching_note', { weekStart: '2026-10-05', leak: 'Afternoons', change: { cue: 'IF the founder block starts THEN open the mission' }, text: 'Short and honest.' });
    expect(p.isError).toBeFalsy();
    const note = p.structuredContent as { grade: string; score: number; profile: string };
    expect([note.grade, note.score, note.profile]).toEqual([coach.grade, coach.score, coach.profile]);
    const sneaky = await call(c, 'post_coaching_note', { leak: 'x', change: { cue: 'IF a THEN b' }, grade: 'A' });
    expect(sneaky.isError).toBe(true); // unknown field: the AI cannot pass a grade
    await c.close();
  });
});

describe('connector switch', () => {
  it('the Labs flag stops tool calls without touching data', async () => {
    hub.db.mutate(ops.setFeature('mcp', false), 'test');
    const r = await raw('/mcp', { method: 'POST', headers: { Host: `127.0.0.1:${MCP}`, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' });
    expect(r.status).toBe(503);
    hub.db.mutate(ops.setFeature('mcp', true), 'test');
  });

  it('turning it off closes the port', async () => {
    await hub.connector.disable();
    await expect(raw('/healthz', { headers: { Host: `127.0.0.1:${MCP}` } })).rejects.toThrow();
    await hub.connector.enable();
    expect((await raw('/healthz', { headers: { Host: `127.0.0.1:${MCP}` } })).status).toBe(200);
  });
});
