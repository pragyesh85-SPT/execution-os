import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { METHODS } from '../server/study/api';
import { NO_TUTOR } from '../server/study/config';
import { JOBS, readCommand, runJob, type JobClient } from '../server/study/jobs';
import { findPython, runHidden } from '../server/study/labs';
import { StudyService } from '../server/study/service';
import { providerFrom, type TutorProvider } from '../server/study/tutor';
import { layout } from '../server/study/vault';
import { DAY_MS } from '../src/core/study/ids';
import { allocate } from '../src/core/study/testmix';
import { gradeExact, keywordExplain, readExplainVerdict, readNumber, wrongFeedback } from '../src/core/study/tutor';
import type { CheckPack } from '../src/core/study/types';
import { at, claudeWrites, FIXTURE, sampleVault } from './study-helpers';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const hasPython = !!findPython();

function vault(prefix: string) {
  const v = sampleVault(prefix);
  dirs.push(v.dir);
  claudeWrites(v.root);
  return v;
}
const client = (svc: StudyService): JobClient => ({ call: async (m, p = {}) => (await METHODS[m].run(svc, p, { local: true, device: 'cli' })) as never });

const pack: CheckPack = {
  concept: 'c',
  keyPoints: [
    { id: 'k1', text: 'Multiply matching entries and add', keywords: ['multiply', 'add'] },
    { id: 'k2', text: 'The result is a scalar', keywords: ['scalar'] },
  ],
  misconceptions: [],
  questions: [
    { id: 'n', q: '1/3?', answer: '0.3333', kind: 'numeric', tolerance: 0.001 },
    { id: 'm', q: 'pick', answer: 'scalar', kind: 'mcq', options: ['vector', 'scalar'] },
  ],
  formulas: [],
  hints: ['h1', 'h2'],
  file: 'x',
};

describe('Quick Tutor rules (pure)', () => {
  it('keeps only key points that exist in the pack and decides the pass itself', () => {
    const v = readExplainVerdict(pack, 'Sure! ```json\n{"covered":["k1","k2","k9"],"missed":[],"wrong":[],"feedback":"Good.","mistakes":[{"cls":"made_up"}],"confidence":"high"}\n```');
    expect(v).toMatchObject({ covered: ['k1', 'k2'], coverage: 1, pass: true, mistakes: [], confidence: 'high' });
    const w = readExplainVerdict(pack, '{"covered":["k1","k2"],"wrong":[{"id":"k2","why":"said vector"}],"pass":true}');
    expect(w).toMatchObject({ covered: ['k1'], missed: [], pass: false, confidence: 'low' }); // the model cannot pass it
    expect(readExplainVerdict(pack, 'no json here')).toBeNull();
  });

  it('grades numbers and choices exactly, and hides answers while an assignment is live', () => {
    expect(readNumber('x = 1/3')).toBeCloseTo(1 / 3);
    expect(gradeExact(pack.questions[0], '1/3')).toBe(true);
    expect(gradeExact(pack.questions[0], '0.35')).toBe(false);
    expect(gradeExact(pack.questions[1], 'b')).toBe(true);
    expect(gradeExact(pack.questions[1], 'Scalar')).toBe(true);
    expect(gradeExact(pack.questions[1], 'a')).toBe(false);
    expect(wrongFeedback(pack.questions[1], 'h1', true)).toBe('Not yet. Hint: h1');
    expect(wrongFeedback(pack.questions[1], 'h1', false)).toContain('Expected: scalar.');
    expect(keywordExplain(pack, 'You multiply then add them up.')).toMatchObject({ covered: ['k1'], coverage: 0.5, pass: false, confidence: 'low' });
  });

  it('builds providers only from explicit settings (none by default)', () => {
    expect(providerFrom(NO_TUTOR)).toBeNull();
    expect(providerFrom({ ...NO_TUTOR, provider: 'anthropic', model: 'claude-haiku-4-5' })).toBeNull(); // no key
    expect(providerFrom({ ...NO_TUTOR, provider: 'ollama', model: 'llama3.2' })?.name).toBe('ollama:llama3.2');
  });

  it('splits a test 40/25/20/15 and hands empty buckets on', () => {
    expect(allocate(5, { new: 3, retention: 2, mistake: 2, transfer: 2 })).toEqual({ new: 2, retention: 1, mistake: 1, transfer: 1 });
    expect(allocate(5, { new: 3, retention: 0, mistake: 0, transfer: 1 })).toEqual({ new: 4, retention: 0, mistake: 0, transfer: 1 });
    expect(allocate(4, { new: 0, retention: 0, mistake: 0, transfer: 0 })).toEqual({ new: 0, retention: 0, mistake: 0, transfer: 0 });
  });
});

