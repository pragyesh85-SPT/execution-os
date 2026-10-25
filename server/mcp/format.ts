import { CATEGORY_META } from '../../src/core/defaults';
import { blockAt, dayScore, dayStatus, liveBlocks, minutesForBlock, missionFor, nextBlocks, planFor, proofFor } from '../../src/core/engine';
import { isAnchor } from '../../src/core/ops';
import { isStale, pendingProposals } from '../../src/core/proposals';
import { weekStats } from '../../src/core/stats';
import type { Doc, PlanBlock, Proposal, Task } from '../../src/core/types';
import { addDays, clockOf, fmtClock, logicalDate, offsetFromClock, offsetOf, weekDays, weekKey } from '../../src/core/time';

// Doc → compact, AI-friendly JSON. Dates YYYY-MM-DD (logical date), times HH:MM 24-hour in the
// hub PC's time zone, durations in minutes. Block ids are opaque and must be copied, not invented.

export const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
export const hhmm = (off: number, ds: number) => fmtClock(clockOf(off, ds), true);

const HHMM = /^([01]?\d|2[0-4]):([0-5]\d)$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class InputError extends Error {}

export function checkDate(date: string): string {
  if (!DATE.test(date) || Number.isNaN(new Date(`${date}T00:00:00`).getTime())) throw new InputError(`"${date}" is not a date; use YYYY-MM-DD.`);
  return date;
}

/** "16:00" → offset inside the logical day. An end time equal to the day start means the end of the day (1440). */
export function toOffset(text: string, ds: number, isEnd = false): number {
  const m = HHMM.exec(String(text).trim());
  if (!m) throw new InputError(`"${text}" is not a time; use 24-hour HH:MM.`);
  const clock = (Number(m[1]) * 60 + Number(m[2])) % 1440;
  const off = offsetFromClock(clock, ds);
  return isEnd && off === 0 ? 1440 : off;
}

export function today(doc: Doc, now: number) {
  return logicalDate(now, doc.settings.dayStart);
}

export function blockView(doc: Doc, date: string, b: PlanBlock, now: number) {
  const ds = doc.settings.dayStart;
  const plan = planFor(doc, date);
  const m = missionFor(plan, b);
  const proof = proofFor(doc, date, b.id);
  const tracked = Math.round(minutesForBlock(doc, date, b.id, now));
  return {
    id: b.id,
    start: hhmm(b.s, ds),
    end: hhmm(b.e, ds),
    minutes: b.e - b.s,
    title: b.title,
    category: b.category,
    ...(b.pinned ? { pinned: true } : {}),
    ...(isAnchor(doc, b) ? { anchor: true } : {}),
    fixed: b.fixed,
    focus: b.focus,
    ...(m ? { mission: { title: m.title, steps: m.steps.map((s) => ({ text: s.text, done: s.done })), ...(m.estimate ? { estimate: m.estimate } : {}) } } : {}),
    ...(proof ? { proof: proof.status } : {}),
    ...(tracked ? { trackedMinutes: tracked } : {}),
    ...(b.joinUrl ? { joinUrl: b.joinUrl } : {}),
    ...(b.rescued ? { rescued: true } : {}),
  };
}

export function unloggedFocus(doc: Doc, date: string, now: number) {
  const off = offsetOf(now, date, doc.settings.dayStart);
  return liveBlocks(planFor(doc, date))
    .filter((b) => b.focus && b.e <= off && !proofFor(doc, date, b.id))
    .map((b) => ({ date, id: b.id, title: b.title, start: hhmm(b.s, doc.settings.dayStart), end: hhmm(b.e, doc.settings.dayStart) }));
}

export function overview(doc: Doc, now: number) {
  const ds = doc.settings.dayStart;
  const date = today(doc, now);
  const plan = planFor(doc, date);
  const off = offsetOf(now, date, ds);
  const cur = blockAt(plan, off);
  const st = dayStatus(doc, now);
  const score = dayScore(doc, date, now);
  return {
    now: fmtClock(clockOf(off, ds), true),
    timeZone: timeZone(),
    date,
    dayStart: hhmm(0, ds),
    status: { state: st.state, title: st.title, detail: st.detail, ...(st.reason ? { reason: st.reason } : {}) },
    current: cur ? { ...blockView(doc, date, cur, now), minutesLeft: Math.max(0, Math.round(cur.e - off)) } : null,
    next: nextBlocks(plan, off, 3).map((b) => blockView(doc, date, b, now)),
    outcomes: plan.outcomes.map((o) => ({ text: o.text, area: o.area, done: o.done })),
    dayScore: score.score,
    pendingProposals: pendingProposals(doc).map((p) => ({ id: p.id, kind: p.kind, title: p.title })),
    unloggedFocusBlocks: [...unloggedFocus(doc, addDays(date, -1), now), ...unloggedFocus(doc, date, now)].slice(-6),
  };
}

