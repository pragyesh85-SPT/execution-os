import { liveBlocks, missionFor, planFor } from './engine';
import { areaOf, carve, OpError, uid, type Op } from './ops';
import { applyProposal, makeProposal, addProposal } from './proposals';
import type { Doc, Mission, OverrideEntry, PlanBlock, ProposalTask } from './types';
import { clockOf, fmtClock, logicalDate, offsetOf, weekKey, weekDays } from './time';

// "I'm doing something else" inside a reserved block. Three honest choices:
//   swap   — this block's mission becomes the new thing; the old mission goes back to the inbox
//   borrow — a short 15/30-minute detour; the block keeps its end time
//   drift  — an honest log of time that went elsewhere
// Each is an "override" proposal applied at once, so it is validated, recorded and undoable like any
// other change. Swaps count as intentional, not drift — but the weekly count is shown so they do not
// become a loophole.

export type OverrideChoice = { kind: 'swap'; what: string } | { kind: 'borrow'; what: string; minutes: 15 | 30 } | { kind: 'drift'; what: string; minutes: number };

export function overrideProposal(doc: Doc, date: string, blockId: string, choice: OverrideChoice, nowMs: number) {
  const ds = doc.settings.dayStart;
  const plan = planFor(doc, date);
  const block = plan.blocks.find((b) => b.id === blockId && !b.missed);
  if (!block) throw new OpError('no_block', 'That block is not on today’s plan any more.');
  const what = choice.what.trim().slice(0, 120);
  if (!what) throw new OpError('what', 'Say what you are doing instead.');
  const old = missionFor(plan, block);
  const now = Math.floor(offsetOf(nowMs, date, ds) / 5) * 5;
  let blocks: PlanBlock[] = plan.blocks;
  const missions: Record<string, Mission> = {};
  const tasks: ProposalTask[] = [];
  let line = '';
  const entry: OverrideEntry = { at: nowMs, blockId, kind: choice.kind };

  if (choice.kind === 'swap') {
    missions[block.id] = { title: what, steps: [], source: 'manual' };
    if (old?.title) tasks.push({ title: old.title, area: areaOf(block.category), priority: 2, carried: true, ...(old.goalId ? { goalId: old.goalId } : {}) });
    entry.from = old?.title;
    entry.to = what;
    line = `Swap the mission of "${block.title}" to "${what}"${old ? `; "${old.title}" goes back to the inbox` : ''}.`;
  } else if (choice.kind === 'borrow') {
    const s = Math.max(block.s, now);
    const e = Math.min(block.e, s + choice.minutes);
    if (e - s < 5) throw new OpError('no_room', 'There is no time left in this block to borrow.');
    const detour: PlanBlock = { id: uid('o', nowMs), title: `Detour · ${what}`, category: 'buffer', s, e, fixed: false, focus: false, minMinutes: 0, priority: 5, source: 'user' };
    // carve the detour into the block only; the block's end time stays where it is
    const others = plan.blocks.filter((b) => b.id !== block.id);
    const cut = carve([{ ...block, fixed: false }], detour).map((b) => (b.id === detour.id ? b : { ...b, fixed: block.fixed, ...(block.pinned ? { pinned: true } : {}) }));
    blocks = [...others, ...cut].sort((a, b) => a.s - b.s);
    entry.minutes = e - s;
    entry.to = what;
    line = `Borrow ${e - s} minutes (${fmtClock(clockOf(s, ds), true)}–${fmtClock(clockOf(e, ds), true)}) for "${what}"; "${block.title}" still ends at ${fmtClock(clockOf(block.e, ds), true)}.`;
  } else {
    entry.minutes = Math.max(1, Math.min(600, Math.round(choice.minutes)));
    entry.to = what;
    line = `Log ${entry.minutes} minutes of "${block.title}" as drift (${what}).`;
  }

  const p = makeProposal(
    doc,
    {
      kind: 'override',
      source: 'engine',
      title: choice.kind === 'swap' ? `Swap: ${what}` : choice.kind === 'borrow' ? `Borrow ${entry.minutes} min: ${what}` : `Drift: ${what}`,
      date,
      days: [{ date, blocks, missions, lines: [{ kind: choice.kind === 'borrow' ? 'split' : 'kept', blockId, title: block.title, reason: line }] }],
      scopeAllowed: ['today'],
      tasksToAdd: tasks,
    },
    nowMs,
  );
  return { ...p, override: entry };
}

/** Make the override proposal and apply it in one step (the user already confirmed). */
export const applyOverride =
  (date: string, blockId: string, choice: OverrideChoice): Op<string> =>
  (d, now) => {
    const p = overrideProposal(d, date, blockId, choice, now);
    addProposal(p)(d, now);
    applyProposal(p.id, 'today')(d, now);
    if (choice.kind === 'drift') {
      const id = uid('d', now);
      d.distractions[id] = { id, u: now, date: logicalDate(now, d.settings.dayStart), at: now, minutes: p.override.minutes ?? 15, source: choice.what.slice(0, 60), kind: 'unplanned', note: 'marked as drift' };
    }
    return p.id;
  };

/** This week's overrides, by kind — shown so swaps never become a quiet loophole. */
export function weekOverrides(doc: Doc, date: string): { swap: number; borrow: number; drift: number } {
  const out = { swap: 0, borrow: 0, drift: 0 };
  for (const d of weekDays(weekKey(date))) {
    const p = doc.days[d];
    if (!p || p.del) continue;
    for (const o of p.overrides ?? []) out[o.kind]++;
  }
  return out;
}

export const hasLiveBlock = (doc: Doc, date: string, id: string) => liveBlocks(planFor(doc, date)).some((b) => b.id === id);
