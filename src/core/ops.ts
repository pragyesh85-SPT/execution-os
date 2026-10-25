import { blocksFromTemplate, missionFor, planFor } from './engine';
import { defaultSettings, emptyDoc } from './defaults';
import { mergeDocs } from './merge';
import type { RescueResult } from './rescue';
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

/** Insert a block into a day, cutting whatever flexible blocks it overlaps. */
export function carve(blocks: PlanBlock[], nb: PlanBlock): PlanBlock[] {
  const out: PlanBlock[] = [];
  for (const b of blocks) {
    if (b.missed || b.e <= nb.s || b.s >= nb.e) {
      out.push(b);
      continue;
    }
    if (b.s < nb.s) out.push({ ...b, e: nb.s });
    if (b.e > nb.e) out.push({ ...b, id: b.s < nb.s ? `${b.id}~2` : b.id, origin: b.origin ?? b.id, s: nb.e });
  }
  out.push(nb);
  return out.sort((a, b) => a.s - b.s);
}

export const addException =
  (date: string, s: number, e: number, title: string, category: Category = 'entertainment'): Op<string> =>
  (d, now) => {
    const p = ensurePlan(d, date, now);
    const nb: PlanBlock = {
      id: uid('x', now),
      title,
      category,
      s,
      e,
      fixed: true,
      focus: false,
      minMinutes: e - s,
      priority: 2,
      exception: true,
    };
    p.blocks = carve(p.blocks, nb);
    return nb.id;
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

export const applyRescue =
  (date: string, result: RescueResult): Op =>
  (d, now) => {
    const p = ensurePlan(d, date, now);
    p.blocks = result.blocks;
    p.rescue = { at: now, summary: result.summary };
    // Missions of focus blocks that no longer fit become tasks, so nothing silently disappears.
    for (const b of result.dropped) {
      if (!b.focus) continue;
      const m = missionFor(p, b);
      if (!m) continue;
      const id = uid('t', now);
      d.tasks[id] = { id, u: now, title: m.title, area: areaOf(b.category), priority: 2, done: false, carried: true, createdAt: now, estimate: m.estimate };
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
  for (const key of ['days', 'sessions', 'proofs', 'wake', 'distractions', 'reviews'] as const) {
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
