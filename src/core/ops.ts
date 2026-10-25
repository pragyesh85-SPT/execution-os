import { blocksFromTemplate, missionFor, planFor } from './engine';
import { defaultSettings, emptyDoc } from './defaults';
import type { FeatureKey } from './features';
import { mergeDocs } from './merge';
import type { RescueResult, WeekRescueResult } from './rescue';
import {
  COLLECTIONS,
  type Area,
  type BlockDef,
  type Category,
  type DayPlan,
  type Doc,
  type Mission,
  type Outcome,
  type PlanBlock,
  type ProofStatus,
  type RescueInfo,
  type RescueReason,
  type Review,
  type Rule,
  type Settings,
  type Synced,
  type Task,
} from './types';
import { logicalDate, offsetOf } from './time';

// The shared mutation layer. Every edit to the Doc lives here as a pure "op":
//   (doc, now) => result   — mutates the given doc in place.
// The UI runs ops through the Zustand store (src/state/actions.ts); the hub runs the same ops
// through HubDb.mutate (server/db.ts), so a change made by the PC, a phone, the AI connector or
// an automation is always the exact same change, with history and undo.

export type Op<R = void> = (d: Doc, now: number) => R;

/** A refusal with a message a person (or an AI) can act on. Ops throw it; nothing is written. */
export class OpError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'OpError';
  }
}

let rand: () => number = Math.random;

/** Tests can make ids deterministic. Pass null to restore Math.random. */
export function setRandom(fn: (() => number) | null) {
  rand = fn ?? Math.random;
}

export function uid(prefix: string, now = Date.now(), r: () => number = rand): string {
  return `${prefix}-${now.toString(36)}${r().toString(36).slice(2, 7)}`;
}

export const areaOf = (c: Category): Area => (c === 'iit' ? 'iit' : c === 'founder' ? 'founder' : 'personal');

/** Materialise a day's plan (from the template if needed) so it can be edited, and stamp it. */
export function ensurePlan(d: Doc, date: string, now: number): DayPlan {
  let p = d.days[date];
  if (!p || p.del) {
    p = { ...planFor(d, date), u: now };
    delete p.del;
    d.days[date] = p;
  }
  p.u = now;
  return p;
}

// ---------- sessions / proof ----------

export const startSession =
  (date: string, block: Pick<PlanBlock, 'id' | 'category'>): Op<string> =>
  (d, now) => {
    for (const s of Object.values(d.sessions)) {
      if (!s.del && s.end === undefined) {
        s.end = now;
        s.u = now;
      }
    }
    const id = uid('s', now);
    d.sessions[id] = { id, u: now, date, blockId: block.id, category: block.category, start: now };
    return id;
  };

export const stopSession =
  (at?: number): Op =>
  (d, now) => {
    for (const s of Object.values(d.sessions)) {
      if (!s.del && s.end === undefined) {
        s.end = Math.max(s.start, at ?? now);
        s.u = now;
      }
    }
  };

export const saveProof =
  (date: string, block: Pick<PlanBlock, 'id' | 'category'>, status: ProofStatus, note: string, links: string[], auto: string[]): Op =>
  (d, now) => {
    const id = `${date}:${block.id}`;
    d.proofs[id] = { id, u: now, date, blockId: block.id, category: block.category, status, note, links, auto, at: now };
  };

export const clearProof =
  (date: string, blockId: string): Op =>
  (d, now) => {
    const p = d.proofs[`${date}:${blockId}`];
    if (p) {
      p.del = true;
      p.u = now;
    }
  };

// ---------- wake ----------

export const verifyWake =
  (method: 'qr' | 'code' | 'bypass'): Op =>
  (d, now) => {
    const date = logicalDate(now, d.settings.dayStart);
    const late = Math.max(0, Math.floor(offsetOf(now, date, d.settings.dayStart)));
    d.wake[date] = { id: date, u: now, verifiedAt: now, method, lateMin: late };
  };

/** First run: do not ring for a morning that already passed before the app was installed. */
export const bypassWake =
  (date: string): Op =>
  (d, now) => {
    d.wake[date] = { id: date, u: now, verifiedAt: now, method: 'bypass', lateMin: 0 };
  };

// ---------- outcomes & missions ----------

