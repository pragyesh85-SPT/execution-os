import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startHub, type Hub } from '../server/hub';
import { CORE_TOOLS } from '../server/mcp/tools';
import type { Tunnel } from '../server/tunnel';
import { StudyService } from '../server/study/service';
import { isIitj } from '../server/study/portfolio';
import { layout } from '../server/study/vault';
import * as ops from '../src/core/ops';
import { youtubeId } from '../src/core/study/ids';
import { claudeWrites, sampleVault } from './study-helpers';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function vault(prefix: string) {
  const v = sampleVault(prefix);
  dirs.push(v.dir);
  claudeWrites(v.root);
  return v;
}

describe('proposals with undo', () => {
  let svc: StudyService;
  let root: string;
  beforeAll(() => {
    root = vault('eos-study3a-').root;
    svc = new StudyService({ vault: root });
  });
  afterAll(() => svc.close());

  const seg = { kind: 'intuition' as const, url: 'https://www.youtube.com/watch?v=abcdefghijk', start: 30, end: 400, source: 'StatQuest', why: 'Shorter and more visual.' };

  it('validates before saving and changes nothing until applied', () => {
    expect(() => svc.proposals.propose({ kind: 'path', change: { concept: 'demo-dot-product', segments: [{ ...seg, url: 'nope' }] } })).toThrow(/url/);
    expect(() => svc.proposals.propose({ kind: 'graph', change: { concept: 'demo-dot-product', prereqs: ['does-not-exist'] } })).toThrow(/Unknown concept/);
    const file = join(layout(root).subject('demo'), 'paths', 'demo-dot-product.yaml');
    const before = readFileSync(file, 'utf8');
    const p = svc.proposals.propose({ kind: 'path', change: { concept: 'demo-dot-product', segments: [seg] }, rationale: 'more visual', client: 'mcp' });
    expect(p).toMatchObject({ status: 'pending', kind: 'path' });
    expect(readFileSync(file, 'utf8')).toBe(before);
    const r = svc.proposals.apply({ id: p.id, by: 'Android' });
    expect(svc.conceptView({ id: 'demo-dot-product' }).path!.segments).toEqual([expect.objectContaining({ source: 'StatQuest', start: 30, end: 400 })]);
    expect(svc.conceptView({ id: 'demo-dot-product' }).path!.alternates).toHaveLength(1); // kept
    expect(() => svc.proposals.apply({ id: p.id })).toThrow(/already applied/);
    svc.proposals.undo({ seq: r.audit });
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(() => svc.proposals.undo({ seq: r.audit })).toThrow(/Already undone/);
  });

  it('edits links on the card, and refuses an undo that would overwrite newer work', () => {
    const p = svc.proposals.propose({ kind: 'graph', change: { concept: 'demo-dot-product', prereqs: [], confusedWith: ['demo-vectors-and-linear-combinations'] } });
    const r = svc.proposals.apply({ id: p.id });
    expect(svc.conceptView({ id: 'demo-dot-product' }).concept).toMatchObject({ prereqs: [], confusedWith: ['demo-vectors-and-linear-combinations'], title: 'Dot product' });
    const file = join(root, svc.model().concepts.get('demo-dot-product')!.file);
    writeFileSync(file, readFileSync(file, 'utf8').replace('Zero means', 'A zero result means'));
    expect(() => svc.proposals.undo({ seq: r.audit })).toThrow(/changed after this edit/);
    const q = svc.proposals.propose({ kind: 'graph', change: { concept: 'dprob-conditional-probability', prereqs: ['dprob-sample-spaces-and-events'] } });
    expect(svc.proposals.reject({ id: q.id })).toEqual({ ok: true });
    expect(svc.proposals.list({ status: 'pending' })).toEqual([]);
  });
});

