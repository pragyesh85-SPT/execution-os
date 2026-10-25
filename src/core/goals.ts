import { liveBlocks, minutesForBlock, missionFor, planFor, proofFor, creditedMinutes } from './engine';
import { OpError, uid, type Op } from './ops';
import type { Area, Doc, Goal, GoalLevel, GoalMetric } from './types';
import { addDays, dateKey, dayStartMs, logicalDate, parseKey, weekKey } from './time';

// Targets: year → month → week → day, with roll-up and an honest pace.
// Everything here is pure and deterministic; the UI and the AI connector only display it.

export interface GoalProgress {
  id: string;
  actual: number;
  target: number;
  pct: number; // 0..1+ (capped at 1 for display)
  expectedPct: number; // where you should be by now
  pace: 'ahead' | 'on_track' | 'behind' | 'at_risk' | 'done';
  children?: GoalProgress[];
}

// ---------- periods ----------

const pad = (n: number) => String(n).padStart(2, '0');

/** First and last logical date of a goal period (inclusive). */
export function periodRange(level: GoalLevel, period: string): [string, string] {
  if (level === 'year') return [`${period}-01-01`, `${period}-12-31`];
  if (level === 'month') {
    const [y, m] = period.split('-').map(Number);
    const last = new Date(y, m, 0).getDate();
    return [`${period}-01`, `${period}-${pad(last)}`];
  }
  if (level === 'week') return [weekKey(period), addDays(weekKey(period), 6)];
  return [period, period];
}

/** The period key containing a date, at a level. */
export function periodOf(level: GoalLevel, date: string): string {
  if (level === 'year') return date.slice(0, 4);
  if (level === 'month') return date.slice(0, 7);
  if (level === 'week') return weekKey(date);
  return date;
}

export const childLevel: Record<GoalLevel, GoalLevel | null> = { year: 'month', month: 'week', week: 'day', day: null };

function datesIn(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < 400; d = addDays(d, 1)) out.push(d);
  return out;
}

// ---------- actuals ----------

const active = (doc: Doc) => Object.values(doc.goals ?? {}).filter((g) => !g.del && g.status !== 'dropped');
export const childrenOf = (doc: Doc, g: Goal) => active(doc).filter((c) => c.parentId === g.id).sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);

const checkinSum = (g: Goal) => (g.checkins ?? []).reduce((a, c) => a + (Number(c.value) || 0), 0);

/** Minutes credited to a goal's linked missions (tracked time, or the block when marked done without a timer). */
function linkedMinutes(doc: Doc, goalId: string, dates: string[], nowMs: number): { minutes: number; linked: boolean } {
  let minutes = 0;
  let linked = false;
  for (const date of dates) {
    const plan = doc.days[date];
    if (!plan || plan.del) continue;
    for (const b of liveBlocks(plan)) {
      const m = missionFor(plan, b);
      const proof = proofFor(doc, date, b.id);
      if (m?.goalId !== goalId && proof?.goalId !== goalId) continue;
      linked = true;
      const tracked = minutesForBlock(doc, date, b.id, nowMs);
      let credit = tracked;
      if (tracked < 1 && proof) credit = proof.status === 'done' ? b.e - b.s : proof.status === 'partial' ? (b.e - b.s) * (proof.percent !== undefined ? proof.percent / 100 : 0.5) : 0;
      minutes += credit;
    }
  }
  return { minutes, linked };
}

function countDone(doc: Doc, goalId: string, dates: Set<string>): number {
  let n = 0;
  for (const p of Object.values(doc.proofs)) {
    if (p.del || p.status !== 'done' || !dates.has(p.date)) continue;
    const plan = planFor(doc, p.date);
    const b = plan.blocks.find((x) => x.id === p.blockId);
    const viaMission = b ? missionFor(plan, b)?.goalId : undefined;
    if (p.goalId === goalId || (!p.goalId && viaMission === goalId)) n += p.countDelta ?? 1;
  }
  return n;
}