describe('Quick Tutor on the hub (mock provider)', () => {
  let svc: StudyService;
  let calls: { system: string; user: string }[] = [];
  let reply = '';
  let capUsd = 5;
  const C = 'demo-dot-product';
  const mock: TutorProvider = {
    name: 'mock',
    complete: async (system, user) => {
      calls.push({ system, user });
      return reply;
    },
  };
  beforeAll(() => {
    const v = vault('eos-study2a-');
    svc = new StudyService({ vault: v.root, clock: () => at(2026, 10, 28, 11), tutor: () => ({ provider: mock, cfg: { ...NO_TUTOR, provider: 'ollama', model: 'm', monthlyCapUsd: capUsd, usdPerMTokIn: 1, usdPerMTokOut: 1 } }) });
  });
  afterAll(() => svc.close());

  it('grades an explanation only against the pack and writes evidence, not mastery', async () => {
    reply = JSON.stringify({ covered: ['k1', 'k2', 'k3', 'k4', 'k5', 'k99'], missed: [], wrong: [], feedback: 'Clear and complete.', mistakes: [], confidence: 'high' });
    const r = await svc.tutor.explain({ concept: C, text: 'Multiply matching entries and add; the result is a scalar; zero means perpendicular; |u||v|cos; projection.' });
    expect(r).toMatchObject({ pass: true, coverage: 1, provider: 'mock', next: 'quick', confidence: 'high' });
    expect(calls[0].system).toContain('only the key points');
    expect(calls[0].system).toContain('hints only'); // demo-dot-product is in a live graded assignment
    expect(JSON.parse(calls[0].user).keyPoints).toHaveLength(5);
    expect(svc.db.events({ kind: 'explain' })[0].data).toMatchObject({ coverage: 1, pass: true, verdict: r.verdict });
    expect(svc.tutor.status()).toMatchObject({ provider: 'mock', calls: 1 });
  });

  it('falls back to the built-in matcher when the reply is unusable, at low confidence', async () => {
    reply = 'I think this is fine';
    const r = await svc.tutor.explain({ concept: C, text: 'You multiply the entries and add them, it gives a scalar number.' });
    expect(r).toMatchObject({ provider: 'keywords', confidence: 'low', pass: false });
    expect(r.missed.every((m) => m.text === 'one more idea is missing')).toBe(true); // hints only: key points stay hidden
    expect(r.hint).toBe('Line the vectors up entry by entry.');
  });

  it('checks numbers without the model, hides the answer while the assignment is live, and closes a repair', async () => {
    const before = calls.length;
    const right = await svc.tutor.answer({ concept: C, question: 'q1', answer: '11' });
    expect(right).toMatchObject({ correct: true, provider: 'exact' });
    const wrong = await svc.tutor.answer({ concept: C, question: 'q3', answer: '5' });
    expect(wrong).toMatchObject({ correct: false, mistake: { cls: 'calculation' } });
    expect(wrong.feedback).toBe('Not yet. Hint: Line the vectors up entry by entry.');
    expect(calls.length).toBe(before);
    await svc.tutor.answer({ concept: C, question: 'q3', answer: '7' });
    const repair = svc.repairs().find((r) => r.concept === C)!;
    expect(repair).toMatchObject({ cls: 'calculation' });
    expect(svc.next().items[0]).toMatchObject({ kind: 'repair', concept: C });
    await svc.tutor.answer({ concept: C, question: 'q3', answer: '0', repair: repair.key });
    expect(svc.repairs().find((r) => r.concept === C)).toBeUndefined();
  });

  it('asks the model for short answers and refuses questions outside the pack', async () => {
    reply = '{"correct":true,"feedback":"Yes — perpendicular.","confidence":"high"}';
    expect(await svc.tutor.answer({ concept: C, question: 'q4', answer: 'They are at right angles' })).toMatchObject({ correct: true, provider: 'mock' });
    await expect(svc.tutor.answer({ concept: C, question: 'q77', answer: 'x' })).rejects.toThrow(/not in the pack/);
    await expect(svc.tutor.explain({ concept: 'dprob-expectation', text: 'some long enough explanation text' })).rejects.toThrow(/No check pack/);
  });

  it('lists low-confidence verdicts for the nightly audit; Claude’s re-grade corrects mastery', async () => {
    const a = svc.tutor.audit();
    const low = a.verdicts.find((v) => v.provider === 'keywords' && v.kind === 'explain')!;
    expect(low).toMatchObject({ confidence: 'low', answer: expect.stringContaining('multiply'), keyPoints: expect.any(Array) });
    // the strong explanation earlier passed; Claude decides it did not
    const strong = svc.db.events({ kind: 'explain' })[0].data.verdict as string;
    svc.log({ kind: 'segment_done', concept: C, data: { index: 0 } });
    expect(svc.conceptView({ id: C }).state.rung).toBe('understood');
    expect(svc.tutor.regrade({ id: strong, coverage: 0.6, pass: false, note: 'k4 was only named' })).toMatchObject({ changed: true, rung: 'seen' });
    expect(svc.tutor.regrade({ id: low.id, agree: true })).toMatchObject({ changed: false });
    expect(svc.tutor.audit().verdicts.some((v) => v.id === low.id)).toBe(false);
    expect(() => svc.tutor.regrade({ id: strong, pass: true })).toThrow(/coverage/);
  });

  it('stops calling the provider once the monthly cap is reached', async () => {
    capUsd = 0;
    const n = calls.length;
    const r = await svc.tutor.explain({ concept: C, text: 'multiply and add, a scalar, perpendicular when zero' });
    expect(r.provider).toBe('keywords');
    expect(calls.length).toBe(n);
    expect(svc.tutor.status().capReached).toBe(true);
    capUsd = 5;
  });
});

