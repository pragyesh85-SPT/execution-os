import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HubDb } from '../server/db';
import { startHub, type Hub } from '../server/hub';
import { deadlineTaskId, hubBridge } from '../server/study/eos';
import { extractFile, readZip } from '../server/study/extract';
import { StudyService } from '../server/study/service';
import { layout } from '../server/study/vault';
import { runStudyCli } from '../server/study/cli';
import { StudyConfigFile } from '../server/study/config';
import { creditedMinutes, focusState, planFor } from '../src/core/engine';
import * as ops from '../src/core/ops';
import { DAY_MS } from '../src/core/study/ids';
import { at, claudeWrites, FIXTURE, sampleVault } from './study-helpers';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('extraction', () => {
  const inc = join(FIXTURE, 'incoming', 'Demo Vectors');
  it('reads pptx slides in order with speaker notes, docx paragraphs and timed subtitles', () => {
    const p = extractFile(join(inc, 'Week 1', 'Lecture 2 slides.pptx'));
    expect(p).toMatchObject({ method: 'pptx', pages: 3, needsClaude: false });
    expect(p.text.indexOf('## Slide 2')).toBeLessThan(p.text.indexOf('## Slide 10'));
    expect(p.text).toContain('sqrt(v & v)');
    expect(p.text).toContain('> Notes: Remind students about normalising');
    expect(extractFile(join(inc, 'Week 2', 'handout-notes.docx')).text).toBe('Matrix multiplication\nRow times column, entry by entry.');
    const v = extractFile(join(inc, 'Week 1', 'lecture1-transcript.vtt'));
    expect(v.text.split('\n')).toEqual(['[00:00:01] Welcome to week one. Today we talk about vectors.', '[00:01:10] A linear combination scales and adds vectors.', '[00:12:03] The dot product multiplies matching entries and adds them up.']);
    expect(extractFile(join(FIXTURE, 'incoming', 'Demo Probability', 'Week 1', 'whiteboard screenshot.png'))).toMatchObject({ needsClaude: true, text: '' });
    expect(() => readZip(Buffer.from('not a zip'))).toThrow();
  });
});

