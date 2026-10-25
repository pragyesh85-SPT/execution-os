import { describe, expect, it } from 'vitest';
import { emptyDoc } from '../src/core/defaults';
import { checkinGoal, expectedShare, goalActual, goalProgress, paceOf, periodOf, periodRange, setGoalStatus, suggestBreakdown, upsertGoal, weekPace } from '../src/core/goals';
import * as ops from '../src/core/ops';
import { planSync, type Conflict } from '../src/core/sync';
import type { Doc } from '../src/core/types';

const at = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const run = <R>(d: Doc, op: (d: Doc, now: number) => R, now = at(2026, 10, 7)) => op(d, now);
const doc = () => {
  const d = emptyDoc();
  d.settings.onboarded = true;
  return d;
};

describe('periods', () => {
  it('handles week keys across month and year boundaries', () => {
    expect(periodOf('week', '2026-11-01')).toBe('2026-10-26'); // a Sunday belongs to the week that started on Monday
    expect(periodRange('week', '2026-12-30')).toEqual(['2026-12-28', '2027-01-03']);
    expect(periodRange('month', '2026-02')).toEqual(['2026-02-01', '2026-02-28']);
    expect(periodRange('month', '2028-02')).toEqual(['2028-02-01', '2028-02-29']);
    expect(periodOf('year', '2027-01-01')).toBe('2027');
  });
});

describe('expected progress and pace', () => {
  it('is 0 at the start, about half in the middle, 1 at the end of the period', () => {
    const d = doc();
    const g = { level: 'week' as const, period: '2026-10-05' };
    expect(expectedShare(d, g, at(2026, 10, 5, 4))).toBeCloseTo(0, 5);
    expect(expectedShare(d, g, at(2026, 10, 8, 16))).toBeCloseTo(0.5, 2);
    expect(expectedShare(d, g, at(2026, 10, 12, 5))).toBe(1);
    expect(expectedShare(d, { ...g, curve: 'workdays' }, at(2026, 10, 11, 23))).toBe(1); // Sunday does not count
  });

  it('classifies pace by the thresholds in the guide', () => {
    expect(paceOf(1, 0.5)).toBe('done');
    expect(paceOf(0.65, 0.5)).toBe('ahead');
    expect(paceOf(0.46, 0.5)).toBe('on_track');
    expect(paceOf(0.35, 0.5)).toBe('behind');
    expect(paceOf(0.2, 0.5)).toBe('at_risk');
  });
});

describe('actuals', () => {
  it('hours come from linked missions, otherwise from the categories', () => {
    const d = doc();
    const linked = run(d, upsertGoal({ level: 'week', period: '2026-10-05', title: 'Study 10h', area: 'iit', metric: { kind: 'hours', categories: ['iit'] }, target: 10 }));
    const byCat = run(d, upsertGoal({ level: 'week', period: '2026-10-05', title: 'Founder 20h', area: 'founder', metric: { kind: 'hours', categories: ['founder'] }, target: 20 }));
    run(d, ops.setMission('2026-10-06', 'b-iit', { title: 'Lecture 4', steps: [], goalId: linked }));
    d.sessions.s1 = { id: 's1', u: 1, date: '2026-10-06', blockId: 'b-iit', category: 'iit', start: at(2026, 10, 6, 10), end: at(2026, 10, 6, 11) };
    d.sessions.s2 = { id: 's2', u: 1, date: '2026-10-06', blockId: 'b-founder', category: 'founder', start: at(2026, 10, 6, 12), end: at(2026, 10, 6, 14) };
    expect(goalActual(d, d.goals[linked], at(2026, 10, 7)).actual).toBeCloseTo(1, 5); // only the linked IIT block
    expect(goalActual(d, d.goals[byCat], at(2026, 10, 7)).actual).toBeCloseTo(2, 5); // category fallback
  });

  it('count sums done proofs (countDelta) plus check-ins; in-app proofs inherit the mission target', () => {
    const d = doc();
    const g = run(d, upsertGoal({ level: 'month', period: '2026-10', title: 'Finish 4 modules', area: 'iit', metric: { kind: 'count', unit: 'modules' }, target: 4 }));
    run(d, ops.setMission('2026-10-06', 'b-iit', { title: 'Module 2', steps: [], goalId: g }));
    run(d, ops.saveProof('2026-10-06', { id: 'b-iit', category: 'iit' }, 'done', '', [], []));
    expect(d.proofs['2026-10-06:b-iit'].goalId).toBe(g);
    run(d, ops.logSession({ date: '2026-10-06', blockId: 'b-founder', status: 'done', note: '', links: [], via: 'app', goalId: g, countDelta: 2 }));
    run(d, checkinGoal(g, 1, 'one more on the weekend'));
    expect(goalActual(d, d.goals[g], at(2026, 10, 7)).actual).toBe(4);
    expect(goalProgress(d, d.goals[g], at(2026, 10, 7)).pace).toBe('done');
  });
});