describe.runIf(hasPython)('labs: hidden tests run on this PC', () => {
  const tests = join(FIXTURE, 'claude', 'demo', 'labs', 'demo-dot-lab', 'hidden_test.py');
  it('scores a correct, a wrong and a broken solution', async () => {
    expect(await runHidden('def dot(u, v):\n    return sum(a * b for a, b in zip(u, v))\n', tests, 'dot')).toMatchObject({ ok: true, passed: 3, total: 3 });
    const wrong = await runHidden('def dot(u, v):\n    return sum(u) * sum(v)\n', tests, 'dot');
    expect(wrong).toMatchObject({ ok: false, total: 3 });
    expect(wrong.tests.find((t) => !t.ok)?.error).toMatch(/AssertionError/);
    expect((await runHidden('def dot(u, v)\n  return 1', tests, 'dot')).error).toMatch(/SyntaxError/);
    expect((await runHidden('def other(): pass', tests, 'dot')).error).toMatch(/dot is not defined/);
    expect((await runHidden('def dot(u, v):\n    while True: pass\n', tests, 'dot', 2)).error).toMatch(/Stopped after 2 s/);
  }, 30_000);

  it('records the lab as evidence and keeps your code', async () => {
    const v = vault('eos-study2b-');
    const svc = new StudyService({ vault: v.root });
    const r = await svc.runLab({ concept: 'demo-dot-product', code: 'def dot(u, v):\n    return sum(a * b for a, b in zip(u, v))\n' });
    expect(r).toMatchObject({ ok: true, passed: 3 });
    expect(svc.db.events({ kind: 'lab' })[0].data).toMatchObject({ lab: 'demo-dot-lab', passed: true, passedTests: 3, total: 3 });
    expect(existsSync(join(layout(v.root).subject('demo'), 'labs', 'demo-dot-lab', 'my_solution.py'))).toBe(true);
    expect(svc.conceptView({ id: 'demo-dot-product' }).state.mastery.implementation).toBe(1);
    svc.close();
  }, 30_000);
});