describe('ingestion end to end (synthetic sample subject)', () => {
  let svc: StudyService;
  let root: string;
  let now = at(2026, 10, 28, 9);

  beforeAll(() => {
    const v = sampleVault('eos-study1-');
    dirs.push(v.dir);
    root = v.root;
    svc = new StudyService({ vault: root, clock: () => now });
  });
  afterAll(() => svc.close());

  it('copies, classifies, extracts and de-duplicates every asset, and parks unknown ones', () => {
    const r = svc.ingest({ folder: join(FIXTURE, 'incoming') });
    const byId = Object.fromEntries(r.added.map((a) => [a.id, a]));
    expect(r.added).toHaveLength(8);
    expect(byId['demo-w1-demo-week1-slides']).toMatchObject({ subject: 'demo', type: 'slides', week: 1, needsClaude: false });
    expect(byId['demo-w1-lecture1-transcript']).toMatchObject({ type: 'transcript', week: 1 });
    expect(byId['demo-w1-lecture-2-slides']).toMatchObject({ type: 'slides' });
    expect(byId['demo-w2-quiz-week2']).toMatchObject({ type: 'quiz', week: 2 });
    expect(byId['demo-w2-handout-notes']).toMatchObject({ type: 'notes' });
    expect(byId['dprob-w1-whiteboard-screenshot']).toMatchObject({ subject: 'dprob', type: 'screenshot', needsClaude: true });
    expect(byId['demo-demo-syllabus']).toMatchObject({ type: 'syllabus' });
    expect(r.duplicates).toHaveLength(1);
    expect(r.unsorted).toEqual(['random-file.txt']);
    expect(existsSync(join(root, 'inbox', 'unsorted', 'unsorted-random-file.txt'))).toBe(true);
    // the original is kept byte for byte; the text goes to extracted/ with its references
    const L = layout(root);
    expect(readFileSync(join(L.subject('demo'), 'assets', 'demo-w1-demo-week1-slides.md'))).toEqual(readFileSync(join(FIXTURE, 'incoming', 'Demo Vectors', 'Week 1', 'demo-week1-slides.md')));
    const ex = readFileSync(join(L.subject('demo'), 'extracted', 'demo-w1-lecture1-transcript.md'), 'utf8');
    expect(ex).toContain('asset: demo-w1-lecture1-transcript');
    expect(ex).toContain('[00:12:03] The dot product');
    // the outline in the download filled the empty syllabus, and every topic became a stub
    expect(r.syllabusWritten).toEqual(['semesters/s1/subjects/demo/syllabus.md']);
    expect(r.index.stubs).toBe(5); // the dprob stubs were made when the vault opened (its syllabus was pasted by hand)
    expect(svc.conceptList().map((c) => c.id)).toEqual([
      'demo-vectors-and-linear-combinations',
      'demo-dot-product',
      'demo-vector-norms',
      'demo-matrix-multiplication',
      'demo-matrix-inverse',
      'dprob-sample-spaces-and-events',
      'dprob-conditional-probability',
      'dprob-discrete-random-variables',
      'dprob-expectation',
    ]);
    expect(svc.conceptList().every((c) => c.status === 'stub')).toBe(true);
    // week-2 assets are in, so week-2 stubs count as released
    expect(svc.conceptList().find((c) => c.id === 'demo-matrix-inverse')!.released).toBe(true);
    expect(svc.conceptList().find((c) => c.id === 'dprob-expectation')!.released).toBe(false);
    expect(svc.pending()).toMatchObject({ newAssets: expect.arrayContaining(['demo-w1-demo-week1-slides']), unsorted: ['inbox/unsorted/unsorted-random-file.txt'] });
  });

  it('is safe to re-run: nothing is copied twice', () => {
    const r = svc.ingest({ folder: join(FIXTURE, 'incoming') });
    expect(r.added).toHaveLength(0);
    expect(r.duplicates).toHaveLength(10); // the 8 assets, the parked file and the copy
    expect(r.index.stubs).toBe(0);
  });

  it('indexes what Claude writes, merges duplicates and reports files that do not parse', () => {
    claudeWrites(root);
    writeFileSync(join(layout(root).subject('demo'), 'paths', 'broken.yaml'), 'concept: demo-x\nsegments:\n  - url: not-a-url\n    source: x\n');
    const r = svc.reindex();
    expect(r.errors).toEqual([{ path: 'semesters/s1/subjects/demo/paths/broken.yaml', error: expect.stringContaining('segments.0.url') }]);
    const list = svc.conceptList();
    expect(list).toHaveLength(9); // demo-vector-length is merged into demo-vector-norms
    expect(list.find((c) => c.id === 'demo-dot-product')).toMatchObject({ status: 'ready', hasPath: true, hasPack: true, hasLab: true });
    const v = svc.conceptView({ id: 'demo-vector-length' });
    expect(v.concept.id).toBe('demo-vector-norms');
    const dot = svc.conceptView({ id: 'demo-dot-product' });
    expect(dot.pack!.questions[0]).toEqual({ id: 'q1', q: '(1, 2) · (3, 4) = ?', kind: 'numeric' }); // no answer leaves the hub
    expect(dot.pack!.keyPoints).toBe(5);
    expect(dot.lab).not.toHaveProperty('hiddenTests');
    expect(dot.hintsOnly).toBe(true); // part of the live graded Assignment 1
    expect(svc.status().errors).toHaveLength(1);
    rmSync(join(layout(root).subject('demo'), 'paths', 'broken.yaml'));
    expect(svc.reindex().errors).toEqual([]);
  });

  it('serves the queue: the first concept with a resource, watch first', () => {
    const q = svc.next().items;
    expect(q[0]).toMatchObject({ kind: 'learn', concept: 'demo-vectors-and-linear-combinations', step: 'watch', segment: { source: '3Blue1Brown' }, minutes: 10 });
    const dot = q.find((i) => i.kind === 'learn' && i.concept === 'demo-dot-product')!;
    expect(dot.why).toMatch(/Needs Vectors and linear combinations first/);
  });

  it('runs the learning loop on evidence and reaches Applied, then Retained', () => {
    const c = 'demo-vectors-and-linear-combinations';
    svc.log({ kind: 'segment_done', concept: c, data: { index: 0 }, source: 'app' });
    expect(svc.conceptView({ id: c }).state).toMatchObject({ rung: 'seen', nextStep: 'explain' });
    svc.log({ kind: 'explain', concept: c, data: { coverage: 1, pass: true }, source: 'tutor' });
    for (const q of ['q1', 'q2', 'q3']) svc.log({ kind: 'quick', concept: c, data: { question: q, correct: true }, source: 'tutor' });
    expect(svc.conceptView({ id: c }).state.rung).toBe('applied');
    expect(svc.progress()).toMatchObject({ coverage: 1 / 9 });
    expect(() => svc.log({ kind: 'explain', concept: c, data: { coverage: 2, pass: true } })).toThrow(/between 0 and 1/);
    expect(() => svc.log({ kind: 'quick', concept: 'nope', data: { question: 'q', correct: true } })).toThrow(/Unknown concept/);
    now += 4 * DAY_MS;
    expect(svc.next().items[0]).toMatchObject({ kind: 'review', concept: c });
    svc.log({ kind: 'review', concept: c, data: { grade: 3 } });
    expect(svc.conceptView({ id: c }).state.rung).toBe('retained');
    expect(svc.progress().readiness).toBeGreaterThan(0);
  });

  it('puts a repair at the top after the same mistake twice', () => {
    svc.log({ kind: 'mistake', concept: 'demo-dot-product', data: { cls: 'formula_recall', detail: 'dot' } });
    expect(svc.next().items[0].kind).not.toBe('repair');
    svc.log({ kind: 'mistake', concept: 'demo-dot-product', data: { cls: 'formula_recall', detail: 'dot' } });
    expect(svc.next().items[0]).toMatchObject({ kind: 'repair', concept: 'demo-dot-product', why: expect.stringContaining('formula recall: dot') });
    svc.log({ kind: 'repair_done', concept: 'demo-dot-product', data: { key: svc.repairs()[0].key } });
    expect(svc.next().items[0].kind).not.toBe('repair');
  });

  it('ends hints-only once the graded assignment is submitted, and writes STATE.md', () => {
    svc.deadlineSubmit({ id: 'demo-a1' });
    expect(svc.conceptView({ id: 'demo-dot-product' }).hintsOnly).toBe(false);
    const s = svc.writeState();
    expect(s.text).toContain('# STATE — ');
    expect(s.text).toContain('| Demo Vectors and Matrices (demo) | 5 | 1 |');
    expect(s.text).toContain('## Next 10 in the queue');
    expect(s.text).toContain('IITJ deadlines');
    expect(readFileSync(join(root, 'STATE.md'), 'utf8')).toBe(s.text);
    expect(svc.progress().iitj).toMatchObject({ assignments: 2, assignmentsSubmitted: 1 });
  });
});

