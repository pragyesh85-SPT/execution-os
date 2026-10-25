import { describe, expect, it } from 'vitest';
import { analytics, rolling } from '../src/core/analytics';
import { coachVerdict, components, gradeOf, postCoachingNote, profileOf, scoreOf } from '../src/core/coach';
import { emptyDoc } from '../src/core/defaults';
import * as ops from '../src/core/ops';
import type { Doc } from '../src/core/types';
import { addDays } from '../src/core/time';

const WEEK = '2026-10-05'; // Monday
const END = '2026-10-11';
const NOW = new Date(2026, 9, 12, 8).getTime(); // the week is over
const at = (date: string, h: number, m = 0) => {
  const [y, mo, d] = date.split('-').map(Number);
  return new Date(y, mo - 1, d, h, m).getTime();
};

/** Mon–Fri: IIT on time and done, Founder logged partial (50%), admin never logged; weekend empty; 60 min distraction. */
function week(): Doc {
  const d = emptyDoc();
  d.settings.onboarded = true;
  d.settings.startedOn = WEEK;
  for (let i = 0; i < 5; i++) {
    const date = addDays(WEEK, i);
    d.sessions[`s${i}`] = { id: `s${i}`, u: 1, date, blockId: 'b-iit', category: 'iit', start: at(date, 10), end: at(date, 12) };
    ops.saveProof(date, { id: 'b-iit', category: 'iit' }, 'done', '', [], [])(d, at(date, 12));
    ops.logSession({ date, blockId: 'b-founder', status: 'partial', percent: 50, note: '', links: [], via: 'app' })(d, at(date, 17));
  }
  d.distractions.x = { id: 'x', u: 1, date: '2026-10-07', at: at('2026-10-07', 15), minutes: 60, source: 'YouTube', kind: 'unplanned' };
  return d;
}

describe('analytics', () => {
  it('counts finished focus blocks, on-time starts, completion, drift and anchors', () => {
    const a = analytics(week(), WEEK, END, NOW);
    expect(a.finishedFocus).toBe(21); // 3 focus blocks × 7 days
    expect(a.onTime).toEqual({ count: 5, rate: 5 / 21 });
    expect(a.completion).toMatchObject({ done: 5, partial: 5, none: 0, unlogged: 11 });
    expect(a.completion.rate).toBeCloseTo(7.5 / 21, 6);
    expect(a.deepWorkHours).toBeCloseTo(5 * 2 + 5 * 2.5, 6); // 2 h tracked IIT + half of the 5 h founder block
    expect(a.drift.distractionMinutes).toBe(60);
    expect(a.drift.heat.flat().reduce((x, y) => x + y, 0)).toBe(a.drift.total);
    expect(a.anchors.studyMet).toBeCloseTo(5 / 7, 6);
    expect(a.anchors.devotionMet).toBe(0);
    expect(a.anchors.wakeOnTime).toBe(0);
    expect(a.plannedFocusMinutes).toBe(21 * 160);
    expect(a.daily).toHaveLength(7);
  });

  it('rolling lines average the last 7 days and skip empty days', () => {
    expect(rolling([1, null, 0, 1], 2)).toEqual([1, 1, 0, 0.5]);
  });
});

