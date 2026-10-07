import { blocksFromTemplate, planFor } from '../core/engine';
import { defaultSettings, emptyDoc } from '../core/defaults';
import { mergeDocs, normalizeDoc } from '../core/merge';
import type { RescueResult } from '../core/rescue';
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
} from '../core/types';
import { logicalDate, offsetOf } from '../core/time';
import { useStore } from './store';

export function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

const up = (fn: (d: Doc, now: number) => void) => useStore.getState().update(fn);

export function today(): string {
  const d = useStore.getState().doc;
  return logicalDate(Date.now(), d.settings.dayStart);
}

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

export function startSession(date: string, block: PlanBlock) {
  up((d, now) => {
    for (const s of Object.values(d.sessions)) {
      if (!s.del && s.end === undefined) {
        s.end = now;
        s.u = now;
      }
    }
    const id = uid('s');
    d.sessions[id] = { id, u: now, date, blockId: block.id, category: block.category, start: now };
  });
}

export function stopSession(at?: number) {
  up((d, now) => {
    for (const s of Object.values(d.sessions)) {
      if (!s.del && s.end === undefined) {
        s.end = Math.max(s.start, at ?? now);
        s.u = now;
      }
    }
  });
}

export function saveProof(date: string, block: PlanBlock, status: ProofStatus, note: string, links: string[], auto: string[]) {
  up((d, now) => {
    const id = `${date}:${block.id}`;
    d.proofs[id] = { id, u: now, date, blockId: block.id, category: block.category, status, note, links, auto, at: now };
  });
}

export function clearProof(date: string, blockId: string) {
  up((d, now) => {
    const p = d.proofs[`${date}:${blockId}`];
    if (p) {
      p.del = true;
      p.u = now;
    }
  });
}

// ---------- wake ----------

export function verifyWake(method: 'qr' | 'code' | 'bypass') {
  up((d, now) => {
    const date = logicalDate(now, d.settings.dayStart);
    const late = Math.max(0, Math.floor(offsetOf(now, date, d.settings.dayStart)));
    d.wake[date] = { id: date, u: now, verifiedAt: now, method, lateMin: late };
  });
}

// ---------- outcomes & missions ----------

export function setOutcomes(date: string, outcomes: Outcome[]) {
  up((d, now) => {
    ensurePlan(d, date, now).outcomes = outcomes.slice(0, 3);
  });
}

export function toggleOutcome(date: string, id: string) {
  up((d, now) => {
    const p = ensurePlan(d, date, now);
    p.outcomes = p.outcomes.map((o) => (o.id === id ? { ...o, done: !o.done } : o));
  });
}

export function setMission(date: string, blockId: string, mission: Mission | null) {
  up((d, now) => {
    const p = ensurePlan(d, date, now);
    if (mission) p.missions[blockId] = mission;
    else delete p.missions[blockId];
  });
}

export function setPlanMeta(date: string, patch: Partial<Pick<DayPlan, 'plannedBy' | 'guardPausedUntil' | 'dismissedRescueAt'>>) {
  up((d, now) => {
    Object.assign(ensurePlan(d, date, now), patch);
  });
}

export function toggleStep(date: string, block: PlanBlock, stepId: string) {
  up((d, now) => {
    const p = ensurePlan(d, date, now);
    const key = p.missions[block.id] ? block.id : block.origin && p.missions[block.origin] ? block.origin : null;
    if (!key) return;
    const m = p.missions[key];
    p.missions[key] = { ...m, steps: m.steps.map((s) => (s.id === stepId ? { ...s, done: !s.done } : s)) };
  });
}

// ---------- plan editing ----------

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