describe('Study OS inside Execution OS', () => {
  let db: HubDb;
  let svc: StudyService;
  let clock = at(2026, 10, 28, 10, 30);
  const set = (t: number) => {
    clock = t;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(t);
  };

  beforeAll(() => {
    const v = sampleVault('eos-study1b-');
    dirs.push(v.dir);
    claudeWrites(v.root);
    db = new HubDb(join(v.dir, 'eos', 'execution-os.db'));
    svc = new StudyService({ vault: v.root, clock: () => clock, eos: hubBridge(db, () => clock) });
  });
  afterAll(() => {
    svc.close();
    db.close();
  });

  it('starts inside an IIT block, turns Focus Guard on and fills the proof on Stop', () => {
    set(at(2026, 10, 28, 10, 30));
    const s = svc.start({ concept: 'demo-dot-product' });
    expect(s.eos).toMatchObject({ how: 'block', blockId: 'b-iit', date: '2026-10-28' });
    const sess = db.doc.sessions[s.eos!.sessionId];
    expect(sess).toMatchObject({ source: 'study', studySessionId: s.id, label: 'Studying: Dot product (Study OS)', category: 'iit' });
    expect(focusState(db.doc, clock).active).toBe(true);
    svc.log({ kind: 'segment_done', concept: 'demo-dot-product', data: { index: 0 } });
    svc.log({ kind: 'quick', concept: 'demo-dot-product', data: { question: 'q1', correct: true } });
    set(at(2026, 10, 28, 11, 0));
    const r = svc.stop();
    expect(r.line).toBe('1 concept, 1 question 100%, 1 moved up (Dot product → Seen)');
    const proof = db.doc.proofs['2026-10-28:b-iit'];
    expect(proof).toMatchObject({ loggedVia: 'study', status: 'done', confirmed: true });
    expect(proof.links).toEqual([`#study/session/${s.id}`]);
    expect(db.doc.sessions[s.eos!.sessionId].end).toBe(clock);
    expect(svc.session({ id: s.id }).report).toMatchObject({ minutes: 30, questions: 1 });
  });

  it('swaps the current block to study outside an IIT block, and counts the time as study', () => {
    set(at(2026, 10, 28, 13, 0));
    const s = svc.start({ concept: 'demo-dot-product' });
    expect(s.eos!.how).toBe('swap');
    const plan = planFor(db.doc, '2026-10-28');
    expect(plan.missions['b-founder']?.title).toBe('Studying: Dot product (Study OS)');
    expect(plan.overrides?.at(-1)).toMatchObject({ kind: 'swap', blockId: 'b-founder' });
    set(at(2026, 10, 28, 13, 40));
    svc.stop();
    expect(creditedMinutes(db.doc, '2026-10-28', 'iit', clock)).toBe(70); // 30 in the IIT block + 40 swapped
    expect(creditedMinutes(db.doc, '2026-10-28', 'founder', clock)).toBe(0);
    // a second start in the same swapped block does not swap again
    set(at(2026, 10, 28, 14, 0));
    expect(svc.start({}).eos!.how).toBe('block');
    svc.stop();
  });

  it('adds a live block when the day has none now, and starts without a block during sleep', () => {
    set(at(2026, 10, 29, 9, 0));
    db.mutate((d, now) => {
      const p = ops.ensurePlan(d, '2026-10-29', now);
      p.blocks = p.blocks.filter((b) => b.origin !== 'b-meal1' && b.origin !== 'b-plan');
    }, 'test');
    const s = svc.start({ concept: 'dprob-conditional-probability' });
    expect(s.eos!.how).toBe('live');
    const b = planFor(db.doc, '2026-10-29').blocks.find((x) => x.id === s.eos!.blockId)!;
    expect(b).toMatchObject({ category: 'iit', title: 'Studying: Conditional probability (Study OS)' });
    expect(b.e - b.s).toBe(60);
    svc.stop();
    set(at(2026, 10, 29, 22, 0));
    const night = svc.start({});
    expect(night.eos).toMatchObject({ how: 'none', blockId: `study:${night.id}` });
    set(at(2026, 10, 29, 22, 20));
    svc.stop();
    expect(creditedMinutes(db.doc, '2026-10-29', 'iit', clock)).toBe(20);
  });

  it('marks drift once after 10 idle minutes and stops a session left for 90', () => {
    set(at(2026, 10, 30, 10, 0));
    svc.start({ concept: 'demo-dot-product' });
    set(at(2026, 10, 30, 10, 9));
    expect(svc.checkDrift()).toBe('none');
    set(at(2026, 10, 30, 10, 11));
    expect(svc.checkDrift()).toBe('drift');
    expect(svc.checkDrift()).toBe('none');
    const d = Object.values(db.doc.distractions).filter((x) => x.source === 'Study OS (no activity)');
    expect(d).toHaveLength(1);
    svc.activity();
    set(at(2026, 10, 30, 10, 25));
    expect(svc.checkDrift()).toBe('drift');
    set(at(2026, 10, 30, 12, 0));
    expect(svc.checkDrift()).toBe('stopped');
    expect(svc.liveSession()).toBeNull();
    expect(db.doc.proofs['2026-10-30:b-iit'].status).toBe('partial');
  });

  it('keeps the synced summary current without rewriting it when nothing changed', () => {
    set(at(2026, 10, 30, 15, 0));
    expect(svc.pushSummary()).toBe(true);
    const s = db.doc.study.summary;
    expect(s).toMatchObject({ id: 'summary', date: '2026-10-30', readyBy: '2026-11-15', examStart: '2026-11-30', next: { subject: expect.any(String) } });
    expect(Object.keys(s).sort()).toEqual(expect.arrayContaining(['coverage', 'readiness', 'pace', 'minutesToday', 'testsDue', 'reviewsDue', 'repairs']));
    const rev = db.rev;
    expect(svc.pushSummary()).toBe(false);
    expect(db.rev).toBe(rev);
    expect(JSON.stringify(db.doc.study).length).toBeLessThan(1500); // small: it goes to every phone
  });

  it('turns IITJ deadlines into iit tasks and ticks them off on submit', () => {
    svc.reindex();
    const t = db.doc.tasks[deadlineTaskId('demo-a1')];
    expect(t).toMatchObject({ area: 'iit', deadline: '2026-11-02', priority: 1, done: false, title: 'Demo Vectors and Matrices: Assignment 1' });
    expect(db.doc.tasks[deadlineTaskId('dprob-q1')]).toMatchObject({ priority: 2 });
    const rev = db.rev;
    svc.syncDeadlines();
    expect(db.rev).toBe(rev); // unchanged deadlines are not rewritten
    svc.deadlineSubmit({ id: 'demo-a1' });
    expect(db.doc.tasks[deadlineTaskId('demo-a1')].done).toBe(true);
  });
});

