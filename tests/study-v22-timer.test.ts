import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { GRACE_MS } from '../server/study/exam';
import { findPython } from '../server/study/labs';
import { StudyService } from '../server/study/service';
import { at, claudeWrites, sampleVault } from './study-helpers';

// v2.2 phase 5: the 3-day test's timer is enforced — by the app (warning, auto-submit at zero) and by
// the hub (deadline, autosave, submits the last saved answers when the app never does).
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe.runIf(!!findPython())('enforced test timer', () => {
  let svc: StudyService;
  let root: string;
  let now = at(2026, 10, 28, 10);
  beforeAll(() => {
    const v = sampleVault('eos-v22e-');
    dirs.push(v.dir);
    root = v.root;
    claudeWrites(root);
    svc = new StudyService({ vault: root, clock: () => now });
    for (const c of ['demo-vectors-and-linear-combinations', 'demo-dot-product']) {
      svc.log({ kind: 'segment_done', concept: c, data: { index: 0 } });
      svc.log({ kind: 'explain', concept: c, data: { coverage: 0.9, pass: true } });
    }
    now = at(2026, 10, 31, 9);
    svc.exams.build();
  });
  afterAll(() => svc.close());

  it('sets one deadline at the first start that a reopen cannot reset', () => {
    const a = svc.exams.start({ id: '2026-10-31' });
    expect(a.deadline).toBe(now + a.paper.durationMin * 60_000);
    now += 10 * 60_000;
    const b = svc.exams.start({ id: '2026-10-31' });
    expect(b.deadline).toBe(a.deadline);
    expect(b.now).toBe(now);
  });

  it('autosaves answers and gives them back on reopen', () => {
    const paper = svc.exams.paper('2026-10-31');
    const prog = paper.items.find((i) => i.kind === 'programming')!;
    const written = paper.items.find((i) => i.kind !== 'programming')!;
    const sol = 'import math\ndef cosine(u, v):\n    d = sum(a*b for a, b in zip(u, v))\n    return d / (math.sqrt(sum(a*a for a in u)) * math.sqrt(sum(b*b for b in v)))\n';
    expect(svc.exams.saveDraft({ id: '2026-10-31', answers: { [prog.id]: { code: sol }, [written.id]: { text: 'draft answer' } } })).toMatchObject({ ok: true });
    expect(svc.exams.start({ id: '2026-10-31' }).draft).toMatchObject({ [written.id]: { text: 'draft answer' } });
  });

  it('submits the last saved answers when the time plus grace is over, and refuses late work', async () => {
    const { deadline } = svc.exams.start({ id: '2026-10-31' });
    now = deadline + 60_000; // inside the grace: the app may still send
    expect(await svc.exams.autoSubmitDue()).toEqual([]);
    now = deadline + GRACE_MS + 1000;
    expect(() => svc.exams.saveDraft({ id: '2026-10-31', answers: {} })).toThrow(/time is up/);
    await expect(svc.exams.submit({ id: '2026-10-31', answers: {} })).rejects.toThrow(/time is up/);
    expect(await svc.exams.autoSubmitDue()).toEqual(['2026-10-31:all']);
    expect(svc.exams.awaitingGrade()).toEqual(['2026-10-31']);
    const written = svc.exams.paper('2026-10-31').items.find((i) => i.kind !== 'programming')!;
    expect(readFileSync(join(root, 'tests', '2026-10-31', 'submissions', `${written.id}.md`), 'utf8')).toBe('draft answer');
    expect(svc.liveSession()).toBeNull(); // the timed focus session ended with it
    expect(await svc.exams.autoSubmitDue()).toEqual([]);
    expect(() => svc.exams.start({ id: '2026-10-31' })).toThrow(/already submitted/);
  }, 60_000);
});
