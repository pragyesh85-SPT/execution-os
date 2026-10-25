import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HubDb } from '../server/db';
import { emptyDoc } from '../src/core/defaults';
import { missionFor, planFor } from '../src/core/engine';
import * as ops from '../src/core/ops';
import {
  addProposal,
  applyProposal,
  expireProposals,
  isStale,
  makeProposal,
  makeRescueProposal,
  pendingProposals,
  rebaseProposal,
  rejectProposal,
  validateDayBlocks,
} from '../src/core/proposals';
import { buildRescue, buildWeekRescue } from '../src/core/rescue';
import { planSync, type Conflict } from '../src/core/sync';
import type { Doc } from '../src/core/types';

const DATE = '2026-10-07';
const NEXT = '2026-10-08';
const at = (h: number, m = 0) => new Date(2026, 9, 7, h, m).getTime();
const off = (h: number, m = 0) => (h - 4) * 60 + m;
const none = new Map<string, Conflict>();

function doc(): Doc {
  const d = emptyDoc();
  d.settings.onboarded = true;
  d.wake[DATE] = { id: DATE, u: 1, verifiedAt: at(4), method: 'qr', lateMin: 0 };
  return d;
}
const run = <R>(d: Doc, op: (d: Doc, now: number) => R, now = at(13)) => op(d, now);

function rescueProposal(d: Doc, now = at(13)) {
  run(d, ops.setMission(DATE, 'b-admin', { title: 'Invoice clients', steps: [] }), now - 60_000);
  const r = buildRescue(d, DATE, now);
  const w = buildWeekRescue(d, DATE, now);
  const p = makeRescueProposal(d, DATE, now, r, w, { reason: 'manual' });
  run(d, addProposal(p), now);
  return p;
}

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'eos-prop-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('applying proposals', () => {
  it('apply for today writes only today; apply for the week writes every day in it', () => {
    const a = doc();
    const p = rescueProposal(a);
    expect(p.days.map((x) => x.date)).toEqual([DATE, NEXT]);
    const b = structuredClone(a);
    const today = run(a, applyProposal(p.id, 'today'), at(13, 1));
    expect(today.dates).toEqual([DATE]);
    expect(a.days[NEXT]).toBeUndefined();
    expect(Object.values(a.tasks).some((t) => t.title === 'Invoice clients' && t.carried)).toBe(true); // today-only: dropped mission → inbox
    const week = run(b, applyProposal(p.id, 'week'), at(13, 1));
    expect(week.dates).toEqual([DATE, NEXT]);
    const next = planFor(b, NEXT);
    expect(Object.values(next.missions).map((m) => m.title)).toContain('Invoice clients');
    expect(Object.values(b.tasks).some((t) => t.title === 'Invoice clients')).toBe(false); // moved, not duplicated
    expect(b.proposals[p.id]).toMatchObject({ status: 'applied', appliedScope: 'week' });
    expect(planFor(b, DATE).rescue?.scope).toBe('week');
  });

  it('a second apply says it was already applied', () => {
    const d = doc();
    const p = rescueProposal(d);
    run(d, applyProposal(p.id, 'today'), at(13, 1));
    expect(() => run(d, applyProposal(p.id, 'today'), at(13, 2))).toThrow(/already applied/);
  });

  it('a newer pending proposal of the same kind and date supersedes the older one', () => {
    const d = doc();
    const p1 = rescueProposal(d, at(13));
    const p2 = makeRescueProposal(d, DATE, at(13, 5), buildRescue(d, DATE, at(13, 5)), null);
    run(d, addProposal(p2), at(13, 5));
    expect(d.proposals[p1.id].status).toBe('superseded');
    expect(pendingProposals(d).map((p) => p.id)).toEqual([p2.id]);
  });

  it('reject marks it rejected and changes nothing else', () => {
    const d = doc();
    const p = rescueProposal(d);
    const before = structuredClone(d.days);
    run(d, rejectProposal(p.id, 'not today'), at(13, 1));
    expect(d.proposals[p.id]).toMatchObject({ status: 'rejected', rejectReason: 'not today' });
    expect(d.days).toEqual(before);
  });
});

describe('validation', () => {
  it('repairs a proposal that moves sleep and warns about a shortfall', () => {
    const d = doc();
    const v = validateDayBlocks(d, DATE, [
      { title: 'Sleep', category: 'sleep', s: off(23), e: 1440 }, // AI tried to move sleep to 23:00
      { title: 'Deep work', category: 'founder', s: off(12), e: off(17) },
      { title: 'Late session', category: 'founder', s: off(20), e: off(22) }, // overlaps the 21:00 sleep anchor
    ]);
    expect(v.ok).toBe(true);
    const sleep = v.blocks.find((b) => b.category === 'sleep')!;
    expect([sleep.s, sleep.e]).toEqual([off(21), 1440]);
    const late = v.blocks.find((b) => b.title === 'Late session')!;
    expect(late.e).toBe(off(21));
    expect(v.warnings.join(' ')).toMatch(/trimmed/);
    expect(v.warnings.join(' ')).toMatch(/IIT/); // no IIT planned
    // the day is covered end to end with no overlaps
    let c = 0;
    for (const b of v.blocks.filter((x) => !x.missed).sort((a, b) => a.s - b.s)) {
      expect(b.s).toBe(c);
      c = b.e;
    }
    expect(c).toBe(1440);
  });

  it('rejects a block overlapping a pin, naming the pin; snaps odd minutes', () => {
    const d = doc();
    run(d, ops.addDayBlock(DATE, { title: 'Investor call', category: 'founder', start: off(16), end: off(17) }), at(4, 30));
    const v = validateDayBlocks(d, DATE, [{ title: 'Study', category: 'iit', s: off(15, 30), e: off(16, 30) }]);
    expect(v.ok).toBe(false);
    expect(v.errors[0]).toMatch(/Investor call/);
    const w = validateDayBlocks(d, DATE, [{ title: 'Study', category: 'iit', s: off(10) + 2, e: off(12) - 1 }]);
    expect(w.blocks.find((b) => b.title === 'Study')).toMatchObject({ s: off(10), e: off(12) });
  });

  it('rejects overlapping proposed blocks', () => {
    const v = validateDayBlocks(doc(), DATE, [
      { title: 'A', category: 'founder', s: off(10), e: off(12) },
      { title: 'B', category: 'iit', s: off(11), e: off(13) },
    ]);
    expect(v.ok).toBe(false);
    expect(v.errors[0]).toMatch(/overlap/);
  });
});