describe('hub API and the CLI through the hub', () => {
  const PORT = 47996;
  let hub: Hub;
  let dir: string;
  beforeAll(async () => {
    const v = sampleVault('eos-study1c-');
    dir = v.dir;
    dirs.push(dir);
    claudeWrites(v.root);
    hub = await startHub({ port: PORT, dbFile: join(dir, 'eos', 'execution-os.db'), distDir: join(dir, 'dist'), study: { vault: v.root, watch: false } });
    hub.db.mutate(ops.setFeature('study', true), 'test');
    new StudyConfigFile(hub.db.file).write({ vault: v.root });
  });
  afterAll(async () => {
    await hub.close();
  });

  it('serves the overview and pushes the summary into the synced doc', async () => {
    const o = (await (await fetch(`http://127.0.0.1:${PORT}/api/study/overview`)).json()) as { next: { concept: string }; subjects: unknown[]; header: { readyBy: string } };
    expect(o.header.readyBy).toBe('2026-11-15');
    expect(o.subjects).toHaveLength(2);
    expect(o.next.concept).toBe('demo-vectors-and-linear-combinations');
    const doc = (await (await fetch(`http://127.0.0.1:${PORT}/api/sync?rev=-1`)).json()) as { doc: { study: { summary?: { readyBy: string } } } };
    expect(doc.doc.study.summary?.readyBy).toBe('2026-11-15');
  });

  it('refuses writes over GET and local-only methods from other devices', async () => {
    expect((await fetch(`http://127.0.0.1:${PORT}/api/study/start`)).status).toBe(405);
  });

  it('lets the CLI work through the running hub (one writer)', async () => {
    const out: string[] = [];
    const env = { eosDb: hub.db.file, port: PORT, out: (s: string) => out.push(s), err: (s: string) => out.push(`ERR ${s}`) };
    expect(await runStudyCli(['status', '--json'], env)).toBe(0);
    expect(JSON.parse(out.join('\n'))).toMatchObject({ mode: 'hub', semester: 's1' });
    out.length = 0;
    expect(await runStudyCli(['log', 'segment_done', 'demo-vectors-and-linear-combinations', '{"index":0}', '--source', 'claude'], env)).toBe(0);
    expect(out[0]).toMatch(/now seen/);
    expect(hub.study.service()!.db.events({ kind: 'segment_done' })[0].source).toBe('claude');
    out.length = 0;
    expect(await runStudyCli(['pending', '--quiet'], env)).toBe(10); // nothing waiting
    expect(await runStudyCli(['concepts', 'dprob'], env)).toBe(0);
    expect(out.join('\n')).toContain('dprob-conditional-probability');
  });
});