describe.runIf(hasPython)('the 3-day test', () => {
  let svc: StudyService;
  let root: string;
  let now = at(2026, 10, 28, 10);
  const A = 'demo-vectors-and-linear-combinations';
  const B = 'demo-dot-product';
  beforeAll(() => {
    const v = vault('eos-study2c-');
    root = v.root;
    svc = new StudyService({ vault: root, clock: () => now });
    for (const c of [A, B]) {
      svc.log({ kind: 'segment_done', concept: c, data: { index: 0 } });
      svc.log({ kind: 'explain', concept: c, data: { coverage: 0.9, pass: true } });
    }
    svc.log({ kind: 'mistake', concept: B, data: { cls: 'formula_recall', detail: 'dot' } });
  });
  afterAll(() => svc.close());

  it('is due every 3 days from the start and plans the 40/25/20/15 mix per subject', () => {
    expect(svc.exams.buildDue()).toMatchObject({ due: false, id: '2026-10-31' });
    now = at(2026, 10, 31, 5);
    expect(svc.exams.buildDue()).toMatchObject({ due: true, id: '2026-10-31' });
    const plan = svc.exams.plan();
    expect(plan.subjects.map((s) => s.subject)).toEqual(['demo']);
    expect(plan.subjects[0]).toMatchObject({ written: 5, programming: 1, counts: { new: 3, retention: 0, mistake: 1, transfer: 1 } });
    expect(plan.subjects[0].concepts.mistake).toEqual([B]);
    expect(plan.subjects[0].transferPairs).toEqual([[A, B]]);
  });

  it('builds a fallback paper with a written and a programming part, and checks it', async () => {
    const b = svc.exams.build();
    expect(b).toMatchObject({ id: '2026-10-31', file: 'tests/2026-10-31/paper.yaml' });
    const paper = svc.exams.paper('2026-10-31');
    expect(paper.items.some((i) => i.kind === 'programming' && i.tests === 'tests/2026-10-31/hidden/demo-p1_test.py')).toBe(true);
    expect(paper.items.filter((i) => i.kind !== 'programming').every((i) => i.rubric?.length)).toBe(true);
    expect(paper.items.some((i) => i.style === 'iitj')).toBe(true);
    expect(paper.items.some((i) => i.transfer)).toBe(true);
    expect(existsSync(join(root, 'tests', '2026-10-31', 'hidden', 'demo-p1_test.py'))).toBe(true);
    mkdirSync(join(root, 'tests', '2026-10-31', 'solutions'), { recursive: true });
    writeFileSync(join(root, 'tests', '2026-10-31', 'solutions', 'demo-p1.py'), 'import math\ndef cosine(u, v):\n    d = sum(a*b for a, b in zip(u, v))\n    return d / (math.sqrt(sum(a*a for a in u)) * math.sqrt(sum(b*b for b in v)))\n');
    expect(await svc.exams.check({ id: '2026-10-31' })).toMatchObject({ ok: true, problems: [], reference: [{ item: 'demo-p1', passed: 3, total: 3 }] });
    expect(() => svc.exams.build()).toThrow(/already exists/);
  }, 30_000);

  it('shows the test in the queue, and serves it without answers, rubrics or hidden tests', () => {
    expect(svc.next().items.find((i) => i.kind === 'test')).toMatchObject({ testId: '2026-10-31', minutes: 60 });
    now = at(2026, 10, 31, 9);
    const s = svc.exams.start({ id: '2026-10-31' });
    const text = JSON.stringify(s.paper);
    expect(text).not.toContain('rubric');
    expect(text).not.toContain('answer');
    expect(text).not.toContain('hidden');
    expect(s.paper.items.find((i) => i.kind === 'programming')).toMatchObject({ entry: 'cosine', starter: expect.stringContaining('def cosine') });
    expect(svc.liveSession()).toMatchObject({ kind: 'test', test_id: '2026-10-31' });
  });

  it('scores programming at once on submit and waits for Claude on the written part', async () => {
    now = at(2026, 10, 31, 10);
    const paper = svc.exams.paper('2026-10-31');
    const answers: Record<string, { text?: string; code?: string; image?: string }> = {};
    for (const it of paper.items) answers[it.id] = it.kind === 'programming' ? { code: readFileSync(join(root, 'tests', '2026-10-31', 'solutions', 'demo-p1.py'), 'utf8') } : { text: `My answer to ${it.id}` };
    const first = paper.items.find((i) => i.kind !== 'programming')!;
    answers[first.id] = { image: `data:image/png;base64,${readFileSync(join(FIXTURE, 'incoming', 'Demo Probability', 'Week 1', 'whiteboard screenshot.png')).toString('base64')}` };
    const r = await svc.exams.submit({ id: '2026-10-31', answers });
    expect(r).toMatchObject({ complete: true, programming: [{ id: 'demo-p1', passed: 3, total: 3, marks: 5, of: 5 }] });
    expect(readdirSync(join(root, 'tests', '2026-10-31', 'submissions'))).toEqual(expect.arrayContaining([`${first.id}.png`, 'demo-p1.py']));
    expect(svc.liveSession()).toBeNull();
    expect(svc.exams.awaitingGrade()).toEqual(['2026-10-31']);
    expect(svc.next().items.some((i) => i.kind === 'test')).toBe(false);
    expect(() => svc.exams.finalize({ id: '2026-10-31' })).toThrow(/grading.yaml has no marks for/);
  }, 30_000);

  it('finalizes from grading.yaml into evidence, repairs and a report', () => {
    const paper = svc.exams.paper('2026-10-31');
    const written = paper.items.filter((i) => i.kind !== 'programming');
    const grading = { test: '2026-10-31', items: written.map((i, n) => ({ id: i.id, marks: n === 0 ? 0 : i.marks, feedback: n === 0 ? 'Formula missing.' : 'Good.', ...(n === 0 ? { mistakes: [{ concept: B, cls: 'formula_recall', detail: 'dot' }] } : {}) })), reviewNotes: { 'demo-p1': 'Clean.' } };
    writeFileSync(join(root, 'tests', '2026-10-31', 'grading.yaml'), JSON.stringify(grading));
    svc.reindex();
    const rep = svc.exams.finalize({ id: '2026-10-31' });
    const max = paper.items.reduce((a, i) => a + i.marks, 0);
    expect(rep.total.max).toBe(max);
    expect(rep.total.marks).toBe(max - written[0].marks);
    expect(rep.mistakes).toEqual([{ cls: 'formula_recall', count: 1 }]);
    expect(rep.repairsAdded).toEqual(['demo-dot-product|formula_recall|dot']); // the same mistake twice
    expect(svc.db.events({ kind: 'test_item' }).every((e) => e.data.timed === true && e.data.test === '2026-10-31')).toBe(true);
    expect(svc.conceptView({ id: B }).state.mastery.speed).not.toBeNull();
    const md = readFileSync(join(root, 'tests', '2026-10-31', 'report.md'), 'utf8');
    expect(md).toContain('## Per subject');
    expect(md).toContain('hidden tests 3/3 · review: Clean.');
    expect(svc.exams.finalize({ id: '2026-10-31' })).toEqual(rep); // idempotent
    expect(svc.exams.nextDue()).toBe('2026-11-03');
    expect(svc.exams.list()[0]).toMatchObject({ id: '2026-10-31', status: 'graded' });
  });
});