describe('capture, portfolio, graph report and the offline pack', () => {
  let svc: StudyService;
  let root: string;
  beforeAll(() => {
    root = vault('eos-study3b-').root;
    svc = new StudyService({ vault: root });
  });
  afterAll(() => svc.close());

  it('captures into the inbox for the next ingest', () => {
    const r = svc.capture({ text: 'Why is det(A − λI) = 0?', subject: 'demo', from: 'Android' });
    expect(r.file).toMatch(/^inbox\/\d{8}-\d{6}-capture\.md$/);
    expect(readFileSync(join(root, r.file), 'utf8')).toContain('from: Android');
    expect(svc.pending().inbox).toContain(r.file);
    expect(() => svc.capture({ text: '  ' })).toThrow();
  });

  it('builds the portfolio from evidence and never includes IITJ material', async () => {
    svc.log({ kind: 'segment_done', concept: 'dprob-conditional-probability', data: { index: 1 } });
    svc.log({ kind: 'segment_done', concept: 'demo-dot-product', data: { index: 1 } });
    // an IITJ lecture added to a path must not appear
    const p = join(layout(root).subject('demo'), 'paths', 'demo-vectors-and-linear-combinations.yaml');
    writeFileSync(p, readFileSync(p, 'utf8').replace('source: 3Blue1Brown', 'source: IIT Jodhpur lecture'));
    svc.reindex();
    svc.log({ kind: 'segment_done', concept: 'demo-vectors-and-linear-combinations', data: { index: 0 } });
    const r = svc.portfolio();
    expect(r.totals).toMatchObject({ concepts: 2, universities: 2 });
    const j = JSON.parse(readFileSync(join(root, 'portfolio', 'portfolio.json'), 'utf8')) as { entries: { university: string; segment: string }[] };
    expect(j.entries.map((e) => e.university).sort()).toEqual(['Harvard', 'MIT']);
    expect(j.entries.find((e) => e.university === 'Harvard')!.segment).toBe('2:00–14:00');
    const md = readFileSync(join(root, 'portfolio', 'index.md'), 'utf8');
    expect(md).toContain('### MIT (1)');
    expect(md).not.toMatch(/jodhpur|iitj/i);
    expect(readFileSync(join(root, 'portfolio', 'index.html'), 'utf8')).toContain('<title>Learning portfolio</title>');
    expect(isIitj({ source: 'NPTEL', url: 'https://iitj.ac.in/x' })).toBe(true);
  });

  it('reports duplicates, broken links and cycles for the week-end cleanup', () => {
    const dir = join(layout(root).subject('demo'), 'concepts');
    writeFileSync(join(dir, 'demo-the-dot-products.md'), '---\ntitle: The dot products\nprereqs: [demo-nope]\n---\n');
    writeFileSync(join(dir, 'demo-c1.md'), '---\ntitle: Cycle one\nprereqs: [demo-c2]\n---\n');
    writeFileSync(join(dir, 'demo-c2.md'), '---\ntitle: Cycle two\nprereqs: [demo-c1]\n---\n');
    svc.reindex();
    const g = svc.dedupe();
    expect(g.duplicates).toContainEqual({ a: 'demo-dot-product', b: 'demo-the-dot-products', similarity: 1 });
    expect(g.broken).toContainEqual({ concept: 'demo-the-dot-products', field: 'prereqs', target: 'demo-nope', problem: 'does not exist' });
    expect(g.broken).toContainEqual(expect.objectContaining({ concept: 'demo-vector-length', field: 'mergedInto' }));
    expect(g.cycles.length).toBeGreaterThan(0);
  });

  it('packs the next three items with their checks (no answers) for the phone', () => {
    const p = svc.offlinePack();
    expect(p.items.length).toBeLessThanOrEqual(3);
    expect(p.items.length).toBeGreaterThan(0);
    const text = JSON.stringify(p);
    expect(text).not.toContain('"answer"');
    expect(text).not.toContain('hidden_test');
    expect(p.overview.header?.readyBy).toBe('2026-11-15');
  });

  it('recognises YouTube links for the embedded player', () => {
    expect(youtubeId('https://www.youtube.com/watch?v=LyGKycYT2v0&t=3')).toBe('LyGKycYT2v0');
    expect(youtubeId('https://youtu.be/k7RM-ot2NWY')).toBe('k7RM-ot2NWY');
    expect(youtubeId('https://seeing-theory.brown.edu/')).toBeNull();
  });
});