export const setOutcomes =
  (date: string, outcomes: Outcome[]): Op =>
  (d, now) => {
    ensurePlan(d, date, now).outcomes = outcomes.slice(0, 3);
  };

export const toggleOutcome =
  (date: string, id: string): Op =>
  (d, now) => {
    const p = ensurePlan(d, date, now);
    p.outcomes = p.outcomes.map((o) => (o.id === id ? { ...o, done: !o.done } : o));
  };

export const setMission =
  (date: string, blockId: string, mission: Mission | null): Op =>
  (d, now) => {
    const p = ensurePlan(d, date, now);
    if (mission) p.missions[blockId] = mission;
    else delete p.missions[blockId];
  };

export const setPlanMeta =
  (date: string, patch: Partial<Pick<DayPlan, 'plannedBy' | 'guardPausedUntil' | 'dismissedRescueAt'>>): Op =>
  (d, now) => {
    Object.assign(ensurePlan(d, date, now), patch);
  };

export const dismissRescue =
  (date: string): Op =>
  (d, now) => {
    ensurePlan(d, date, now).dismissedRescueAt = now;
  };

export const pauseGuard =
  (date: string, minutes: number): Op =>
  (d, now) => {
    ensurePlan(d, date, now).guardPausedUntil = now + minutes * 60_000;
  };

export const toggleStep =
  (date: string, block: Pick<PlanBlock, 'id' | 'origin'>, stepId: string): Op =>
  (d, now) => {
    const p = ensurePlan(d, date, now);
    const key = p.missions[block.id] ? block.id : block.origin && p.missions[block.origin] ? block.origin : null;
    if (!key) return;
    const m = p.missions[key];
    p.missions[key] = { ...m, steps: m.steps.map((s) => (s.id === stepId ? { ...s, done: !s.done } : s)) };
  };

// ---------- plan editing ----------

/** Insert a block into a day, cutting whatever flexible blocks it overlaps. Both halves keep the origin, so missions follow. */
export function carve(blocks: PlanBlock[], nb: PlanBlock): PlanBlock[] {
  const out: PlanBlock[] = [];
  const ids = new Set(blocks.map((b) => b.id));
  const fresh = (base: string) => {
    let n = 2;
    while (ids.has(`${base}~${n}`)) n++;
    const id = `${base}~${n}`;
    ids.add(id);
    return id;
  };
  for (const b of blocks) {
    if (b.missed || b.e <= nb.s || b.s >= nb.e) {
      out.push(b);
      continue;
    }
    if (b.s < nb.s) out.push({ ...b, e: nb.s });
    if (b.e > nb.e) out.push({ ...b, id: b.s < nb.s ? fresh(b.id) : b.id, origin: b.origin ?? b.id, s: nb.e });
  }
  out.push(nb);
  return out.sort((a, b) => a.s - b.s);
}

const CATEGORY_PRIORITY: Record<Category, number> = { sleep: 1, devotion: 1, iit: 1, founder: 3, meal: 2, care: 3, rest: 5, buffer: 5, entertainment: 2 };

const clockText = (d: Doc, off: number) => {
  const c = (((d.settings.dayStart + off) % 1440) + 1440) % 1440;
  return `${String(Math.floor(c / 60)).padStart(2, '0')}:${String(c % 60).padStart(2, '0')}`;
};

function checkSpan(s: number, e: number) {
  if (!Number.isInteger(s) || !Number.isInteger(e) || s % 5 || e % 5) throw new OpError('not_aligned', 'Start and end must be on 5-minute marks.');
  if (s < 0 || e > 1440 || s >= e) throw new OpError('bad_range', 'The block must start before it ends, inside the day.');
}

/** The template's fixed value for a block (looked up by origin); undefined for blocks that did not come from the template. */
function templateFixed(d: Doc, b: PlanBlock): boolean | undefined {
  return d.template.blocks.find((x) => x.id === (b.origin ?? b.id))?.fixed;
}

/** A master-clock anchor (sleep, aarti): fixed, but not by a pin. Edited only in the Clock screen. */
export const isAnchor = (d: Doc, b: PlanBlock) => b.fixed && !b.pinned && !b.exception && templateFixed(d, b) === true;

function overlapFixed(blocks: PlanBlock[], s: number, e: number, ignore?: string): PlanBlock | undefined {
  return blocks.find((b) => !b.missed && b.id !== ignore && b.fixed && b.s < e && b.e > s);
}