describe('the grade', () => {
  it('follows score = 100 × (0.30 S + 0.35 C + 0.20 A + 0.15 D)', () => {
    const v = coachVerdict(week(), WEEK, END, NOW);
    const S = 5 / 21;
    const C = 7.5 / 21;
    const A = (0 + 0 + 5 / 7) / 3;
    const D = 1 - Math.min(1, 60 / (0.25 * 21 * 160));
    expect(v.components.S).toBeCloseTo(S, 6);
    expect(v.components.C).toBeCloseTo(C, 6);
    expect(v.components.A).toBeCloseTo(A, 6);
    expect(v.components.D).toBeCloseTo(D, 6);
    expect(v.score).toBe(Math.round(100 * (0.3 * S + 0.35 * C + 0.2 * A + 0.15 * D)));
    expect(v.grade).toBe('F');
    expect(v.evidence).toHaveLength(3);
    for (const e of v.evidence) expect(e).toMatch(/\d/);
    expect(v.profile).toMatch(/^Inconsistent \(on time 24%, completion 36%\)$/);
  });

  it('uses the grade boundaries and refuses to grade fewer than 5 finished focus blocks', () => {
    expect(gradeOf(85, 10)).toBe('A');
    expect(gradeOf(84, 10)).toBe('B');
    expect(gradeOf(72, 10)).toBe('B');
    expect(gradeOf(60, 10)).toBe('C');
    expect(gradeOf(45, 10)).toBe('D');
    expect(gradeOf(44, 10)).toBe('F');
    expect(gradeOf(99, 4)).toBe('Not enough data');
    const d = emptyDoc();
    d.settings.startedOn = '2026-10-11';
    expect(coachVerdict(d, WEEK, END, NOW).grade).toBe('Not enough data');
  });

  it('picks the first matching profile, with the numbers that triggered it', () => {
    const a = analytics(week(), WEEK, END, NOW);
    const c = (S: number, C: number, D = 1) => ({ S, C, A: 1, D });
    expect(profileOf(a, c(0.9, 0.85), 90, null)).toMatch(/^Consistent executor/);
    expect(profileOf(a, c(0.5, 0.5), 60, 45)).toMatch(/^Recovering \(score 60, up from 45\)/);
    expect(profileOf({ ...a, rescues: { ...a.rescues, count: 4 } }, c(0.5, 0.5), 50, null)).toMatch(/^Firefighter \(4 rescues\)/);
    expect(profileOf(a, c(0.75, 0.4), 50, null)).toMatch(/^Strong starter, weak finisher/);
    expect(profileOf(a, c(0.3, 0.8), 50, null)).toMatch(/^Late starter, real finisher/);
    expect(profileOf({ ...a, missionsPlannedRate: 0.9 }, c(0.5, 0.3), 50, null)).toMatch(/^Planner, not yet executor/);
    expect(profileOf(a, c(0.5, 0.5, 0.4), 50, null)).toMatch(/^Drifting/);
    expect(scoreOf({ S: 1, C: 1, A: 1, D: 1 })).toBe(100);
    expect(components(a).D).toBeLessThanOrEqual(1);
  });
});

describe('coaching notes', () => {
  it('grade, score, profile and evidence are identical whether the note comes from the engine or from Claude', () => {
    const d = week();
    const id1 = postCoachingNote(WEEK, {}, 'engine')(d, NOW);
    const id2 = postCoachingNote(WEEK, { wentWell: 'Studied every weekday', leak: 'Founder afternoons', text: 'Honest summary.', change: { cue: 'IF X THEN Y' } }, 'mcp', 'claude')(d, NOW);
    const a = d.coaching[id1];
    const b = d.coaching[id2];
    for (const k of ['grade', 'score', 'profile', 'evidence'] as const) expect(b[k]).toEqual(a[k]);
    expect(b).toMatchObject({ source: 'mcp', client: 'claude', wentWell: 'Studied every weekday', leak: 'Founder afternoons' });
    expect(id2).toBe(`${WEEK}:2`);
    expect(() => postCoachingNote(WEEK, { text: 'word '.repeat(121) }, 'mcp')(d, NOW)).toThrow(/120 words/);
  });

  it('the suggested change is a working IF → THEN rule', () => {
    const d = week();
    const id = postCoachingNote(WEEK, {}, 'engine')(d, NOW);
    const change = d.coaching[id].change;
    expect(change.trigger).toEqual({ type: 'block_start', category: 'founder' }); // founder blocks were never started on time
    expect(change.action).toEqual({ type: 'focus' });
    ops.saveRule({ id: 'r-coach', enabled: true, trigger: change.trigger!, action: change.action!, cue: change.cue })(d, NOW);
    expect(d.rules['r-coach']).toMatchObject({ enabled: true, cue: change.cue });
  });
});
