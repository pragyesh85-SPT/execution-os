import { describe, expect, it } from 'vitest';
import { emptyDoc } from '../src/core/defaults';
import { blockAt, dayScore, dayStatus, focusState, planFor, wakeDue } from '../src/core/engine';
import { mergeDocs } from '../src/core/merge';
import { parsePlannerReply, smartFill } from '../src/core/planner';
import { buildRescue } from '../src/core/rescue';
import { weekStats } from '../src/core/stats';
import { clockOf, dayStartMs, fmtClock, logicalDate, offsetOf } from '../src/core/time';
import type { Doc } from '../src/core/types';

const DATE = '2026-10-07';
const at = (h: number, m = 0) => new Date(2026, 9, 7, h, m).getTime();

function doc(): Doc {
  const d = emptyDoc();
  d.settings.onboarded = true;
  return d;
}

describe('time', () => {
  it('treats 2 AM as the previous logical day', () => {
    expect(logicalDate(new Date(2026, 9, 8, 2, 0).getTime(), 240)).toBe(DATE);
    expect(logicalDate(at(4, 0), 240)).toBe(DATE);
  });
  it('maps offsets to clock time', () => {
    expect(fmtClock(clockOf(0, 240))).toBe('4:00 AM');
    expect(fmtClock(clockOf(1020, 240))).toBe('9:00 PM');
  });
});

describe('template', () => {
  it('covers exactly 24 hours with no overlap', () => {
    const plan = planFor(doc(), DATE);
    let cursor = 0;
    for (const b of plan.blocks) {
      expect(b.s).toBe(cursor);
      cursor = b.e;
    }
    expect(cursor).toBe(1440);
  });
  it('finds the IIT block at 10:30', () => {
    const d = doc();
    const b = blockAt(planFor(d, DATE), offsetOf(at(10, 30), DATE, 240));
    expect(b?.category).toBe('iit');
  });
});

describe('status', () => {
  it('is drifting 15 minutes into an unstarted IIT block', () => {
    const d = doc();
    d.wake[DATE] = { id: DATE, u: 1, verifiedAt: at(4), method: 'qr', lateMin: 0 };
    d.proofs[`${DATE}:b-temple`] = { id: `${DATE}:b-temple`, u: 1, date: DATE, blockId: 'b-temple', category: 'devotion', status: 'done', note: '', links: [], auto: [], at: at(8) };
    const s = dayStatus(d, at(10, 15));
    expect(s.state).toBe('drifting');
  });
  it('escalates to rescue after the threshold', () => {
    const d = doc();
    d.wake[DATE] = { id: DATE, u: 1, verifiedAt: at(4), method: 'qr', lateMin: 0 };
    expect(dayStatus(d, at(10, 25)).state).toBe('rescue');
  });
  it('rings the wake gate until verified', () => {
    const d = doc();
    expect(wakeDue(d, at(4, 5)).due).toBe(true);
    d.wake[DATE] = { id: DATE, u: 1, verifiedAt: at(4, 5), method: 'qr', lateMin: 5 };
    expect(wakeDue(d, at(4, 6)).due).toBe(false);
  });
});

describe('rescue', () => {
  it('rebuilds a late-wake day: devotion kept, IIT protected, founder compressed, anchors fixed', () => {
    const d = doc();
    const r = buildRescue(d, DATE, at(6, 30), { lateWakeMin: 150 });
    const live = r.blocks.filter((b) => !b.missed);
    // contiguous, no overlap from 06:30 to end of day
    const future = live.filter((b) => b.e > r.from).sort((a, b) => a.s - b.s);
    let cursor = r.from;
    for (const b of future) {
      expect(b.s).toBe(cursor);
      cursor = b.e;
    }
    expect(cursor).toBe(1440);
    const minutes = (cat: string) => future.filter((b) => b.category === cat).reduce((a, b) => a + b.e - b.s, 0);
    expect(minutes('iit')).toBe(120);
    expect(minutes('devotion')).toBe(240 + 60);
    expect(minutes('founder')).toBeLessThan(360);
    expect(minutes('founder')).toBeGreaterThanOrEqual(120);
    const aarti = future.find((b) => b.id === 'b-aarti')!;
    expect(fmtClock(clockOf(aarti.s, 240))).toBe('7:00 PM');
    const sleep = future.find((b) => b.category === 'sleep')!;
    expect(fmtClock(clockOf(sleep.s, 240))).toBe('9:00 PM');
    expect(r.feasible).toBe(true);
    expect(r.summary[0]).toContain('2h 30m');
  });

  it('puts a missed IIT minimum back into the afternoon', () => {
    const d = doc();
    d.wake[DATE] = { id: DATE, u: 1, verifiedAt: at(4), method: 'qr', lateMin: 0 };
    const r = buildRescue(d, DATE, at(13, 0));
    const recovered = r.blocks.filter((b) => b.category === 'iit' && b.e > r.from);
    expect(recovered.reduce((a, b) => a + b.e - b.s, 0)).toBe(120);
    expect(r.summary.join(' ')).toMatch(/IIT/);
  });
});