describe('roll-up', () => {
  it('a parent without data of its own averages its children (target-weighted; equal weights for mixed units)', () => {
    const d = doc();
    const year = run(d, upsertGoal({ level: 'year', period: '2026', title: 'Graduate', area: 'iit', metric: { kind: 'binary' } }));
    const a = run(d, upsertGoal({ level: 'month', period: '2026-10', parentId: year, title: 'Modules', area: 'iit', metric: { kind: 'count', unit: 'modules' }, target: 4 }));
    const b = run(d, upsertGoal({ level: 'month', period: '2026-10', parentId: year, title: 'Study', area: 'iit', metric: { kind: 'hours' }, target: 40 }));
    run(d, checkinGoal(a, 2)); // 50%
    run(d, checkinGoal(b, 10)); // 25%
    const p = goalProgress(d, d.goals[year], at(2026, 10, 7));
    expect(p.children).toHaveLength(2);
    expect(p.pct).toBeCloseTo((0.5 + 0.25) / 2, 5);
    const m2 = run(d, upsertGoal({ level: 'month', period: '2026-10', title: 'Hours parent', area: 'iit', metric: { kind: 'hours' }, target: 30 }));
    const c1 = run(d, upsertGoal({ level: 'week', period: '2026-10-05', parentId: m2, title: 'W1', area: 'iit', metric: { kind: 'hours' }, target: 10 }));
    run(d, upsertGoal({ level: 'week', period: '2026-10-12', parentId: m2, title: 'W2', area: 'iit', metric: { kind: 'hours' }, target: 30 }));
    run(d, checkinGoal(c1, 10));
    expect(goalProgress(d, d.goals[m2], at(2026, 10, 7)).pct).toBeCloseTo(10 / 40, 5);
    run(d, setGoalStatus(b, 'dropped')); // dropping a child removes it from the parent
    expect(goalProgress(d, d.goals[year], at(2026, 10, 7)).pct).toBeCloseTo(0.5, 5);
  });

  it('suggests an even breakdown over the remaining weeks', () => {
    const d = doc();
    const m = run(d, upsertGoal({ level: 'month', period: '2026-10', title: 'Study 40h', area: 'iit', metric: { kind: 'hours' }, target: 40 }));
    const drafts = suggestBreakdown(d, d.goals[m], at(2026, 10, 7));
    expect(drafts.map((x) => x.period)).toEqual(['2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26']);
    expect(drafts.every((x) => x.target === 10 && x.level === 'week' && x.parentId === m)).toBe(true);
  });

  it('weekPace summarises this week for the line on Now', () => {
    const d = doc();
    const g = run(d, upsertGoal({ level: 'week', period: '2026-10-05', title: 'Ship', area: 'founder', metric: { kind: 'binary' } }));
    expect(weekPace(d, '2026-10-07', at(2026, 10, 7))?.count).toBe(1);
    run(d, setGoalStatus(g, 'done'));
    expect(weekPace(d, '2026-10-07', at(2026, 10, 7))?.pct).toBe(1);
  });
});

describe('validation and sync', () => {
  it('refuses a period that does not match its level, normalises weeks, and never deletes', () => {
    const d = doc();
    expect(() => run(d, upsertGoal({ level: 'month', period: '2026', title: 'x', metric: { kind: 'binary' } }))).toThrow(/Period/);
    const id = run(d, upsertGoal({ level: 'week', period: '2026-10-07', title: 'Normalised', metric: { kind: 'binary' } }));
    expect(d.goals[id].period).toBe('2026-10-05');
    run(d, upsertGoal({ id, status: 'dropped' }));
    expect(d.goals[id].status).toBe('dropped');
    expect(d.goals[id].del).toBeUndefined();
  });

  it('round-trips the goals collection between devices', () => {
    const none = new Map<string, Conflict>();
    const phone = doc();
    run(phone, upsertGoal({ level: 'week', period: '2026-10-05', title: 'From phone', metric: { kind: 'binary' } }));
    const up = planSync(emptyDoc(), phone, emptyDoc(), none, 0);
    expect(up.push.map((c) => c.col)).toContain('goals');
    const hub = emptyDoc();
    for (const c of up.push) if (c.col === 'goals') hub.goals[c.id] = { ...(c.record as Doc['goals'][string]), r: 1 };
    const pc = planSync(emptyDoc(), emptyDoc(), hub, none, 0).local;
    expect(Object.values(pc.goals).map((g) => g.title)).toEqual(['From phone']);
  });
});