/** What has been done toward a goal (hours, units, 0/1 or milestones done) — its own data only. */
export function goalActual(doc: Doc, g: Goal, nowMs: number): { actual: number; ownData: boolean } {
  const [from, to] = periodRange(g.level, g.period);
  const today = logicalDate(nowMs, doc.settings.dayStart);
  const dates = datesIn(from, to < today ? to : today);
  const m = g.metric;
  const checkins = checkinSum(g);
  if (m.kind === 'hours') {
    const l = linkedMinutes(doc, g.id, dates, nowMs);
    let minutes = l.minutes;
    let own = l.linked || !!g.checkins?.length;
    if (!l.linked && m.categories?.length) {
      for (const d of dates) for (const c of m.categories) minutes += creditedMinutes(doc, d, c, nowMs);
      own = true;
    }
    return { actual: minutes / 60 + checkins, ownData: own };
  }
  if (m.kind === 'count') {
    const n = countDone(doc, g.id, new Set(dates));
    return { actual: n + checkins, ownData: n > 0 || !!g.checkins?.length };
  }
  if (m.kind === 'binary') return { actual: g.status === 'done' || checkins >= 1 ? 1 : 0, ownData: g.status === 'done' || !!g.checkins?.length };
  const done = m.items.filter((i) => i.done).length;
  return { actual: done, ownData: m.items.length > 0 };
}

// ---------- expected progress & pace ----------

/** Share of the period elapsed, in logical days (0..1). "workdays" skips Sundays. */
export function expectedShare(doc: Doc, g: Pick<Goal, 'level' | 'period' | 'curve'>, nowMs: number): number {
  const [from, to] = periodRange(g.level, g.period);
  const ds = doc.settings.dayStart;
  if (g.curve === 'workdays') {
    const all = datesIn(from, to).filter((d) => parseKey(d).getDay() !== 0);
    if (!all.length) return 1;
    let elapsed = 0;
    for (const d of all) {
      const s = dayStartMs(d, ds);
      const e = dayStartMs(addDays(d, 1), ds);
      elapsed += Math.max(0, Math.min(1, (nowMs - s) / (e - s)));
    }
    return elapsed / all.length;
  }
  const start = dayStartMs(from, ds);
  const end = dayStartMs(addDays(to, 1), ds);
  return Math.max(0, Math.min(1, (nowMs - start) / (end - start)));
}

export function paceOf(pct: number, expected: number): GoalProgress['pace'] {
  if (pct >= 1) return 'done';
  if (pct >= expected + 0.1) return 'ahead';
  if (pct >= expected - 0.05) return 'on_track';
  if (pct >= expected - 0.2) return 'behind';
  return 'at_risk';
}

const unitKey = (m: GoalMetric) => (m.kind === 'count' ? `count:${m.unit}` : m.kind);

/** Progress of a goal and its children. A goal with children and no data of its own rolls them up. */
export function goalProgress(doc: Doc, g: Goal, nowMs: number, depth = 0): GoalProgress {
  const kids = depth < 4 ? childrenOf(doc, g).map((c) => goalProgress(doc, c, nowMs, depth + 1)) : [];
  const own = goalActual(doc, g, nowMs);
  const target = g.metric.kind === 'binary' ? 1 : g.metric.kind === 'milestones' ? g.metric.items.length : g.target;
  let pct: number;
  let actual = own.actual;
  if (kids.length && !own.ownData) {
    const kidGoals = childrenOf(doc, g);
    const sameUnit = new Set(kidGoals.map((k) => unitKey(k.metric))).size === 1;
    const weights = kids.map((k) => (sameUnit ? Math.max(0, k.target) : 1));
    const total = weights.reduce((a, b) => a + b, 0) || 1;
    pct = kids.reduce((a, k, i) => a + Math.min(1, k.pct) * weights[i], 0) / total;
    actual = pct * target;
  } else {
    pct = target > 0 ? actual / target : actual > 0 ? 1 : 0;
  }
  if (g.status === 'done') pct = Math.max(pct, 1);
  const expectedPct = expectedShare(doc, g, nowMs);
  return { id: g.id, actual: Math.round(actual * 100) / 100, target, pct, expectedPct, pace: paceOf(pct, expectedPct), ...(kids.length ? { children: kids } : {}) };
}

export function goalsFor(doc: Doc, level?: GoalLevel, period?: string): Goal[] {
  return active(doc)
    .filter((g) => (!level || g.level === level) && (!period || g.period === period))
    .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
}

