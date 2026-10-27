import { describe, expect, it } from 'vitest';
import { intervalDays, newCard, recallNow, retrievability, review } from '../src/core/study/fsrs';
import { DAY_MS, parseTime, slug } from '../src/core/study/ids';
import { conceptState, openRepairs, repairKey } from '../src/core/study/ladder';
import { progress } from '../src/core/study/progress';
import { buildQueue } from '../src/core/study/queue';
import { classifyAsset, detectSubject, parseSyllabus } from '../src/core/study/syllabus';
import type { Assessment, Concept, ResourcePath, StudyEvent } from '../src/core/study/types';
import { at } from './study-helpers';

let seq = 0;
const ev = (kind: StudyEvent['kind'], t: number, data: Record<string, unknown> = {}, concept = 'c1'): StudyEvent => ({ seq: ++seq, at: t, kind, concept, source: 'app', data });
const T0 = at(2026, 10, 28, 10);
const H = 3_600_000;

const concept = (id: string, subject: string, order: number, extra: Partial<Concept> = {}): Concept => ({ id, subject, title: id, order, status: 'ready', released: true, examWeight: 1, minutes: 30, prereqs: [], confusedWith: [], testedBy: [], formulas: [], sources: [], notation: [], file: `${id}.md`, ...extra });
const path = (c: string): ResourcePath => ({ concept: c, segments: [{ kind: 'intuition', url: `https://example.org/${c}`, source: 'Demo', why: 'x', start: 0, end: 600 }], alternates: [{ kind: 'example', url: `https://example.org/${c}/alt`, source: 'Alt', why: 'y' }], file: `${c}.yaml` });

describe('helpers', () => {
  it('makes ids and reads timestamps', () => {
    expect(slug('Eigenvalues & Eigenvectors (Part 2)')).toBe('eigenvalues-and-eigenvectors-part-2');
    expect(parseTime('1:02:03')).toBe(3723);
    expect(parseTime('4:30')).toBe(270);
    expect(parseTime(90)).toBe(90);
    expect(parseTime('soon')).toBeUndefined();
  });
});

describe('syllabus skeleton', () => {
  it('turns every leaf bullet into a topic with week, order, fixed ids and weights', () => {
    const t = parseSyllabus(
      `# X\n<!-- - not a topic -->\n## Week 1: Vectors\n- Vectors and combinations\n- Dot product {#x-dot}\n## Week 2\n1. Matrix multiplication (weight 2)\n- Random variables\n  - Discrete random variables\n  - Expectation\n- Dot product\n- Dot product`,
      'x',
    );
    expect(t.map((x) => x.id)).toEqual(['x-vectors-and-combinations', 'x-dot', 'x-matrix-multiplication', 'x-discrete-random-variables', 'x-expectation', 'x-dot-product', 'x-dot-product-2']);
    expect(t[2]).toMatchObject({ week: 2, examWeight: 2, order: 3 });
    expect(t[3].group).toBe('Random variables');
    expect(t[0].week).toBe(1);
  });

  it('classifies assets from their path and finds the subject', () => {
    expect(classifyAsset('Week 3/Lecture 12 slides.pdf')).toEqual({ type: 'slides', week: 3, lecture: 12 });
    expect(classifyAsset('lana_w2_assignment1.pdf').type).toBe('assignment');
    expect(classifyAsset('captions/lec4.vtt')).toMatchObject({ type: 'transcript', lecture: 4 });
    expect(classifyAsset('EndSem 2024 paper.pdf').type).toBe('pyq');
    expect(classifyAsset('IMG_2041.heic').type).toBe('screenshot');
    expect(classifyAsset('random.bin').type).toBe('other');
    const subjects = [
      { id: 'lana', title: 'Linear Algebra and Numerical Analysis', examWeight: 1 },
      { id: 'fsp', title: 'Foundations of Statistics and Probability', examWeight: 1 },
    ];
    expect(detectSubject('Linear Algebra/Week 1/slides.pdf', subjects)).toBe('lana');
    expect(detectSubject('downloads/fsp/quiz.pdf', subjects)).toBe('fsp');
    expect(detectSubject('misc/notes.txt', subjects)).toBeUndefined();
  });
});