/** Pin (or unpin) a block to its clock time for this day. Pinned implies fixed: Rescue never moves it. */
export const pinBlock =
  (date: string, blockId: string, pinned: boolean): Op =>
  (d, now) => {
    const p = ensurePlan(d, date, now);
    const b = p.blocks.find((x) => x.id === blockId);
    if (!b) throw new OpError('no_block', `Block ${blockId} does not exist on ${date}.`);
    if (b.missed) throw new OpError('missed', 'A missed block cannot be pinned.');
    if (b.category === 'buffer') throw new OpError('buffer', 'Buffer time cannot be pinned — add a block instead.');
    if (pinned === !!b.pinned) return;
    if (pinned) {
      if (isAnchor(d, b)) throw new OpError('anchor', `"${b.title}" is an anchor — it is already fixed. Edit it in the Clock screen.`);
      p.blocks = p.blocks.map((x) => (x.id === blockId ? { ...x, pinned: true, fixed: true } : x));
    } else {
      p.blocks = p.blocks.map((x) => {
        if (x.id !== blockId) return x;
        const { pinned: _drop, ...rest } = x;
        return { ...rest, fixed: templateFixed(d, x) ?? !!x.exception };
      });
    }
  };

export interface NewDayBlock {
  title: string;
  category: Category;
  start: number; // offset from the logical day start
  end: number;
  pinned?: boolean; // default true
  focus?: boolean;
  mission?: Mission;
  source?: PlanBlock['source'];
  exception?: boolean; // planned entertainment (the v1 "planned exception")
}

/** Put a specific thing at a specific time. Refuses to overlap any fixed block; cuts flexible ones. */
export const addDayBlock =
  (date: string, nb: NewDayBlock): Op<string> =>
  (d, now) => {
    checkSpan(nb.start, nb.end);
    const title = nb.title.trim().slice(0, 120);
    if (!title) throw new OpError('no_title', 'Give the block a name.');
    const p = ensurePlan(d, date, now);
    const clash = overlapFixed(p.blocks, nb.start, nb.end);
    if (clash) {
      const what = clash.pinned ? 'pinned block' : clash.exception ? 'planned block' : 'anchor';
      throw new OpError('overlap_fixed', `That overlaps the ${what} "${clash.title}" (${clockText(d, clash.s)}–${clockText(d, clash.e)}). Pick another time.`);
    }
    const pinned = nb.exception ? false : (nb.pinned ?? true);
    const len = nb.end - nb.start;
    const def = d.template.blocks.find((x) => x.category === nb.category);
    const block: PlanBlock = {
      id: uid(nb.exception ? 'x' : 'u', now),
      title,
      category: nb.category,
      s: nb.start,
      e: nb.end,
      fixed: pinned || !!nb.exception,
      focus: nb.focus ?? (nb.category === 'iit' || nb.category === 'founder'),
      minMinutes: pinned || nb.exception ? len : Math.min(len, def?.minMinutes ?? 0),
      priority: nb.exception ? 2 : pinned ? 1 : (def?.priority ?? CATEGORY_PRIORITY[nb.category]),
      ...(nb.exception ? { exception: true } : {}),
      ...(pinned ? { pinned: true } : {}),
      source: nb.source ?? 'user',
    };
    p.blocks = carve(p.blocks, block);
    if (nb.mission) p.missions[block.id] = nb.mission;
    return block.id;
  };

/** Move a flexible block to a new time. The time it leaves becomes Buffer. */
export const moveDayBlock =
  (date: string, blockId: string, start: number, end: number): Op =>
  (d, now) => {
    checkSpan(start, end);
    const p = ensurePlan(d, date, now);
    const b = p.blocks.find((x) => x.id === blockId && !x.missed);
    if (!b) throw new OpError('no_block', `Block ${blockId} does not exist on ${date}.`);
    if (b.fixed) throw new OpError('fixed', `"${b.title}" is ${b.pinned ? 'pinned' : 'fixed'} — unpin it first.`);
    const clash = overlapFixed(p.blocks, start, end, blockId);
    if (clash) throw new OpError('overlap_fixed', `That overlaps "${clash.title}" (${clockText(d, clash.s)}–${clockText(d, clash.e)}), which is fixed.`);
    const vacated: PlanBlock = { id: uid('buf', now), title: 'Buffer', category: 'buffer', s: b.s, e: b.e, fixed: false, focus: false, minMinutes: 0, priority: 5 };
    const rest = p.blocks.map((x) => (x.id === blockId ? vacated : x));
    p.blocks = carve(rest, { ...b, s: start, e: end, minMinutes: Math.min(b.minMinutes, end - start) });
  };