/** "This week: 62% of targets (expected 57%) — on track" — the line on Now. */
export function weekPace(doc: Doc, date: string, nowMs: number): { pct: number; expected: number; pace: GoalProgress['pace']; count: number } | null {
  const week = goalsFor(doc, 'week', weekKey(date)).filter((g) => g.status === 'active' || g.status === 'done');
  if (!week.length) return null;
  const ps = week.map((g) => goalProgress(doc, g, nowMs));
  const pct = ps.reduce((a, p) => a + Math.min(1, p.pct), 0) / ps.length;
  const expected = ps.reduce((a, p) => a + p.expectedPct, 0) / ps.length;
  return { pct, expected, pace: paceOf(pct, expected), count: ps.length };
}

/** Active goals the user can link a mission or task to on a date (this week's and this month's). */
export function linkableGoals(doc: Doc, date: string): Goal[] {
  return active(doc).filter((g) => g.status === 'active' && ((g.level === 'week' && g.period === weekKey(date)) || (g.level === 'month' && g.period === date.slice(0, 7)) || (g.level === 'day' && g.period === date)));
}

// ---------- breakdown (no AI) ----------

export interface GoalDraft {
  level: GoalLevel;
  period: string;
  parentId: string;
  title: string;
  area: Area;
  metric: GoalMetric;
  target: number;
}

/** Split a parent evenly across its remaining months / weeks / days. Milestone goals are not split. */
export function suggestBreakdown(doc: Doc, g: Goal, nowMs: number): GoalDraft[] {
  const level = childLevel[g.level];
  if (!level || g.metric.kind === 'milestones') return [];
  const today = logicalDate(nowMs, doc.settings.dayStart);
  const [from, to] = periodRange(g.level, g.period);
  const start = today > from ? today : from;
  const periods: string[] = [];
  for (let d = start; d <= to; d = addDays(d, 1)) {
    const p = periodOf(level, d);
    if (!periods.includes(p)) periods.push(p);
    if (periods.length > 60) break;
  }
  const existing = new Set(childrenOf(doc, g).map((c) => c.period));
  const open = periods.filter((p) => !existing.has(p));
  if (!open.length) return [];
  const remaining = Math.max(0, g.target - goalActual(doc, g, nowMs).actual);
  const each = g.metric.kind === 'hours' ? Math.max(0.5, Math.round((remaining / open.length) * 2) / 2) : g.metric.kind === 'binary' ? 1 : Math.max(1, Math.round(remaining / open.length));
  const label = (p: string) => (level === 'month' ? p : level === 'week' ? `week of ${p}` : p);
  return open.map((p) => ({ level, period: p, parentId: g.id, title: `${g.title} — ${label(p)}`, area: g.area, metric: g.metric.kind === 'hours' ? { ...g.metric } : g.metric.kind === 'count' ? { ...g.metric } : { kind: 'binary' }, target: each }));
}

// ---------- ops ----------

export type GoalInput = Partial<Omit<Goal, 'u' | 'r' | 'del'>> & { title?: string };

function validMetric(m: unknown): m is GoalMetric {
  const x = m as GoalMetric;
  if (!x || typeof x !== 'object') return false;
  if (x.kind === 'hours') return !x.categories || Array.isArray(x.categories);
  if (x.kind === 'count') return typeof x.unit === 'string';
  if (x.kind === 'binary') return true;
  if (x.kind === 'milestones') return Array.isArray(x.items);
  return false;
}