describe('FSRS', () => {
  it('schedules the first recall after about 3–4 days and grows the interval on success', () => {
    const c = newCard(T0);
    expect(intervalDays(c.stability)).toBeGreaterThanOrEqual(3);
    expect(intervalDays(c.stability)).toBeLessThanOrEqual(5);
    expect(retrievability(0, c.stability)).toBe(1);
    expect(recallNow(c, c.due)).toBeCloseTo(0.9, 1);
    const good = review(c, c.due, 3);
    expect(good.stability).toBeGreaterThan(c.stability * 2);
    const again = review(c, c.due, 1);
    expect(again.stability).toBeLessThan(c.stability);
    expect(again.lapses).toBe(1);
  });
});

describe('status ladder', () => {
  const base = { concept: 'c1', packQuestions: 3, hasLab: false, pathLength: 1, now: T0 + 10 * DAY_MS };

  it('moves only with evidence, one step at a time', () => {
    const e: StudyEvent[] = [];
    const st = () => conceptState({ ...base, events: e });
    expect(st()).toMatchObject({ rung: 'none', nextStep: 'watch' });
    e.push(ev('segment_done', T0, { index: 0 }));
    expect(st()).toMatchObject({ rung: 'seen', nextStep: 'explain' });
    e.push(ev('explain', T0 + H, { coverage: 0.6, pass: false }));
    expect(st()).toMatchObject({ rung: 'seen', nextStep: 'watch', missedChecks: 1 }); // a miss → alternate segment
    e.push(ev('segment_done', T0 + 2 * H, { index: 0, alternate: true }));
    expect(st().nextStep).toBe('explain');
    e.push(ev('explain', T0 + 3 * H, { coverage: 0.85, pass: true }));
    expect(st()).toMatchObject({ rung: 'understood', nextStep: 'quick', missedChecks: 0 });
    for (const q of ['q1', 'q2', 'q3']) e.push(ev('quick', T0 + 4 * H, { question: q, correct: true }));
    const applied = st();
    expect(applied.rung).toBe('applied');
    expect(applied.card).not.toBeNull();
    expect(applied.mastery.recall).toBe(1);
    // recall the next day does not count as retained; three days later it does
    e.push(ev('review', T0 + DAY_MS, { grade: 3 }));
    expect(st().rung).toBe('applied');
    e.push(ev('review', T0 + 4 * DAY_MS, { grade: 3 }));
    expect(st().rung).toBe('retained');
    e.push(ev('test_item', T0 + 5 * DAY_MS, { correct: true, timed: true, transfer: false }));
    expect(st().rung).toBe('retained');
    e.push(ev('test_item', T0 + 5 * DAY_MS, { correct: true, timed: true, transfer: true }));
    expect(st()).toMatchObject({ rung: 'exam_ready', nextStep: 'done' });
    expect(st().mastery.transfer).toBe(1);
  });

  it('needs the lab when the concept has one, and 80 % of the quick questions', () => {
    const e = [ev('segment_done', T0), ev('explain', T0, { coverage: 1, pass: true }), ...['q1', 'q2', 'q3', 'q4', 'q5'].map((q, i) => ev('quick', T0 + i, { question: q, correct: i !== 0 }))];
    expect(conceptState({ ...base, packQuestions: 5, hasLab: true, events: e })).toMatchObject({ rung: 'understood', nextStep: 'lab' });
    e.push(ev('lab', T0 + 10, { passed: true, passedTests: 3, total: 3 }));
    expect(conceptState({ ...base, packQuestions: 5, hasLab: true, events: e }).rung).toBe('applied');
    const worse = [ev('segment_done', T0), ev('explain', T0, { coverage: 1, pass: true }), ...['q1', 'q2', 'q3', 'q4', 'q5'].map((q, i) => ev('quick', T0 + i, { question: q, correct: i > 1 }))];
    expect(conceptState({ ...base, packQuestions: 5, events: worse }).rung).toBe('understood');
  });
});

describe('repair rule', () => {
  it('opens a repair after the same mistake twice and closes it after the retest', () => {
    const e = [ev('mistake', T0, { cls: 'formula_recall', detail: 'Dot' }), ev('mistake', T0 + 1, { cls: 'calculation' })];
    expect(openRepairs(e)).toEqual([]);
    e.push(ev('mistake', T0 + 2, { cls: 'formula_recall', detail: 'dot ' }));
    const r = openRepairs(e);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ concept: 'c1', cls: 'formula_recall', count: 2, key: repairKey('c1', 'formula_recall', 'dot') });
    e.push(ev('repair_done', T0 + 3, { key: r[0].key }));
    expect(openRepairs(e)).toEqual([]);
  });
});