/** A planned exception (e.g. a movie): a fixed entertainment block. Snaps to 5-minute marks. */
export const addException =
  (date: string, s: number, e: number, title: string, category: Category = 'entertainment'): Op<string> =>
  (d, now) => {
    const start = Math.max(0, Math.floor(s / 5) * 5);
    const end = Math.min(1440, Math.max(start + 5, Math.ceil(e / 5) * 5));
    return addDayBlock(date, { title: title || 'Entertainment', category, start, end, focus: false, exception: true, source: 'user' })(d, now);
  };

export const removeException =
  (date: string, blockId: string): Op =>
  (d, now) => {
    const p = ensurePlan(d, date, now);
    p.blocks = p.blocks.map((b) =>
      b.id === blockId ? { ...b, title: 'Buffer', category: 'buffer', exception: false, fixed: false, minMinutes: 0, priority: 5 } : b,
    );
  };

export const resetDayToTemplate =
  (date: string): Op =>
  (d, now) => {
    const p = ensurePlan(d, date, now);
    p.blocks = blocksFromTemplate(d.template.blocks, d.settings.dayStart);
    delete p.rescue;
    delete p.dismissedRescueAt;
  };

export interface RescueMeta {
  scope?: 'today' | 'week';
  reason?: RescueReason;
}

function writeRescue(d: Doc, date: string, result: RescueResult, now: number, meta: RescueMeta, toInbox: (b: PlanBlock) => boolean) {
  const p = ensurePlan(d, date, now);
  // Pins are never moved: refuse a result built before the user pinned something.
  for (const pin of p.blocks.filter((b) => b.pinned && !b.missed)) {
    const out = result.blocks.find((b) => b.id === pin.id);
    if (!out || out.s !== pin.s || out.e !== pin.e) throw new OpError('stale', `"${pin.title}" was pinned after this rescue was built. Open Rescue again.`);
  }
  p.blocks = result.blocks;
  const info: RescueInfo = { at: now, summary: result.summary };
  if (result.strategy) info.strategy = result.strategy;
  if (meta.scope) info.scope = meta.scope;
  if (meta.reason) info.reason = meta.reason;
  p.rescue = info;
  p.rescues = [...(p.rescues ?? []), info].slice(-20);
  for (const [blockId, m] of Object.entries(result.missions ?? {})) p.missions[blockId] = m;
  // Missions of focus blocks that no longer fit become tasks, so nothing silently disappears.
  for (const b of result.dropped) {
    if (!b.focus || !toInbox(b)) continue;
    const m = missionFor(p, b);
    if (!m) continue;
    const id = uid('t', now);
    d.tasks[id] = { id, u: now, title: m.title, area: areaOf(b.category), priority: 2, done: false, carried: true, createdAt: now, estimate: m.estimate };
  }
}

export const applyRescue =
  (date: string, result: RescueResult, meta: RescueMeta = {}): Op =>
  (d, now) => {
    writeRescue(d, date, result, now, { scope: 'today', ...meta }, () => true);
  };

/** Apply today's rescue and move today's dropped missions into this week's matching focus blocks. */
export const applyWeekRescue =
  (week: WeekRescueResult, meta: RescueMeta = {}): Op =>
  (d, now) => {
    const inbox = new Set(week.toInbox.map((x) => x.blockId));
    writeRescue(d, week.date, week.today, now, { ...meta, scope: 'week' }, (b) => inbox.has(b.id));
    for (const day of week.days) {
      const p = ensurePlan(d, day.date, now);
      for (const line of day.lines) {
        const m = day.missions[line.blockId];
        if (!m || !p.blocks.some((b) => b.id === line.blockId) || p.missions[line.blockId]) continue; // never overwrite a mission set meanwhile
        p.missions[line.blockId] = m;
      }
    }
  };


// ---------- tasks ----------

export type NewTask = Pick<Task, 'title' | 'area'> & Partial<Task>;

