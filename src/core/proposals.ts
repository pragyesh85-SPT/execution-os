import { CATEGORY_META } from './defaults';
import { liveBlocks, missionFor, planFor } from './engine';
import { ensurePlan, isAnchor, OpError, uid, type Op } from './ops';
import { buildRescue, buildWeekRescue, type RescueOptions, type RescueResult, type WeekRescueResult } from './rescue';
import type { Category, Doc, Mission, Outcome, PlanBlock, Proposal, ProposalKind, ProposalTask, ProposedDay, ProposedLine, RescueReason, Task } from './types';
import { addDays, clockOf, dayStartMs, DAY_MIN, fmtClock, fmtDur, offsetOf, shortDate, weekKey } from './time';

// Proposals: structural changes (a rescue, an AI day or week plan, an import) arrive as a
// reviewable proposal. The engine validates every proposal; nothing changes until the user
// applies it for today or for the week. A proposal made against an older version of a day is
// never applied blindly: it is re-checked (rebased) against the latest plan first.

const SNAP = 5;
const snap = (m: number) => Math.round(m / SNAP) * SNAP;
const clamp = (m: number) => Math.max(0, Math.min(DAY_MIN, m));

export interface ValidationResult {
  ok: boolean;
  blocks: PlanBlock[];
  errors: string[];
  warnings: string[];
  lines: ProposedLine[];
}

export interface DraftBlock {
  id?: string;
  title: string;
  category: Category;
  s: number;
  e: number;
  pinned?: boolean;
  focus?: boolean;
  fixed?: boolean;
  missed?: boolean;
  source?: PlanBlock['source'];
  origin?: string;
  joinUrl?: string;
  location?: string;
  externalId?: string;
  reminderMin?: number;
  goalId?: string;
}

function buffer(s: number, e: number): PlanBlock {
  return { id: `buf-${s}`, title: 'Buffer', category: 'buffer', s, e, fixed: false, focus: false, minMinutes: 0, priority: 5 };
}

/**
 * Make a proposed day safe. Snaps to 5 minutes and clamps to the day; restores every template
 * anchor the proposal moved or removed (AI may never move sleep or devotion anchors); rejects a
 * proposal that moves or overlaps an existing pin; rejects overlaps between proposed blocks;
 * fills gaps with Buffer; reports protected-minimum shortfalls as warnings.
 * `from` (an offset): blocks of the current plan that ended before it are history and kept as they are.
 */
