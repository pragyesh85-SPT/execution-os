import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { emptyDoc } from '../src/core/defaults';
import { missionFor, planFor } from '../src/core/engine';
import * as ops from '../src/core/ops';
import { buildRescue, buildWeekRescue, rescueOptions, type RescueResult } from '../src/core/rescue';
import type { Doc, PlanBlock } from '../src/core/types';

const DATE = '2026-10-07'; // a Wednesday
const NEXT = '2026-10-08';
const at = (h: number, m = 0) => new Date(2026, 9, 7, h, m).getTime();
const off = (h: number, m = 0) => (h - 4) * 60 + m; // offsets for the default 04:00 day start

function doc(woke = true): Doc {
  const d = emptyDoc();
  d.settings.onboarded = true;
  if (woke) d.wake[DATE] = { id: DATE, u: 1, verifiedAt: at(4), method: 'qr', lateMin: 0 };
  return d;
}
const run = <R>(d: Doc, op: (d: Doc, now: number) => R, now = at(4, 30)) => op(d, now);
const future = (r: RescueResult) => r.blocks.filter((b) => !b.missed && b.e > r.from).sort((a, b) => a.s - b.s);
const mins = (bs: PlanBlock[], cat: string) => bs.filter((b) => b.category === cat).reduce((a, b) => a + b.e - b.s, 0);

describe('rescue v2 regression guard: no pins + balanced + no history = v1', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/rescue-v1.json', import.meta.url), 'utf8')) as Record<
    string,
    { blocks: PlanBlock[]; summary: string[]; feasible: boolean; from: number; dropped: string[]; reduced: string[] }
  >;
  const scen: [string, number, boolean, number?][] = [
    ['late-wake-0630', at(6, 30), false, 150],
    ['wake-1300', at(13), true],
    ['overload-1455', at(14, 55), true],
    ['not-started-1025', at(10, 25), true],
    ['evening-1730', at(17, 30), true],
    ['night-2030', at(20, 30), true],
    ['early-0500', at(5), false, 60],
    ['midday-1200', at(12), true],
  ];
  for (const [name, now, woke, late] of scen) {
    it(name, () => {
      const d = doc(woke);
      if (name === 'midday-1200') d.sessions.s1 = { id: 's1', u: 1, date: DATE, blockId: 'b-founder', category: 'founder', start: at(12), end: at(12, 20) };
      for (const opts of [late ? { lateWakeMin: late } : {}, { ...(late ? { lateWakeMin: late } : {}), strategy: 'balanced' as const, slotRates: {} }]) {
        const r = buildRescue(d, DATE, now, opts);
        const v1 = fixture[name];
        expect(r.blocks).toEqual(v1.blocks);
        expect(r.summary).toEqual(v1.summary);
        expect(r.feasible).toBe(v1.feasible);
        expect(r.from).toBe(v1.from);
        expect(r.dropped.map((b) => b.id)).toEqual(v1.dropped);
        expect(r.reduced.map((b) => b.id)).toEqual(v1.reduced);
      }
    });
  }
});