export const addTask =
  (t: NewTask): Op<string> =>
  (d, now) => {
    const id = uid('t', now);
    d.tasks[id] = { priority: 2, done: false, ...t, id, u: now, createdAt: now } as Task;
    return id;
  };

export const updateTask =
  (id: string, patch: Partial<Task>): Op =>
  (d, now) => {
    const t = d.tasks[id];
    if (!t) return;
    d.tasks[id] = { ...t, ...patch, u: now, doneAt: patch.done ? now : patch.done === false ? undefined : t.doneAt };
  };

export const deleteTask =
  (id: string): Op =>
  (d, now) => {
    const t = d.tasks[id];
    if (t) d.tasks[id] = { ...t, del: true, u: now };
  };

// ---------- rules ----------

export const saveRule =
  (rule: Omit<Rule, 'u' | 'createdAt'> & { createdAt?: number }): Op =>
  (d, now) => {
    d.rules[rule.id] = { ...rule, createdAt: rule.createdAt ?? now, u: now };
  };

export const deleteRule =
  (id: string): Op =>
  (d, now) => {
    const r = d.rules[id];
    if (r) d.rules[id] = { ...r, del: true, u: now };
  };

// ---------- distraction & later ----------

export const logDistraction =
  (minutes: number, source: string, kind: 'unplanned' | 'urge_resisted' = 'unplanned', note?: string): Op<string> =>
  (d, now) => {
    const id = uid('d', now);
    d.distractions[id] = { id, u: now, date: logicalDate(now, d.settings.dayStart), at: now, minutes, source, kind, ...(note ? { note } : {}) };
    return id;
  };

export const addLater =
  (text: string, url?: string): Op<string> =>
  (d, now) => {
    const id = uid('l', now);
    d.later[id] = { id, u: now, text, ...(url ? { url } : {}), at: now, done: false };
    return id;
  };

export const toggleLater =
  (id: string): Op =>
  (d, now) => {
    const l = d.later[id];
    if (l) d.later[id] = { ...l, done: !l.done, u: now };
  };

export const deleteLater =
  (id: string): Op =>
  (d, now) => {
    const l = d.later[id];
    if (l) d.later[id] = { ...l, del: true, u: now };
  };

// ---------- settings / template / review ----------

export const updateSettings =
  (patch: Partial<Settings>): Op =>
  (d, now) => {
    d.settings = { ...d.settings, ...patch, u: now };
  };

/** Switch one feature flag, based on the flags as they are at write time (never a stale copy). */
export const setFeature =
  (key: FeatureKey, on: boolean): Op =>
  (d, now) => {
    d.settings = { ...d.settings, features: { ...(d.settings.features ?? {}), [key]: on }, u: now };
  };

export const saveTemplate =
  (blocks: BlockDef[]): Op =>
  (d, now) => {
    d.template = { id: 'template', u: now, blocks };
  };

export const saveReview =
  (review: Omit<Review, 'u'>): Op =>
  (d, now) => {
    d.reviews[review.id] = { ...review, u: now };
  };

// ---------- data ----------

/** Restore a backup: imported records win (re-stamped as newest) and propagate to every device. */
export const importDoc =
  (incoming: Doc): Op =>
  (d, now) => {
    const copy = structuredClone(incoming);
    copy.settings.u = now;
    copy.template.u = now;
    for (const key of COLLECTIONS) {
      for (const r of Object.values((copy[key] ?? {}) as Record<string, Synced>)) r.u = now;
    }
    Object.assign(d, mergeDocs(d, copy));
  };

/** Clear tracked history but keep settings, template, rules and tasks. */
export const clearHistory = (): Op => (d, now) => {
  for (const key of ['days', 'sessions', 'proofs', 'wake', 'distractions', 'reviews', 'proposals'] as const) {
    for (const r of Object.values(d[key] as Record<string, Synced>)) {
      r.del = true;
      r.u = now;
    }
  }
};

export const resetEverything = (): Op => (d, now) => {
  const fresh = emptyDoc(now);
  for (const key of COLLECTIONS) {
    for (const r of Object.values(d[key] as Record<string, Synced>)) {
      r.del = true;
      r.u = now;
    }
  }
  d.settings = { ...defaultSettings(now), onboarded: false };
  d.template = fresh.template;
  for (const r of Object.values(fresh.rules)) d.rules[r.id] = r;
};