describe('headless jobs', () => {
  let svc: StudyService;
  let root: string;
  let fake: string;
  beforeAll(() => {
    const v = vault('eos-study2d-');
    root = v.root;
    svc = new StudyService({ vault: root });
    fake = join(v.dir, 'fake-claude.mjs');
    writeFileSync(
      fake,
      "import { appendFileSync } from 'node:fs';\nlet input = '';\nprocess.stdin.on('data', (d) => (input += d));\nprocess.stdin.on('end', () => {\n  appendFileSync('fake-claude-ran.txt', `${process.argv.slice(2).join(' ')} :: ${input.split('\\n')[0]}\\n`);\n  console.log('fake claude ok');\n  process.exit(Number(process.env.FAKE_EXIT ?? 0));\n});\n",
    );
  });
  afterAll(() => svc.close());

  it('ships every job as a command file on Sonnet', () => {
    for (const job of Object.values(JOBS)) for (const c of job.chain) expect(readCommand(root, c).model).toBe('sonnet');
    for (const c of ['ingest', 'curate', 'packs', 'labs', 'day-end', 'build-test', 'grade', 'week-end', 'study-now']) expect(existsSync(join(root, '.claude', 'commands', `${c}.md`))).toBe(true);
  });

  it('skips a job when there is no work, and records nothing', async () => {
    const r = await runJob('ingest', { vault: root, client: client(svc), claude: [process.execPath, fake] });
    expect(r).toMatchObject({ ran: false, reason: 'nothing new in inbox/ or assets/' });
    expect((await runJob('grade', { vault: root, client: client(svc), claude: [process.execPath, fake] })).ran).toBe(false);
    expect(svc.jobs()).toEqual([]);
  });

  it('runs the chain with the prompt on stdin, logs it, records it and refreshes STATE.md', async () => {
    writeFileSync(join(root, 'inbox', 'new-notes.txt'), 'something new');
    const r = await runJob('ingest', { vault: root, client: client(svc), claude: [process.execPath, fake] });
    expect(r).toMatchObject({ ran: true, ok: true });
    expect(r.steps.map((s) => s.command)).toEqual(['ingest', 'curate', 'packs', 'labs']);
    const ran = readFileSync(join(root, 'fake-claude-ran.txt'), 'utf8').trim().split('\n');
    expect(ran).toHaveLength(4);
    expect(ran[0]).toMatch(/^-p --model sonnet --permission-mode acceptEdits --output-format text :: You are running the Study OS \*\*ingest\*\* job/);
    expect(readFileSync(r.log!, 'utf8')).toContain('fake claude ok');
    expect(svc.jobs()).toEqual([expect.objectContaining({ job: 'ingest', ok: true })]);
    expect(readFileSync(join(root, 'STATE.md'), 'utf8')).toContain('# STATE — ');
  });

  it('stops the chain on a failure and shows the failed job on the home screen', async () => {
    process.env.FAKE_EXIT = '3';
    try {
      const r = await runJob('day-end', { vault: root, client: client(svc), claude: [process.execPath, fake] });
      expect(r).toMatchObject({ ran: true, ok: false, steps: [{ command: 'day-end', ok: false, code: 3 }] });
    } finally {
      delete process.env.FAKE_EXIT;
    }
    expect(svc.overview().jobs.find((j) => j.job === 'day-end')).toMatchObject({ ok: false });
    expect(svc.summary()?.lastJobFailed).toBe('day-end');
  });

  it('prints the Task Scheduler commands without registering anything (dry run)', async () => {
    const mod = (await import(pathToFileURL(join(process.cwd(), 'scripts', 'study-schedule.mjs')).href)) as { taskCommands: (v: string) => { name: string; args: string[] }[] };
    const t = mod.taskCommands('C:\\StudyOS');
    expect(t.map((x) => x.name)).toEqual(['Ingest', 'Day-end', 'Build-test', 'Grade', 'Week-end']);
    expect(t[0].args).toEqual(['/Create', '/F', '/TN', 'StudyOS\\Ingest', '/TR', 'C:\\StudyOS\\study.cmd run-job ingest', '/SC', 'HOURLY', '/MO', '2', '/ST', '00:30', '/RL', 'LIMITED']);
    expect(t[2].args).toEqual(expect.arrayContaining(['/SC', 'DAILY', '/MO', '3', '/ST', '05:00']));
    writeFileSync(join(root, 'study.cmd'), '@echo off\r\n');
    const r = spawnSync(process.execPath, [join('scripts', 'study-schedule.mjs'), '--dry-run', '--vault', root], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Dry run: nothing was registered.');
    expect(r.stdout).toContain('run-job build-test');
  });
});

void DAY_MS;