describe('pinned blocks', () => {
  it('a pinned 16:00–17:00 block survives a late-wake rescue at exactly the same time, with its mission', () => {
    const d = doc(false);
    const id = run(d, ops.addDayBlock(DATE, { title: 'Investor call prep', category: 'founder', start: off(16), end: off(17), mission: { title: 'Deck v3 ready', steps: [] } }));
    const r = buildRescue(d, DATE, at(6, 30), { lateWakeMin: 150 });
    const pin = r.blocks.find((b) => b.id === id)!;
    expect([pin.s, pin.e]).toEqual([off(16), off(17)]);
    expect(pin.pinned && pin.fixed).toBe(true);
    expect(r.pinnedCount).toBe(1);
    run(d, ops.applyRescue(DATE, r), at(6, 31));
    const plan = planFor(d, DATE);
    const after = plan.blocks.find((b) => b.id === id)!;
    expect([after.s, after.e]).toEqual([off(16), off(17)]);
    expect(missionFor(plan, after)?.title).toBe('Deck v3 ready');
    expect(plan.rescues).toHaveLength(1);
  });

  it('no rescue at any time of day moves, shortens or drops a pin', () => {
    const d = doc();
    const id = run(d, ops.addDayBlock(DATE, { title: 'Class', category: 'iit', start: off(16), end: off(17, 30) }));
    for (let h = 4.5; h < 21; h += 0.5) {
      for (const strategy of ['balanced', 'protect_study', 'ship', 'light'] as const) {
        const r = buildRescue(d, DATE, at(Math.floor(h), (h % 1) * 60), { strategy });
        const pin = r.blocks.find((b) => b.id === id)!;
        expect([pin.s, pin.e]).toEqual([off(16), off(17, 30)]);
      }
    }
  });

  it('pinning a template block keeps it through a rescue; unpinning restores the template value', () => {
    const d = doc();
    run(d, ops.pinBlock(DATE, 'b-founder', true));
    const pinned = planFor(d, DATE).blocks.find((b) => b.id === 'b-founder')!;
    expect(pinned).toMatchObject({ pinned: true, fixed: true });
    const r = buildRescue(d, DATE, at(13));
    const kept = r.blocks.find((b) => b.id === 'b-founder')!;
    expect([kept.s, kept.e]).toEqual([off(12), off(17)]);
    expect(r.lines.some((l) => l.kind === 'kept' && l.blockId === 'b-founder' && /pinned/.test(l.reason))).toBe(true);
    run(d, ops.pinBlock(DATE, 'b-founder', false));
    const unpinned = planFor(d, DATE).blocks.find((b) => b.id === 'b-founder')!;
    expect(unpinned.pinned).toBeUndefined();
    expect(unpinned.fixed).toBe(false);
  });

  it('anchors, buffers and missed blocks cannot be pinned', () => {
    const d = doc();
    expect(() => run(d, ops.pinBlock(DATE, 'b-sleep', true))).toThrow(/anchor/);
    expect(() => run(d, ops.pinBlock(DATE, 'nope', true))).toThrow(/does not exist/);
    const r = buildRescue(d, DATE, at(13));
    run(d, ops.applyRescue(DATE, r), at(13));
    const buffer = planFor(d, DATE).blocks.find((b) => b.category === 'buffer');
    if (buffer) expect(() => run(d, ops.pinBlock(DATE, buffer.id, true))).toThrow(/Buffer/);
    const ghost = planFor(d, DATE).blocks.find((b) => b.missed);
    if (ghost) expect(() => run(d, ops.pinBlock(DATE, ghost.id, true))).toThrow(/missed/);
  });

  it('addDayBlock refuses overlap with sleep and with another pin, and carves flexible blocks keeping missions', () => {
    const d = doc();
    expect(() => run(d, ops.addDayBlock(DATE, { title: 'Late call', category: 'founder', start: off(20, 30), end: off(21, 30) }))).toThrow(/Sleep/);
    run(d, ops.setMission(DATE, 'b-founder', { title: 'Onboarding UI', steps: [] }));
    run(d, ops.addDayBlock(DATE, { title: 'Investor call prep', category: 'founder', start: off(14), end: off(15) }));
    expect(() => run(d, ops.addDayBlock(DATE, { title: 'Other', category: 'founder', start: off(14, 30), end: off(15, 30) }))).toThrow(/Investor call prep/);
    expect(() => run(d, ops.addDayBlock(DATE, { title: 'Odd', category: 'founder', start: off(14) + 3, end: off(15) }))).toThrow(/5-minute/);
    const plan = planFor(d, DATE);
    const halves = plan.blocks.filter((b) => (b.origin ?? b.id) === 'b-founder');
    expect(halves.map((b) => [b.s, b.e])).toEqual([
      [off(12), off(14)],
      [off(15), off(17)],
    ]);
    for (const h of halves) expect(missionFor(plan, h)?.title).toBe('Onboarding UI');
    // carving the same block twice never produces duplicate ids
    run(d, ops.addDayBlock(DATE, { title: 'Second pin', category: 'care', start: off(12, 30), end: off(13) }));
    const ids = planFor(d, DATE).blocks.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('moveDayBlock moves only flexible blocks and leaves Buffer behind', () => {
    const d = doc();
    run(d, ops.moveDayBlock(DATE, 'b-admin', off(15), off(16)));
    const plan = planFor(d, DATE);
    expect(plan.blocks.find((b) => b.id === 'b-admin')).toMatchObject({ s: off(15), e: off(16) });
    expect(plan.blocks.find((b) => b.s === off(18) && b.category === 'buffer')).toBeTruthy();
    expect(() => run(d, ops.moveDayBlock(DATE, 'b-aarti', off(15), off(16)))).toThrow(/fixed/);
    expect(() => run(d, ops.moveDayBlock(DATE, 'b-admin', off(19), off(20)))).toThrow(/Aarti/);
  });

  it('a planned exception still works (and snaps to 5 minutes)', () => {
    const d = doc();
    run(d, ops.addException(DATE, off(15) + 2, off(17) + 2, 'Movie'));
    const x = planFor(d, DATE).blocks.find((b) => b.exception)!;
    expect(x).toMatchObject({ s: off(15), e: off(17) + 5, fixed: true, category: 'entertainment' });
    expect(x.pinned).toBeUndefined();
  });
});

describe('rescue v2 behaviour', () => {
  it('an over-constrained day returns feasible: false and names the pins', () => {
    const d = doc();
    run(d, ops.addDayBlock(DATE, { title: 'Workshop', category: 'founder', start: off(13, 5), end: off(19) }));
    run(d, ops.addDayBlock(DATE, { title: 'Family dinner', category: 'meal', start: off(20), end: off(21) }));
    const r = buildRescue(d, DATE, at(13));
    expect(r.feasible).toBe(false);
    expect(r.summary[0]).toMatch(/Over-constrained/);
    expect(r.summary[0]).toMatch(/Workshop/);
    expect(r.summary[0]).toMatch(/Family dinner/);
    expect(r.summary[0]).toMatch(/minutes short/);
  });

  it('protect_study gives IIT its full target when capacity allows', () => {
    const d = doc();
    d.settings.targets.iit = 180;
    expect(mins(future(buildRescue(d, DATE, at(13))), 'iit')).toBe(120);
    expect(mins(future(buildRescue(d, DATE, at(13), { strategy: 'protect_study' })), 'iit')).toBeGreaterThanOrEqual(180);
  });

  it('ship places the top mission’s block before any priority ≥ 3 block', () => {
    const d = doc();
    d.tasks.t1 = { id: 't1', u: 1, title: 'Ship onboarding', area: 'founder', priority: 1, deadline: DATE, done: false, createdAt: 1 };
    run(d, ops.setMission(DATE, 'b-admin', { title: 'Ship onboarding', steps: [] }));
    const r = buildRescue(d, DATE, at(13), { strategy: 'ship' });
    const placed = future(r).filter((b) => b.rescued && b.category !== 'buffer');
    const ship = placed.find((b) => (b.origin ?? b.id) === 'b-admin')!;
    expect(ship).toBeTruthy();
    for (const b of placed) if (b !== ship && b.priority >= 3) expect(ship.s).toBeLessThan(b.s);
  });

  it('light halves founder minimums and adds a rest when there is room', () => {
    const d = doc();
    const r = buildRescue(d, DATE, at(10, 30), { strategy: 'light' });
    expect(future(r).some((b) => b.title === 'Rest — light day')).toBe(true);
    expect(r.lines.some((l) => l.kind === 'added' && /light day/.test(l.reason))).toBe(true);
  });

  it('slotRates puts a priority-1 IIT block into the historically best free window', () => {
    const d = doc();
    const rates = { 'iit@960': 0.9, 'iit@1020': 0.9, 'iit@780': 0.3 }; // 16:00, 17:00 strong; 13:00 weak
    const r = buildRescue(d, DATE, at(13), { slotRates: rates });
    const iit = future(r).find((b) => b.category === 'iit')!;
    expect([iit.s, iit.e]).toEqual([off(16), off(18)]);
    expect(r.lines.find((l) => l.blockId === iit.id)?.reason).toMatch(/Added/);
  });

  it('every change has a one-sentence reason', () => {
    const d = doc();
    run(d, ops.addDayBlock(DATE, { title: 'Investor call prep', category: 'founder', start: off(16), end: off(17) }));
    const r = buildRescue(d, DATE, at(13, 0));
    expect(r.lines.length).toBeGreaterThan(2);
    for (const l of r.lines) {
      expect(l.reason.length).toBeGreaterThan(10);
      expect(l.reason.trim().endsWith('.')).toBe(true);
    }
    expect(r.lines.some((l) => l.kind === 'kept' && /Investor call prep.*pinned/.test(l.reason))).toBe(true);
    // a pin in the middle of a long free stretch splits the flexible work around it
    const d2 = doc();
    run(d2, ops.addDayBlock(DATE, { title: 'Investor call prep', category: 'founder', start: off(13), end: off(14) }));
    const r2 = buildRescue(d2, DATE, at(10, 30));
    const split = r2.lines.find((l) => l.kind === 'split');
    expect(split?.reason).toMatch(/around the 13:00 pin "Investor call prep"/);
  });

  it('hints may change priorities and mission titles only', () => {
    const d = doc();
    const r = buildRescue(d, DATE, at(13), { hints: [{ blockId: 'b-admin', priority: 1, missionTitle: 'Send invoices' }, { blockId: 'b-sleep', priority: 5 }, { blockId: 'bogus' }] });
    expect(r.missions?.['b-admin']?.title).toBe('Send invoices');
    expect(r.blocks.find((b) => b.id === 'b-sleep')).toMatchObject({ s: off(21), e: 1440 });
    expect(r.dropped.map((b) => b.id)).not.toContain('b-admin');
  });

  it('rescueOptions returns at most three distinct layouts with headlines', () => {
    const d = doc();
    d.settings.targets.iit = 180;
    const list = rescueOptions(d, DATE, at(13));
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list.length).toBeLessThanOrEqual(3);
    const sigs = list.map((r) => JSON.stringify(r.blocks.filter((b) => !b.missed).map((b) => [b.category, b.title, b.s, b.e])));
    expect(new Set(sigs).size).toBe(sigs.length);
    for (const r of list) expect(r.headline).toMatch(/gives up/);
    expect(list[0].strategy).toBe('balanced');
  });
});

describe('week rescue', () => {
  it('moves today’s dropped focus mission into the next matching focus block and never touches that day’s pins', () => {
    const d = doc();
    run(d, ops.setMission(DATE, 'b-admin', { title: 'Invoice clients', steps: [] }));
    const pinId = run(d, ops.addDayBlock(NEXT, { title: 'Doctor', category: 'founder', start: off(10), end: off(11) }));
    const before = structuredClone(planFor(d, NEXT).blocks);
    const w = buildWeekRescue(d, DATE, at(13));
    expect(w.today.dropped.map((b) => b.id)).toContain('b-admin');
    expect(w.days.map((x) => x.date)).toEqual([NEXT]);
    const line = w.days[0].lines[0];
    expect(line.blockId).not.toBe(pinId);
    expect(line.reason).toMatch(/Invoice clients/);
    expect(w.toInbox).toHaveLength(0);
    const tasksBefore = Object.keys(d.tasks).length;
    run(d, ops.applyWeekRescue(w), at(13, 1));
    const next = planFor(d, NEXT);
    expect(next.blocks).toEqual(before);
    expect(missionFor(next, next.blocks.find((b) => b.id === line.blockId)!)?.title).toBe('Invoice clients');
    expect(Object.keys(d.tasks).length).toBe(tasksBefore); // not duplicated into the inbox
    expect(planFor(d, DATE).rescue?.scope).toBe('week');
  });

  it('missions that fit nowhere this week go to the inbox', () => {
    const d = doc();
    const SUNDAY = '2026-10-11';
    d.wake[SUNDAY] = { id: SUNDAY, u: 1, verifiedAt: new Date(2026, 9, 11, 4).getTime(), method: 'qr', lateMin: 0 };
    run(d, ops.setMission(SUNDAY, 'b-admin', { title: 'Weekly accounts', steps: [] }));
    const w = buildWeekRescue(d, SUNDAY, new Date(2026, 9, 11, 13).getTime());
    expect(w.days).toHaveLength(0);
    expect(w.toInbox.map((x) => x.title)).toEqual(['Weekly accounts']);
    run(d, ops.applyWeekRescue(w), new Date(2026, 9, 11, 13, 1).getTime());
    expect(Object.values(d.tasks).some((t) => t.title === 'Weekly accounts' && t.carried)).toBe(true);
  });

  it('refuses to apply a rescue built before a block was pinned', () => {
    const d = doc();
    const r = buildRescue(d, DATE, at(13));
    run(d, ops.pinBlock(DATE, 'b-admin', true));
    expect(() => run(d, ops.applyRescue(DATE, r), at(13, 1))).toThrow(/pinned after/);
  });
});