export function addException(date: string, s: number, e: number, title: string, category: Category = 'entertainment') {
  up((d, now) => {
    const p = ensurePlan(d, date, now);
    const nb: PlanBlock = {
      id: uid('x'),
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
  });
}

export function removeException(date: string, blockId: string) {
  up((d, now) => {
    const p = ensurePlan(d, date, now);
    p.blocks = p.blocks.map((b) =>
      b.id === blockId ? { ...b, title: 'Buffer', category: 'buffer', exception: false, fixed: false, minMinutes: 0, priority: 5 } : b,
    );
  });
}

export function resetDayToTemplate(date: string) {
  up((d, now) => {
    const p = ensurePlan(d, date, now);
    p.blocks = blocksFromTemplate(d.template.blocks, d.settings.dayStart);
    delete p.rescue;
    delete p.dismissedRescueAt;
  });
}

export function applyRescue(date: string, result: RescueResult) {
  up((d, now) => {
    const p = ensurePlan(d, date, now);
    p.blocks = result.blocks;
    p.rescue = { at: now, summary: result.summary };
    // Missions of focus blocks that no longer fit become tasks, so nothing silently disappears.
    for (const b of result.dropped) {
      if (!b.focus) continue;
      const m = p.missions[b.id] ?? (b.origin ? p.missions[b.origin] : undefined);
      if (!m) continue;
      const id = uid('t');
      const area: Area = b.category === 'iit' ? 'iit' : b.category === 'founder' ? 'founder' : 'personal';
      d.tasks[id] = { id, u: now, title: m.title, area, priority: 2, done: false, carried: true, createdAt: now, estimate: m.estimate };
    }
  });
}

export function dismissRescue(date: string) {
  setPlanMeta(date, { dismissedRescueAt: Date.now() });
}

export function pauseGuard(date: string, minutes: number) {
  setPlanMeta(date, { guardPausedUntil: Date.now() + minutes * 60_000 });
}

// ---------- tasks ----------

export function addTask(t: Pick<Task, 'title' | 'area'> & Partial<Task>) {
  up((d, now) => {
    const id = uid('t');
    d.tasks[id] = { priority: 2, done: false, ...t, id, u: now, createdAt: now } as Task;
  });
}

export function updateTask(id: string, patch: Partial<Task>) {
  up((d, now) => {
    const t = d.tasks[id];
    if (!t) return;
    d.tasks[id] = { ...t, ...patch, u: now, doneAt: patch.done ? now : patch.done === false ? undefined : t.doneAt };
  });
}

export function deleteTask(id: string) {
  up((d, now) => {
    const t = d.tasks[id];
    if (t) d.tasks[id] = { ...t, del: true, u: now };
  });
}

// ---------- rules ----------

export function saveRule(rule: Omit<Rule, 'u' | 'createdAt'> & { createdAt?: number }) {
  up((d, now) => {
    d.rules[rule.id] = { ...rule, createdAt: rule.createdAt ?? now, u: now };
  });
}

export function deleteRule(id: string) {
  up((d, now) => {
    const r = d.rules[id];
    if (r) d.rules[id] = { ...r, del: true, u: now };
  });
}

// ---------- distraction & later ----------

export function logDistraction(minutes: number, source: string, kind: 'unplanned' | 'urge_resisted' = 'unplanned', note?: string) {
  up((d, now) => {
    const id = uid('d');
    d.distractions[id] = { id, u: now, date: logicalDate(now, d.settings.dayStart), at: now, minutes, source, kind, note };
  });
}

export function addLater(text: string, url?: string) {
  up((d, now) => {
    const id = uid('l');
    d.later[id] = { id, u: now, text, url, at: now, done: false };
  });
}

export function toggleLater(id: string) {
  up((d, now) => {
    const l = d.later[id];
    if (l) d.later[id] = { ...l, done: !l.done, u: now };
  });
}

export function deleteLater(id: string) {
  up((d, now) => {
    const l = d.later[id];
    if (l) d.later[id] = { ...l, del: true, u: now };
  });
}

// ---------- settings / template / review ----------

export function updateSettings(patch: Partial<Settings>) {
  up((d, now) => {
    d.settings = { ...d.settings, ...patch, u: now };
  });
}

export function saveTemplate(blocks: BlockDef[]) {
  up((d, now) => {
    d.template = { id: 'template', u: now, blocks };
  });
}

export function saveReview(review: Omit<Review, 'u'>) {
  up((d, now) => {
    d.reviews[review.id] = { ...review, u: now };
  });
}

// ---------- data ----------

export function exportJson(): string {
  return JSON.stringify({ app: 'execution-os', exportedAt: new Date().toISOString(), doc: useStore.getState().doc }, null, 2);
}

/** Restore a backup: imported records win (re-stamped as newest) and propagate to every device. */
export function importJson(text: string) {
  const parsed = JSON.parse(text) as { doc?: Doc } | Doc;
  const incoming = normalizeDoc('doc' in parsed && parsed.doc ? parsed.doc : (parsed as Doc));
  const now = Date.now();
  incoming.settings.u = now;
  incoming.template.u = now;
  for (const key of COLLECTIONS) {
    for (const r of Object.values(incoming[key] as Record<string, Synced>)) r.u = now;
  }
  useStore.getState().update((d) => {
    const merged = mergeDocs(d, incoming);
    Object.assign(d, merged);
  });
}

/** Clear tracked history but keep settings, template, rules and tasks. */
export function clearHistory() {
  up((d, now) => {
    for (const key of ['days', 'sessions', 'proofs', 'wake', 'distractions', 'reviews'] as const) {
      for (const r of Object.values(d[key] as Record<string, Synced>)) {
        r.del = true;
        r.u = now;
      }
    }
  });
}

export function resetEverything() {
  up((d, now) => {
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
  });
}
