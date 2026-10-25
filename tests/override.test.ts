import { describe, expect, it } from 'vitest';
import { analytics } from '../src/core/analytics';
import { emptyDoc } from '../src/core/defaults';
import { missionFor, planFor } from '../src/core/engine';
import * as ops from '../src/core/ops';
import { applyOverride, weekOverrides } from '../src/core/override';
import type { Doc } from '../src/core/types';

const DATE = '2026-10-07';
const at = (h: number, m = 0) => new Date(2026, 9, 7, h, m).getTime();
const off = (h: number, m = 0) => (h - 4) * 60 + m;
const run = <R>(d: Doc, op: (d: Doc, now: number) => R, now = at(13)) => op(d, now);

function doc() {
  const d = emptyDoc();
  d.settings.onboarded = true;
  run(d, ops.setMission(DATE, 'b-founder', { title: 'Onboarding UI', steps: [] }), at(11));
  return d;
}

describe('quick override', () => {
  it('swap: the block gets the new mission, the old one goes back to the inbox, and it is recorded', () => {
    const d = doc();
    run(d, applyOverride(DATE, 'b-founder', { kind: 'swap', what: 'Investor follow-up emails' }));
    const plan = planFor(d, DATE);
    expect(missionFor(plan, plan.blocks.find((b) => b.id === 'b-founder')!)?.title).toBe('Investor follow-up emails');
    expect(Object.values(d.tasks).some((t) => t.title === 'Onboarding UI' && t.carried)).toBe(true);
    expect(plan.overrides).toEqual([expect.objectContaining({ kind: 'swap', from: 'Onboarding UI', to: 'Investor follow-up emails', blockId: 'b-founder' })]);
    expect(Object.values(d.proposals).find((p) => p.kind === 'override')?.status).toBe('applied');
  });

  it('borrow: a 30-minute detour inside the block; the block keeps its end time and its mission', () => {
    const d = doc();
    run(d, applyOverride(DATE, 'b-founder', { kind: 'borrow', what: 'Call home', minutes: 30 }));
    const plan = planFor(d, DATE);
    const detour = plan.blocks.find((b) => b.title === 'Detour · Call home')!;
    expect([detour.s, detour.e]).toEqual([off(13), off(13, 30)]);
    const parts = plan.blocks.filter((b) => (b.origin ?? b.id) === 'b-founder');
    expect(Math.max(...parts.map((b) => b.e))).toBe(off(17));
    for (const p of parts) expect(missionFor(plan, p)?.title).toBe('Onboarding UI');
  });

  it('borrow works inside a pinned block (confirmed) and keeps the pin', () => {
    const d = doc();
    run(d, ops.pinBlock(DATE, 'b-founder', true), at(11));
    run(d, applyOverride(DATE, 'b-founder', { kind: 'borrow', what: 'Coffee', minutes: 15 }));
    const parts = planFor(d, DATE).blocks.filter((b) => (b.origin ?? b.id) === 'b-founder');
    expect(parts.every((b) => b.pinned && b.fixed)).toBe(true);
  });

  it('drift: an honest log that counts as unplanned distraction; the weekly count shows every kind', () => {
    const d = doc();
    run(d, applyOverride(DATE, 'b-founder', { kind: 'drift', what: 'YouTube', minutes: 25 }));
    run(d, applyOverride(DATE, 'b-founder', { kind: 'swap', what: 'Bug fix' }), at(14));
    expect(Object.values(d.distractions).some((x) => x.minutes === 25 && x.source === 'YouTube' && x.kind === 'unplanned')).toBe(true);
    expect(weekOverrides(d, DATE)).toEqual({ swap: 1, borrow: 0, drift: 1 });
    expect(analytics(d, DATE, DATE, at(23)).overrides).toEqual({ swap: 1, borrow: 0, drift: 1 });
  });

  it('refuses without a description or on a block that is gone', () => {
    const d = doc();
    expect(() => run(d, applyOverride(DATE, 'b-founder', { kind: 'swap', what: '  ' }))).toThrow(/instead/);
    expect(() => run(d, applyOverride(DATE, 'nope', { kind: 'swap', what: 'x' }))).toThrow(/not on today/);
  });
});