describe('staleness and rebase', () => {
  it('an edit after the proposal makes it stale; apply refuses; rebase supersedes and applies cleanly', () => {
    const d = doc();
    const p = rescueProposal(d);
    expect(isStale(d, p)).toBe(false);
    run(d, ops.addDayBlock(DATE, { title: 'Call with mentor', category: 'founder', start: off(15), end: off(16) }), at(13, 2));
    expect(isStale(d, p)).toBe(true);
    expect(() => run(d, applyProposal(p.id, 'today'), at(13, 3))).toThrow(/re-checked/);
    const freshId = run(d, rebaseProposal(p.id), at(13, 3));
    expect(d.proposals[p.id].status).toBe('superseded');
    expect(d.proposals[freshId].supersedes).toBe(p.id);
    run(d, applyProposal(freshId, 'today'), at(13, 4));
    const pin = planFor(d, DATE).blocks.find((b) => b.title === 'Call with mentor')!;
    expect([pin.s, pin.e]).toEqual([off(15), off(16)]);
  });

  it('a stale AI plan keeps only blocks that still fit and lists what was dropped', () => {
    const d = doc();
    const v = validateDayBlocks(d, NEXT, [
      { title: 'Lecture 7', category: 'iit', s: off(10), e: off(12) },
      { title: 'Build checkout', category: 'founder', s: off(14), e: off(16) },
    ]);
    const p = makeProposal(d, { kind: 'day_plan', source: 'mcp', client: 'claude', title: 'Plan for Thu', date: NEXT, days: [{ date: NEXT, blocks: v.blocks, lines: v.lines }], scopeAllowed: ['today'] }, at(13));
    run(d, addProposal(p));
    run(d, ops.addDayBlock(NEXT, { title: 'Dentist', category: 'care', start: off(15), end: off(16) }), at(13, 1));
    const id = run(d, rebaseProposal(p.id), at(13, 2));
    const fresh = d.proposals[id];
    expect(fresh.warnings?.join(' ')).toMatch(/Build checkout.*Dentist/);
    expect(fresh.days[0].blocks.some((b) => b.title === 'Lecture 7')).toBe(true);
    expect(fresh.days[0].blocks.some((b) => b.title === 'Build checkout')).toBe(false);
    run(d, applyProposal(id, 'today'), at(13, 3));
    expect(planFor(d, NEXT).plannedBy).toBe('ai');
  });
});

describe('expiry', () => {
  it('expires overdue pending proposals once and never touches decided ones', () => {
    const d = doc();
    const p1 = rescueProposal(d);
    const p2 = makeProposal(d, { kind: 'day_plan', source: 'mcp', title: 'x', date: NEXT, days: [{ date: NEXT, blocks: planFor(d, NEXT).blocks, lines: [] }], scopeAllowed: ['today'] }, at(13));
    run(d, addProposal(p2));
    run(d, rejectProposal(p2.id), at(13, 1));
    const late = p1.expiresAt + 1;
    expect(run(d, expireProposals(), late)).toBe(1);
    expect(d.proposals[p1.id].status).toBe('expired');
    expect(d.proposals[p2.id].status).toBe('rejected');
    expect(run(d, expireProposals(), late + 1000)).toBe(0);
  });
});

describe('proposals sync between devices', () => {
  it('a proposal made on the PC is applied on the phone and shows applied on the PC', () => {
    const hub = new HubDb(join(dir, 'sync.db'));
    // PC (the hub itself) creates a rescue proposal
    hub.mutate((d, now) => {
      d.wake[DATE] = { id: DATE, u: now, verifiedAt: now, method: 'qr', lateMin: 0 };
      const r = buildRescue(d, DATE, at(13));
      return addProposal(makeRescueProposal(d, DATE, at(13), r, null))(d, now);
    }, 'PC');
    const pid = pendingProposals(hub.doc)[0].id;
    // phone: first sync downloads it
    const phoneSynced = emptyDoc();
    const first = planSync(phoneSynced, emptyDoc(), structuredClone(hub.doc), none, 0);
    const phone = first.local;
    expect(pendingProposals(phone).map((p) => p.id)).toEqual([pid]);
    // phone applies it locally, then uploads
    ops.setRandom(() => 0.5);
    applyProposal(pid, 'today', 'Android')(phone, at(13, 1));
    ops.setRandom(null);
    const second = planSync(structuredClone(hub.doc), phone, structuredClone(hub.doc), none, 0);
    expect(second.conflicts).toHaveLength(0);
    const res = hub.push(second.push, 'Android');
    expect(res.rejected).toHaveLength(0);
    expect(hub.doc.proposals[pid]).toMatchObject({ status: 'applied', decidedBy: 'Android' });
    expect(hub.doc.days[DATE].rescue).toBeTruthy();
    hub.close();
  });
});