export function validateDayBlocks(doc: Doc, date: string, proposed: DraftBlock[], opts: { from?: number; kind?: ProposalKind } = {}): ValidationResult {
  const ds = doc.settings.dayStart;
  const clock = (o: number) => fmtClock(clockOf(o, ds), true);
  const current = planFor(doc, date);
  const from = clamp(snap(opts.from ?? 0));
  const errors: string[] = [];
  const warnings: string[] = [];
  const lines: ProposedLine[] = [];
  const history = current.blocks.filter((b) => b.e <= from || b.missed);
  const anchors = liveBlocks(current).filter((b) => b.e > from && isAnchor(doc, b));
  const pins = liveBlocks(current).filter((b) => b.e > from && b.pinned);
  const anchorKeys = new Set(anchors.flatMap((a) => [a.id, a.origin ?? a.id]));
  const pinById = new Map(pins.map((p) => [p.id, p]));

  const out: PlanBlock[] = [];
  for (const raw of proposed) {
    if (raw.missed) continue;
    let s = clamp(snap(Number(raw.s)));
    const e = clamp(snap(Number(raw.e)));
    if (!(e > s)) {
      errors.push(`"${raw.title}" has no duration after snapping to 5 minutes.`);
      continue;
    }
    if (e <= from) continue; // the past is not re-planned
    if (s < from) s = from;
    // Anchors come back from the master clock, wherever the proposal put them.
    if (raw.id && anchorKeys.has(raw.id)) continue;
    const sameAnchor = anchors.find((a) => (raw.category === 'sleep' || raw.category === 'devotion') && a.category === raw.category && a.s < e && a.e > s);
    if (sameAnchor) {
      if (sameAnchor.s !== s || sameAnchor.e !== e) warnings.push(`"${sameAnchor.title}" stays at ${clock(sameAnchor.s)}–${clock(sameAnchor.e)} — anchors are fixed and were restored.`);
      continue;
    }
    const existingPin = raw.id ? pinById.get(raw.id) : undefined;
    if (existingPin && (existingPin.s !== s || existingPin.e !== e)) {
      errors.push(`"${existingPin.title}" is pinned at ${clock(existingPin.s)}–${clock(existingPin.e)}; a proposal cannot move it.`);
      continue;
    }
    if (existingPin) continue; // re-added below, untouched
    const def = doc.template.blocks.find((x) => x.id === raw.id) ?? doc.template.blocks.find((x) => x.category === raw.category);
    const prev = raw.id ? current.blocks.find((b) => b.id === raw.id) : undefined;
    const block: PlanBlock = {
      ...(prev ?? {}),
      id: raw.id && !out.some((o) => o.id === raw.id) ? raw.id : uid('p', 0, Math.random),
      title: String(raw.title).slice(0, 120) || CATEGORY_META[raw.category].label,
      category: raw.category,
      s,
      e,
      fixed: !!raw.pinned || (prev?.fixed ?? false),
      focus: raw.focus ?? prev?.focus ?? def?.focus ?? (raw.category === 'iit' || raw.category === 'founder'),
      minMinutes: Math.min(e - s, prev?.minMinutes ?? def?.minMinutes ?? 0),
      priority: raw.pinned ? 1 : (prev?.priority ?? def?.priority ?? 3),
      ...(raw.pinned ? { pinned: true } : {}),
      ...(raw.source ? { source: raw.source } : prev?.source ? { source: prev.source } : {}),
      ...(typeof raw.origin === 'string' ? { origin: raw.origin } : {}),
    };
    for (const k of ['joinUrl', 'location', 'externalId', 'reminderMin', 'goalId'] as const) if (raw[k] !== undefined) (block as unknown as Record<string, unknown>)[k] = raw[k];
    if (!raw.pinned && prev?.pinned) delete block.pinned;
    const pinHit = pins.find((p) => p.s < e && p.e > s);
    if (pinHit) {
      errors.push(`"${block.title}" (${clock(s)}–${clock(e)}) overlaps the pinned block "${pinHit.title}" (${clock(pinHit.s)}–${clock(pinHit.e)}).`);
      continue;
    }
    // Trim flexible proposals around anchors instead of failing: anchors always win.
    let pieces: [number, number][] = [[s, e]];
    for (const a of anchors) {
      pieces = pieces.flatMap(([ps, pe]) => {
        if (a.e <= ps || a.s >= pe) return [[ps, pe] as [number, number]];
        const parts: [number, number][] = [];
        if (a.s > ps) parts.push([ps, a.s]);
        if (a.e < pe) parts.push([a.e, pe]);
        return parts;
      });
    }
    if (pieces.length !== 1 || pieces[0][0] !== s || pieces[0][1] !== e) {
      warnings.push(`"${block.title}" overlapped a fixed anchor and was trimmed to fit around it.`);
      if (block.pinned) {
        errors.push(`"${block.title}" cannot be pinned over an anchor.`);
        continue;
      }
    }
    pieces.filter(([ps, pe]) => pe - ps >= SNAP).forEach(([ps, pe], i) => out.push({ ...block, id: i === 0 ? block.id : `${block.id}~${i + 1}`, origin: i === 0 ? block.origin : (block.origin ?? block.id), s: ps, e: pe, minMinutes: Math.min(block.minMinutes, pe - ps) }));
  }

  // Overlaps between proposed blocks are an error the proposer must fix.
  const sorted = [...out].sort((a, b) => a.s - b.s);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].s < sorted[i - 1].e) errors.push(`"${sorted[i - 1].title}" and "${sorted[i].title}" overlap at ${clock(sorted[i].s)}.`);
  }

  const fixedNow = [...anchors, ...pins];
  const body = [...fixedNow, ...out].sort((a, b) => a.s - b.s);
  const filled: PlanBlock[] = [];
  let c = from;
  for (const b of body) {
    if (b.s - c >= SNAP) filled.push(buffer(c, b.s));
    filled.push(b);
    c = Math.max(c, b.e);
  }
  if (DAY_MIN - c >= SNAP) filled.push(buffer(c, DAY_MIN));
  const blocks = [...history, ...filled].sort((a, b) => a.s - b.s || (a.missed ? -1 : 1));

  // Protected minimums: a warning, not a refusal.
  for (const [cat, min] of Object.entries(doc.settings.protect) as [Category, number][]) {
    if (!min) continue;
    const planned = blocks.filter((b) => !b.missed && b.category === cat).reduce((a, b) => a + (b.e - b.s), 0);
    if (planned < min - 5) warnings.push(`${CATEGORY_META[cat].label} has ${fmtDur(planned)} planned, under its protected ${fmtDur(min)}.`);
  }

  // Human-readable diff against the current plan.
  const before = new Map(liveBlocks(current).map((b) => [b.id, b]));
  for (const b of out) {
    const old = before.get(b.id);
    if (!old) lines.push({ kind: 'added', blockId: b.id, title: b.title, to: [b.s, b.e], reason: `Add "${b.title}" ${clock(b.s)}–${clock(b.e)}${b.pinned ? ', pinned' : ''}.` });
    else if (old.s !== b.s || old.e !== b.e) lines.push({ kind: 'moved', blockId: b.id, title: b.title, from: [old.s, old.e], to: [b.s, b.e], reason: `Move "${b.title}" ${clock(old.s)}–${clock(old.e)} → ${clock(b.s)}–${clock(b.e)}.` });
  }
  const kept = new Set(blocks.map((b) => b.id));
  for (const old of liveBlocks(current)) {
    if (old.e <= from || kept.has(old.id) || old.category === 'buffer') continue;
    lines.push({ kind: 'dropped', blockId: old.id, title: old.title, from: [old.s, old.e], reason: `Remove "${old.title}" (${clock(old.s)}–${clock(old.e)}) from this day.` });
  }
  for (const p of pins) lines.unshift({ kind: 'kept', blockId: p.id, title: p.title, from: [p.s, p.e], to: [p.s, p.e], reason: `Keep "${p.title}" ${clock(p.s)}–${clock(p.e)} — pinned.` });

  return { ok: errors.length === 0, blocks, errors, warnings, lines };
}