describe('rescue under overload', () => {
  it('trims founder work instead of dropping it and leaves no idle hour', () => {
    const d = doc();
    d.wake[DATE] = { id: DATE, u: 1, verifiedAt: at(4), method: 'qr', lateMin: 0 };
    const r = buildRescue(d, DATE, at(14, 55));
    const future = r.blocks.filter((b) => !b.missed && b.e > r.from);
    const founder = future.filter((b) => b.category === 'founder').reduce((a, b) => a + b.e - b.s, 0);
    const buffer = future.filter((b) => b.category === 'buffer').reduce((a, b) => a + b.e - b.s, 0);
    expect(founder).toBeGreaterThan(0);
    expect(buffer).toBeLessThan(15);
    expect(future.filter((b) => b.category === 'iit').reduce((a, b) => a + b.e - b.s, 0)).toBe(120);
  });
});

describe('score & focus', () => {
  it('scores 100 when everything expected so far is done', () => {
    const d = doc();
    d.wake[DATE] = { id: DATE, u: 1, verifiedAt: at(4), method: 'qr', lateMin: 0 };
    d.proofs[`${DATE}:b-temple`] = { id: `${DATE}:b-temple`, u: 1, date: DATE, blockId: 'b-temple', category: 'devotion', status: 'done', note: '', links: [], auto: [], at: at(8) };
    d.sessions.s1 = { id: 's1', u: 1, date: DATE, blockId: 'b-iit', category: 'iit', start: at(10), end: at(12) };
    const s = dayScore(d, DATE, at(12, 0));
    expect(s.score).toBeGreaterThanOrEqual(95);
  });
  it('turns focus guard on during IIT and off at lunch', () => {
    const d = doc();
    expect(focusState(d, at(10, 30)).active).toBe(true);
    expect(focusState(d, at(17, 30)).active).toBe(false);
  });
});

describe('merge', () => {
  it('keeps the newest version of each record', () => {
    const a = doc();
    const b = doc();
    a.tasks.t1 = { id: 't1', u: 5, title: 'old', area: 'iit', priority: 2, done: false, createdAt: 1 };
    b.tasks.t1 = { id: 't1', u: 9, title: 'new', area: 'iit', priority: 2, done: false, createdAt: 1 };
    b.tasks.t2 = { id: 't2', u: 3, title: 'only b', area: 'founder', priority: 1, done: false, createdAt: 1 };
    a.settings = { ...a.settings, u: 10, name: 'A' };
    b.settings = { ...b.settings, u: 4, name: 'B' };
    const m = mergeDocs(a, b);
    expect(m.tasks.t1.title).toBe('new');
    expect(m.tasks.t2.title).toBe('only b');
    expect(m.settings.name).toBe('A');
  });
});

describe('planner', () => {
  it('parses fenced JSON and drops unknown block ids', () => {
    const reply = 'Here you go:\n```json\n{"outcomes":[{"text":"Submit A3","area":"iit"}],"missions":[{"blockId":"b-iit","title":"Submit A3","steps":["Q1-Q5"]},{"blockId":"nope","title":"x"}]}\n```';
    const r = parsePlannerReply(reply, ['b-iit', 'b-founder']);
    expect(r.missions).toHaveLength(1);
    expect(r.outcomes[0].area).toBe('iit');
  });
  it('smart fill assigns tasks by area', () => {
    const d = doc();
    d.tasks.a = { id: 'a', u: 1, title: 'Probability assignment 4', area: 'iit', priority: 1, deadline: DATE, done: false, createdAt: 1, estimate: 85 };
    d.tasks.b = { id: 'b', u: 1, title: 'Onboarding UI', area: 'founder', priority: 1, done: false, createdAt: 1, estimate: 120 };
    const r = smartFill(d, DATE, at(4));
    expect(r.missions.find((m) => m.blockId === 'b-iit')?.title).toBe('Probability assignment 4');
    expect(r.missions.find((m) => m.blockId === 'b-founder')?.title).toBe('Onboarding UI');
    expect(r.outcomes[0].area).toBe('iit');
  });
});

describe('stats', () => {
  it('computes a week without crashing on an empty doc', () => {
    const d = doc();
    const s = weekStats(d, '2026-10-05', at(20));
    expect(s.days.length).toBe(0); // nothing tracked yet -> nothing counted, no fake 0% days
    expect(s.recommendation).toBeNull();
    expect(dayStartMs(DATE, 240)).toBe(at(4));
  });
});

describe('stats start date', () => {
  it('ignores days before the user started', () => {
    const d = doc();
    d.settings.startedOn = DATE;
    const s = weekStats(d, '2026-10-05', at(20));
    expect(s.days.map((x) => x.date)).toEqual([DATE]);
    expect(s.slots.every((x) => x.scheduled <= 2)).toBe(true);
  });
});