/** Create (no id) or update (id) a goal. Never deletes: dropping sets status "dropped". */
export const upsertGoal =
  (input: GoalInput, source: 'manual' | 'ai' = 'manual'): Op<string> =>
  (d, now) => {
    const prev = input.id ? d.goals[input.id] : undefined;
    if (input.id && (!prev || prev.del)) throw new OpError('no_goal', `Target ${input.id} does not exist; call get_goals.`);
    const level = input.level ?? prev?.level;
    const period = input.period ?? prev?.period;
    const title = (input.title ?? prev?.title ?? '').trim().slice(0, 160);
    const metric = input.metric ?? prev?.metric;
    if (!level || !period || !title || !metric) throw new OpError('incomplete', 'A target needs a level, a period, a title and a metric.');
    if (!validMetric(metric)) throw new OpError('metric', 'Metric must be hours, count (with a unit), binary or milestones.');
    const periodOk = { year: /^\d{4}$/, month: /^\d{4}-\d{2}$/, week: /^\d{4}-\d{2}-\d{2}$/, day: /^\d{4}-\d{2}-\d{2}$/ }[level].test(period);
    if (!periodOk) throw new OpError('period', `Period "${period}" does not match level ${level} (year 2026, month 2026-10, week = its Monday, day 2026-10-24).`);
    if (input.parentId && (!d.goals[input.parentId] || d.goals[input.parentId].del)) throw new OpError('parent', `Parent target ${input.parentId} does not exist.`);
    const items = metric.kind === 'milestones' ? metric.items.map((i) => ({ id: i.id || uid('m', now), text: String(i.text).slice(0, 200), done: !!i.done })) : undefined;
    const target = metric.kind === 'binary' ? 1 : metric.kind === 'milestones' ? items!.length : Math.max(0, Number(input.target ?? prev?.target ?? 0));
    const id = prev?.id ?? uid('g', now);
    const siblings = Object.values(d.goals).filter((x) => !x.del && x.level === level && x.period === period);
    d.goals[id] = {
      ...(prev ?? {}),
      id,
      u: now,
      level,
      period: level === 'week' ? weekKey(period) : period,
      ...(input.parentId !== undefined ? (input.parentId ? { parentId: input.parentId } : {}) : prev?.parentId ? { parentId: prev.parentId } : {}),
      title,
      area: input.area ?? prev?.area ?? 'founder',
      ...(input.why !== undefined ? { why: input.why.slice(0, 500) } : prev?.why ? { why: prev.why } : {}),
      metric: metric.kind === 'milestones' ? { kind: 'milestones', items: items! } : metric,
      target,
      ...(prev?.checkins ? { checkins: prev.checkins } : {}),
      status: input.status ?? prev?.status ?? 'active',
      order: input.order ?? prev?.order ?? siblings.length,
      createdAt: prev?.createdAt ?? now,
      source: prev?.source ?? source,
      ...(input.curve ?? prev?.curve ? { curve: input.curve ?? prev?.curve } : {}),
    } as Goal;
    return id;
  };

export const checkinGoal =
  (id: string, value: number, note?: string): Op =>
  (d, now) => {
    const g = d.goals[id];
    if (!g || g.del) throw new OpError('no_goal', 'That target does not exist.');
    if (!Number.isFinite(value) || value === 0) throw new OpError('value', 'A check-in needs a number.');
    d.goals[id] = { ...g, u: now, checkins: [...(g.checkins ?? []), { at: now, value, ...(note?.trim() ? { note: note.trim().slice(0, 300) } : {}) }] };
  };

export const setGoalStatus =
  (id: string, status: Goal['status']): Op =>
  (d, now) => {
    const g = d.goals[id];
    if (!g || g.del) throw new OpError('no_goal', 'That target does not exist.');
    d.goals[id] = { ...g, status, u: now };
  };

export const toggleMilestone =
  (id: string, itemId: string): Op =>
  (d, now) => {
    const g = d.goals[id];
    if (!g || g.del || g.metric.kind !== 'milestones') throw new OpError('no_goal', 'That target has no milestones.');
    d.goals[id] = { ...g, u: now, metric: { kind: 'milestones', items: g.metric.items.map((i) => (i.id === itemId ? { ...i, done: !i.done } : i)) } };
  };

/** Soft limits that keep the target tree small (the UI warns; nothing is refused). */
export function goalWarnings(doc: Doc, date: string): string[] {
  const out: string[] = [];
  const years = goalsFor(doc, 'year', date.slice(0, 4)).filter((g) => g.status === 'active');
  if (years.length > 5) out.push(`${years.length} active yearly targets — more than 5 rarely all get done.`);
  for (const y of goalsFor(doc, 'year')) {
    const months = childrenOf(doc, y).filter((c) => c.level === 'month' && c.period === date.slice(0, 7));
    if (months.length > 3) out.push(`"${y.title}" has ${months.length} targets this month — keep it to 3.`);
  }
  return out;
}

export { dateKey };