// ---------- creating ----------

const endOfDay = (doc: Doc, date: string) => dayStartMs(addDays(date, 1), doc.settings.dayStart);
const endOfWeek = (doc: Doc, date: string) => dayStartMs(addDays(weekKey(date), 7), doc.settings.dayStart);

function bases(doc: Doc, dates: string[]) {
  const baseRevs: Record<string, number> = {};
  const baseU: Record<string, number> = {};
  for (const d of dates) {
    const rec = doc.days[d];
    baseRevs[d] = rec && !rec.del ? (rec.r ?? 0) : 0;
    baseU[d] = rec && !rec.del ? rec.u : 0;
  }
  return { baseRevs, baseU };
}

const areaOf = (c: Category) => (c === 'iit' ? 'iit' : c === 'founder' ? 'founder' : 'personal') as Task['area'];

export interface ProposalInput {
  kind: ProposalKind;
  source: Proposal['source'];
  client?: string;
  title: string;
  rationale?: string;
  date: string;
  days: ProposedDay[];
  scopeAllowed: Proposal['scopeAllowed'];
  tasksToAdd?: ProposalTask[];
  tasksToAddToday?: ProposalTask[];
  rescue?: Proposal['rescue'];
  warnings?: string[];
}

/** Build a proposal record (not yet saved). */
export function makeProposal(doc: Doc, input: ProposalInput, now: number): Proposal {
  const dates = input.days.map((d) => d.date);
  return {
    id: uid('pr', now),
    u: now,
    ...input,
    createdAt: now,
    expiresAt: input.scopeAllowed.includes('week') ? endOfWeek(doc, input.date) : endOfDay(doc, input.date),
    status: 'pending',
    ...bases(doc, dates),
  };
}

/** Turn Rescue v2 output (today, or today + the rest of the week) into a proposal. */
export function makeRescueProposal(doc: Doc, date: string, nowMs: number, result: RescueResult, week: WeekRescueResult | null, meta: { reason?: RescueReason; source?: Proposal['source']; client?: string } = {}): Proposal {
  const plan = planFor(doc, date);
  const today: ProposedDay = { date, blocks: result.blocks, lines: result.lines, ...(result.missions ? { missions: result.missions } : {}) };
  const todayTasks: ProposalTask[] = [];
  for (const b of result.dropped) {
    const m = b.focus ? missionFor(plan, b) : undefined;
    if (m) todayTasks.push({ title: m.title, area: areaOf(b.category), estimate: m.estimate, carried: true, priority: 2 });
  }
  const days: ProposedDay[] = [today];
  if (week) {
    days[0] = { ...today, blocks: week.today.blocks, lines: week.today.lines };
    for (const d of week.days) days.push({ date: d.date, blocks: d.blocks, missions: Object.fromEntries(d.lines.map((l) => [l.blockId, d.missions[l.blockId]])), lines: d.lines });
  }
  return makeProposal(
    doc,
    {
      kind: 'rescue',
      source: meta.source ?? 'engine',
      client: meta.client,
      title: `Rescue plan for ${shortDate(date)}`,
      rationale: result.headline ?? result.summary.find((s) => !s.startsWith('Morning')) ?? undefined,
      date,
      days,
      scopeAllowed: ['today', 'week'],
      tasksToAdd: week ? week.toInbox.map((x) => ({ title: x.title, area: x.area, estimate: x.estimate, carried: true, priority: 2 })) : todayTasks,
      tasksToAddToday: todayTasks,
      rescue: { strategy: result.strategy, reason: meta.reason, summary: result.summary },
    },
    nowMs,
  );
}