export function dayView(doc: Doc, date: string, now: number) {
  const plan = planFor(doc, date);
  const ds = doc.settings.dayStart;
  return {
    date,
    timeZone: timeZone(),
    dayStart: hhmm(0, ds),
    saved: !!doc.days[date] && !doc.days[date].del,
    blocks: liveBlocks(plan).map((b) => blockView(doc, date, b, now)),
    outcomes: plan.outcomes.map((o) => ({ text: o.text, area: o.area, done: o.done })),
    rescues: (plan.rescues ?? (plan.rescue ? [plan.rescue] : [])).map((r) => ({ at: new Date(r.at).toISOString(), strategy: r.strategy ?? 'balanced', scope: r.scope ?? 'today', summary: r.summary })),
    plannedBy: plan.plannedBy ?? null,
  };
}

export function weekView(doc: Doc, weekStart: string, now: number) {
  const ws = weekKey(weekStart);
  const stats = weekStats(doc, ws, now);
  const days = weekDays(ws).map((date) => {
    const plan = planFor(doc, date);
    const live = liveBlocks(plan);
    const focus = live.filter((b) => b.focus);
    const per: Record<string, number> = {};
    for (const b of focus) per[b.category] = (per[b.category] ?? 0) + (b.e - b.s);
    const proofs = focus.map((b) => proofFor(doc, date, b.id)?.status).filter(Boolean) as string[];
    return {
      date,
      plannedFocusMinutes: per,
      missions: focus.map((b) => missionFor(plan, b)?.title).filter(Boolean),
      outcomes: plan.outcomes.map((o) => o.text),
      pinned: live.filter((b) => b.pinned).map((b) => `${hhmm(b.s, doc.settings.dayStart)} ${b.title}`),
      logged: { done: proofs.filter((p) => p === 'done').length, partial: proofs.filter((p) => p === 'partial').length, none: proofs.filter((p) => p === 'none').length },
      rescued: !!plan.rescue,
    };
  });
  return { weekStart: ws, timeZone: timeZone(), days, adherenceSoFar: Math.round(stats.adherence * 100) / 100, insights: stats.insights };
}

export function taskView(t: Task) {
  return {
    id: t.id,
    title: t.title,
    area: t.area,
    priority: t.priority,
    ...(t.deadline ? { deadline: t.deadline } : {}),
    ...(t.estimate ? { estimate: t.estimate } : {}),
    ...(t.notes ? { notes: t.notes } : {}),
    done: t.done,
    ...(t.carried ? { carried: true } : {}),
    ...(t.goalId ? { goalId: t.goalId } : {}),
  };
}

export function proposalView(doc: Doc, p: Proposal) {
  const ds = doc.settings.dayStart;
  return {
    id: p.id,
    kind: p.kind,
    status: p.status,
    title: p.title,
    ...(p.rationale ? { rationale: p.rationale } : {}),
    source: p.source,
    ...(p.client ? { client: p.client } : {}),
    scopeAllowed: p.scopeAllowed,
    expires: new Date(p.expiresAt).toISOString(),
    stale: p.status === 'pending' ? isStale(doc, p) : false,
    ...(p.warnings?.length ? { warnings: p.warnings } : {}),
    ...(p.rescue?.strategy ? { strategy: p.rescue.strategy } : {}),
    days: p.days.map((d) => ({
      date: d.date,
      changes: d.lines.filter((l) => l.kind !== 'kept').map((l) => l.reason),
      kept: d.lines.filter((l) => l.kind === 'kept').map((l) => l.title),
      ...(d.outcomes?.length ? { outcomes: d.outcomes.map((o) => o.text) } : {}),
      plan: d.blocks.filter((b) => !b.missed && b.category !== 'buffer').map((b) => `${hhmm(b.s, ds)}–${hhmm(b.e, ds)} ${b.title}${b.pinned ? ' (pinned)' : ''}`),
    })),
    ...(p.tasksToAdd?.length ? { tasksToAdd: p.tasksToAdd.map((t) => t.title) } : {}),
  };
}

export const categoryList = Object.keys(CATEGORY_META);

// ---------- MCP Apps proposal card ----------

export const CARD_URI = 'ui://execution-os/proposal';
export const CARD_MIME = 'text/html;profile=mcp-app';

const cardBlocks = (blocks: PlanBlock[]) =>
  blocks.filter((b) => !b.missed && b.e > b.s).map((b) => ({ t: b.title, c: b.category, s: b.s, e: b.e, ...(b.pinned ? { p: 1 } : {}), ...(b.fixed ? { f: 1 } : {}) }));

/** What the card draws: per proposal, each day's before/after blocks and the reasons. */
export function cardFor(doc: Doc, ids: string[], headlines: Record<string, string> = {}, note?: string) {
  const proposals = ids
    .map((id) => doc.proposals[id])
    .filter((p): p is Proposal => !!p && !p.del)
    .map((p) => ({
      id: p.id,
      title: p.title,
      ...(headlines[p.id] ?? p.rationale ? { headline: headlines[p.id] ?? p.rationale } : {}),
      scopeAllowed: p.scopeAllowed,
      dayStart: doc.settings.dayStart,
      days: p.days.map((d) => ({
        date: d.date,
        label: new Date(`${d.date}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }),
        before: cardBlocks(liveBlocks(planFor(doc, d.date))),
        after: cardBlocks(d.blocks),
        changes: d.lines.filter((l) => l.kind !== 'kept').map((l) => l.reason),
      })),
      ...(p.warnings?.length ? { warnings: p.warnings.slice(0, 6) } : {}),
    }));
  return { proposals, ...(note ? { note } : {}) };
}