describe('queue and progress', () => {
  const assessment: Assessment = { semester: 's1', studyStart: '2026-10-28', examStart: '2026-11-30', testEveryDays: 3, testMinutes: 60, subjects: [{ id: 'a', title: 'A', examWeight: 2 }, { id: 'b', title: 'B', examWeight: 1 }], components: [], deadlines: [] };
  const cs = [concept('a1', 'a', 1, { week: 1 }), concept('a2', 'a', 2, { week: 1, prereqs: ['a1'] }), concept('b1', 'b', 1, { week: 1, examWeight: 3 }), concept('b2', 'b', 2, { week: 2 })];
  const states = (events: StudyEvent[], now: number) => new Map(cs.map((c) => [c.id, conceptState({ concept: c.id, events: events.filter((e) => e.concept === c.id), packQuestions: 1, hasLab: false, pathLength: 1, now })]));
  const appliedEvents = (id: string, t: number) => [ev('segment_done', t, {}, id), ev('explain', t, { coverage: 1, pass: true }, id), ev('quick', t, { question: 'q1', correct: true }, id)];

  it('puts repairs first, then due reviews, then started concepts, then the syllabus', () => {
    const now = T0 + 5 * DAY_MS;
    const events = [...appliedEvents('a1', T0), ev('segment_done', now - H, {}, 'b2'), ev('mistake', now - 2, { cls: 'concept_gap' }, 'b1'), ev('mistake', now - 1, { cls: 'concept_gap' }, 'b1')];
    const st = states(events, now);
    const p = progress({ today: '2026-11-02', now, assessment, concepts: cs, states: st, released: () => true, iitj: { lectures: 0, lecturesWatched: 0, assignments: 0, assignmentsSubmitted: 0 }, studyMinutesToday: 0, studyMinutesTotal: 0 });
    const q = buildQueue({ now, concepts: cs, states: st, repairs: openRepairs(events), paths: new Map(cs.map((c) => [c.id, path(c.id)])), subjects: assessment.subjects, progress: p.subjects, byWeight: false });
    expect(q.map((i) => `${i.kind}:${'concept' in i ? i.concept : ''}`)).toEqual(['repair:b1', 'review:a1', 'learn:b2', 'learn:b1', 'learn:a2']);
    const learn = q.find((i) => i.kind === 'learn' && i.concept === 'b2');
    expect(learn).toMatchObject({ step: 'explain' });
  });

  it('orders by exam weight × weakness when the ready date slips', () => {
    const now = T0 + DAY_MS;
    const st = states([], now);
    const p = progress({ today: '2026-10-29', now, assessment, concepts: cs, states: st, released: () => true, iitj: { lectures: 0, lecturesWatched: 0, assignments: 0, assignmentsSubmitted: 0 }, studyMinutesToday: 0, studyMinutesTotal: 0 });
    expect(p.reorderedByWeight).toBe(true);
    const q = buildQueue({ now, concepts: cs, states: st, repairs: [], paths: new Map(cs.map((c) => [c.id, path(c.id)])), subjects: assessment.subjects, progress: p.subjects, byWeight: true });
    expect(q[0]).toMatchObject({ kind: 'learn', concept: 'b1' }); // weight 3 × subject 1 beats 1 × 2
  });

  it('measures coverage, pace from day 1 and a projected ready date', () => {
    const now = at(2026, 10, 30, 20);
    const events = [...appliedEvents('a1', at(2026, 10, 29, 10)), ...appliedEvents('b1', at(2026, 10, 30, 10))];
    const p = progress({ today: '2026-10-30', now, assessment, concepts: cs, states: states(events, now), released: (c) => c.week === 1, iitj: { lectures: 4, lecturesWatched: 1, assignments: 2, assignmentsSubmitted: 1 }, studyMinutesToday: 50, studyMinutesTotal: 200 });
    expect(p.readyBy).toBe('2026-11-15');
    expect(p.daysToExam).toBe(31);
    expect(p.coverage).toBe(0.5);
    expect(p.releasedCoverage).toBeCloseTo(2 / 3);
    expect(p.pace.averagePerDay).toBeCloseTo(2 / 3);
    expect(p.pace.neededPerDay).toBeCloseTo(2 / 17);
    expect(p.pace.status).toBe('ahead');
    expect(p.projectedReady).toBe('2026-11-02');
    expect(p.iitjTrack).toBeCloseTo(2 / 6);
    expect(p.subjects.find((s) => s.subject === 'a')).toMatchObject({ concepts: 2, applied: 1, coverage: 0.5 });
  });
});