describe('MCP: study tools on the existing connector', () => {
  const HUB = 47997;
  const MCP = 47998;
  let hub: Hub;
  let token: string;
  const fakeTunnel: Tunnel = {
    info: async () => ({ installed: true, running: true, dnsName: 'pc.tail0000.ts.net', state: 'Running' }),
    funnelOn: async () => ({ ok: true, message: 'ok' }),
    funnelOff: async () => ({ ok: true, message: 'ok' }),
    funnelActive: async () => false,
    serveOn: async () => ({ ok: true, message: 'ok' }),
    serveActive: async () => false,
  };
  const connect = async () => {
    const c = new Client({ name: 'test', version: '1.0.0' });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${MCP}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    return c;
  };
  type R = { isError?: boolean; content: { text: string }[]; structuredContent?: Record<string, unknown> };
  const call = async (c: Client, name: string, args: Record<string, unknown> = {}) => (await c.callTool({ name, arguments: args })) as unknown as R;

  beforeAll(async () => {
    const v = vault('eos-study3c-');
    hub = await startHub({ port: HUB, mcpPort: MCP, dbFile: join(v.dir, 'eos', 'execution-os.db'), distDir: join(v.dir, 'dist'), tunnel: fakeTunnel, gateway: { rateLimitPerMin: 1000 }, study: { vault: v.root, watch: false } });
    hub.db.mutate((d, now) => {
      d.settings = { ...d.settings, features: { ...(d.settings.features ?? {}), mcp: true }, u: now };
    }, 'test');
    await hub.connector.enable();
    token = hub.connector.rotate('test');
  });
  afterAll(async () => {
    await hub.close();
  });

  it('adds no study tools while the flag is off', async () => {
    const c = await connect();
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names.filter((n) => n.startsWith('study_'))).toEqual([]);
    expect(names).toEqual(expect.arrayContaining([...CORE_TOOLS]));
    await c.close();
  });

  it('serves the overview, queue and progress, captures, logs confirmed attempts and proposes changes', async () => {
    hub.db.mutate(ops.setFeature('study', true), 'test');
    const c = await connect();
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['study_overview', 'study_next', 'study_progress', 'study_test_report', 'study_capture', 'study_log_attempt', 'study_propose']));
    const o = await call(c, 'study_overview');
    expect(o.isError).toBeFalsy();
    expect(o.content[0].text).toMatch(/ready by 2026-11-15/);
    expect((await call(c, 'study_next', { limit: 3 })).structuredContent?.items).toHaveLength(3);
    expect((await call(c, 'study_progress')).content[0].text).toMatch(/do not change them/);
    expect((await call(c, 'study_test_report')).content[0].text).toMatch(/No 3-day test has been graded yet/);
    expect((await call(c, 'study_capture', { text: 'Doubt about conditional probability' })).content[0].text).toMatch(/Captured to inbox\//);
    expect((await call(c, 'study_log_attempt', { concept: 'demo-dot-product', kind: 'review', grade: 3 })).isError).toBe(true); // needs userConfirmed
    const logged = await call(c, 'study_log_attempt', { concept: 'demo-dot-product', kind: 'segment_done', userConfirmed: true });
    expect(logged.content[0].text).toMatch(/now Seen/);
    expect(hub.study.service()!.db.events({ kind: 'segment_done' })[0].source).toBe('mcp');
    const bad = await call(c, 'study_log_attempt', { concept: 'nope', kind: 'segment_done', userConfirmed: true });
    expect(bad.content[0].text).toMatch(/^Unknown concept/);
    const prop = await call(c, 'study_propose', { kind: 'graph', concept: 'dprob-conditional-probability', confusedWith: ['dprob-expectation'], rationale: 'often mixed up' });
    expect(prop.content[0].text).toMatch(/waiting in the Study tab/);
    expect(hub.study.service()!.proposals.list({ status: 'pending' })).toHaveLength(1);
    await c.close();
    // every call is in the AI activity log
    const act = (await (await fetch(`http://127.0.0.1:${HUB}/api/ai-activity`)).json()) as { entries: { tool: string }[] };
    expect(act.entries.map((e) => e.tool)).toEqual(expect.arrayContaining(['study_overview', 'study_propose', 'study_log_attempt']));
  });

  it('keeps the tutor key on the PC and applies proposals over the Study API', async () => {
    const base = `http://127.0.0.1:${HUB}/api/study`;
    const cfg = (await (await fetch(`${base}/tutorConfig`, { method: 'POST', body: JSON.stringify({ provider: 'anthropic', model: 'claude-haiku-4-5', apiKey: 'sk-ant-test-key', monthlyCapUsd: 3 }) })).json()) as Record<string, unknown>;
    expect(cfg).toMatchObject({ provider: 'anthropic', hasKey: true, monthlyCapUsd: 3 });
    expect(JSON.stringify(cfg)).not.toContain('sk-ant-test-key');
    expect(existsSync(join(hub.db.file, '..', 'study.json'))).toBe(true);
    const pending = (await (await fetch(`${base}/proposals`, { method: 'POST', body: '{"status":"pending"}' })).json()) as { proposals: { id: string }[] };
    const r = (await (await fetch(`${base}/proposalApply`, { method: 'POST', body: JSON.stringify({ id: pending.proposals[0].id }) })).json()) as { ok: boolean; audit: number };
    expect(r.ok).toBe(true);
    const ch = (await (await fetch(`${base}/changes`, { method: 'POST', body: '{}' })).json()) as { changes: { seq: number; actor: string }[] };
    expect(ch.changes[0]).toMatchObject({ seq: r.audit, actor: 'this PC' });
    expect(((await (await fetch(`${base}/undo`, { method: 'POST', body: JSON.stringify({ seq: r.audit }) })).json()) as { ok: boolean }).ok).toBe(true);
  });
});