// ---------- state ----------

export function pendingProposals(doc: Doc): Proposal[] {
  return Object.values(doc.proposals ?? {})
    .filter((p) => !p.del && p.status === 'pending')
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** Has any day this proposal touches changed since it was made? */
export function isStale(doc: Doc, p: Proposal): boolean {
  for (const d of p.days) {
    const rec = doc.days[d.date];
    const r = rec && !rec.del ? (rec.r ?? 0) : 0;
    const u = rec && !rec.del ? rec.u : 0;
    if ((p.baseRevs[d.date] ?? 0) !== r) return true;
    if (p.baseU && (p.baseU[d.date] ?? 0) !== u) return true;
  }
  return false;
}

/** Save a new proposal; an older pending proposal of the same kind for the same date is superseded. */
export const addProposal =
  (p: Proposal): Op<string> =>
  (d, now) => {
    for (const old of pendingProposals(d)) {
      if (old.kind === p.kind && old.date === p.date && old.id !== p.id && !(p.group && old.group === p.group)) d.proposals[old.id] = { ...old, status: 'superseded', u: now };
    }
    d.proposals[p.id] = { ...p, u: now };
    return p.id;
  };

/**
 * Re-check a stale proposal against the latest plan. A rescue is rebuilt with the same strategy;
 * an AI or import plan keeps only the blocks that still fit and lists what was dropped.
 * The old proposal becomes superseded. Returns the id of the fresh proposal.
 */
export const rebaseProposal =
  (id: string, opts: Pick<RescueOptions, 'slotRates'> = {}): Op<string> =>
  (d, now) => {
    const old = d.proposals[id];
    if (!old || old.status !== 'pending') throw new OpError('not_pending', 'That proposal is no longer pending.');
    let fresh: Proposal;
    if (old.kind === 'rescue') {
      const ropts: RescueOptions = { strategy: old.rescue?.strategy, ...opts };
      const result = buildRescue(d, old.date, now, ropts);
      const week = old.days.length > 1 ? buildWeekRescue(d, old.date, now, ropts) : null;
      fresh = makeRescueProposal(d, old.date, now, result, week, { reason: old.rescue?.reason, source: old.source, client: old.client });
    } else {
      const from = offsetOf(now, old.date, d.settings.dayStart);
      const warnings: string[] = [];
      const days: ProposedDay[] = old.days.map((day) => {
        const isFirst = day.date === old.date;
        const draft = day.blocks.filter((b) => !b.missed && b.category !== 'buffer' && !isAnchor(d, b)).map((b) => ({ ...b }));
        // keep only blocks that do not collide with the latest pins
        const latestPins = liveBlocks(planFor(d, day.date)).filter((b) => b.pinned);
        const keep = draft.filter((b) => {
          const hit = latestPins.find((p) => p.id !== b.id && p.s < b.e && p.e > b.s);
          if (hit) warnings.push(`Dropped "${b.title}" on ${shortDate(day.date)}: it now overlaps the pin "${hit.title}".`);
          return !hit;
        });
        const v = validateDayBlocks(d, day.date, keep, { from: isFirst && from > 0 ? from : 0, kind: old.kind });
        warnings.push(...v.errors, ...v.warnings);
        const ids = new Set(v.blocks.map((b) => b.id));
        return {
          date: day.date,
          blocks: v.blocks,
          lines: v.lines,
          ...(day.missions ? { missions: Object.fromEntries(Object.entries(day.missions).filter(([k]) => ids.has(k))) } : {}),
          ...(day.outcomes ? { outcomes: day.outcomes } : {}),
        };
      });
      fresh = makeProposal(
        d,
        {
          kind: old.kind,
          source: old.source,
          client: old.client,
          title: old.title,
          rationale: old.rationale,
          date: old.date,
          days,
          scopeAllowed: old.scopeAllowed,
          tasksToAdd: old.tasksToAdd,
          tasksToAddToday: old.tasksToAddToday,
          warnings: [...(old.warnings ?? []), ...warnings],
        },
        now,
      );
    }
    fresh.supersedes = old.id;
    d.proposals[old.id] = { ...old, status: 'superseded', u: now };
    d.proposals[fresh.id] = { ...fresh, u: now };
    return fresh.id;
  };

export interface ApplyResult {
  dates: string[];
  tasks: number;
}

/**
 * Apply a pending, up-to-date proposal for today (its first day) or for the week (all its days).
 * Writes each in-scope day; proposal missions win only for blocks the proposal created or where
 * the user's mission is empty. Never applies a stale proposal — rebase it first.
 */
export const applyProposal =
  (id: string, scope: 'today' | 'week', decidedBy = 'user'): Op<ApplyResult> =>
  (d, now) => {
    const p = d.proposals[id];
    if (!p || p.del) throw new OpError('no_proposal', `Proposal ${id} does not exist.`);
    if (p.status === 'applied') throw new OpError('already_applied', 'That proposal was already applied.');
    if (p.status !== 'pending') throw new OpError('not_pending', `That proposal is ${p.status}; nothing was changed.`);
    if (!p.scopeAllowed.includes(scope)) throw new OpError('scope', `This proposal can only be applied for ${p.scopeAllowed.join(' or ')}.`);
    if (isStale(d, p)) throw new OpError('stale', 'The plan changed since this proposal was made. It needs to be re-checked first.');
    const days = scope === 'today' ? p.days.filter((x) => x.date === p.date) : p.days;
    for (const day of days) {
      const plan = ensurePlan(d, day.date, now);
      // Last line of defence: pins never move, whatever the proposal says.
      for (const pin of plan.blocks.filter((b) => b.pinned && !b.missed)) {
        const out = day.blocks.find((b) => b.id === pin.id);
        if (!out || out.s !== pin.s || out.e !== pin.e) throw new OpError('pin', `The proposal would move the pinned block "${pin.title}".`);
      }
      const existing = new Set(plan.blocks.map((b) => b.id));
      plan.blocks = day.blocks.map((b) => ({ ...b }));
      for (const [blockId, m] of Object.entries(day.missions ?? {})) {
        if (!m) continue;
        const block = plan.blocks.find((b) => b.id === blockId);
        const mine = block ? missionFor(plan, block) : plan.missions[blockId];
        if (!existing.has(blockId) || !mine || !mine.title.trim()) plan.missions[blockId] = m;
      }
      if (day.outcomes?.length) plan.outcomes = day.outcomes.slice(0, 3) as Outcome[];
      if (p.kind === 'rescue' && day.date === p.date) {
        const info = { at: now, summary: p.rescue?.summary ?? [], scope, ...(p.rescue?.strategy ? { strategy: p.rescue.strategy } : {}), ...(p.rescue?.reason ? { reason: p.rescue.reason } : {}) };
        plan.rescue = info;
        plan.rescues = [...(plan.rescues ?? []), info].slice(-20);
      }
      plan.plannedBy = p.kind === 'import' ? 'import' : p.source === 'mcp' ? 'ai' : (plan.plannedBy ?? 'manual');
    }
    const tasks = scope === 'today' && p.tasksToAddToday ? p.tasksToAddToday : (p.tasksToAdd ?? []);
    for (const t of tasks) {
      const tid = uid('t', now);
      d.tasks[tid] = { priority: 2, done: false, ...t, id: tid, u: now, createdAt: now } as Task;
    }
    d.proposals[id] = { ...p, status: 'applied', appliedAt: now, appliedScope: scope, decidedBy, u: now };
    if (p.group) for (const s of pendingProposals(d)) if (s.group === p.group && s.id !== id) d.proposals[s.id] = { ...s, status: 'superseded', u: now };
    return { dates: days.map((x) => x.date), tasks: tasks.length };
  };

export const rejectProposal =
  (id: string, reason?: string, decidedBy = 'user'): Op =>
  (d, now) => {
    const p = d.proposals[id];
    if (!p || p.del) throw new OpError('no_proposal', `Proposal ${id} does not exist.`);
    if (p.status !== 'pending') throw new OpError('not_pending', `That proposal is already ${p.status}.`);
    d.proposals[id] = { ...p, status: 'rejected', decidedBy, ...(reason ? { rejectReason: reason.slice(0, 300) } : {}), u: now };
  };

/** Mark overdue pending proposals expired. Idempotent; never touches decided proposals. */
export const expireProposals = (): Op<number> => (d, now) => {
  let n = 0;
  for (const p of Object.values(d.proposals ?? {})) {
    if (p.del || p.status !== 'pending' || p.expiresAt > now) continue;
    d.proposals[p.id] = { ...p, status: 'expired', u: now };
    n++;
  }
  return n;
};

export const hasExpired = (doc: Doc, now: number) => Object.values(doc.proposals ?? {}).some((p) => !p.del && p.status === 'pending' && p.expiresAt <= now);
