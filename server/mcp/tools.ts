import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z, type ZodTypeAny } from 'zod';
import { liveBlocks, missionFor, planFor, proofFor, sessionsFor } from '../../src/core/engine';
import { isOn } from '../../src/core/features';
import * as ops from '../../src/core/ops';
import { OpError, type Op } from '../../src/core/ops';
import { addProposal, applyProposal, isStale, makeProposal, makeRescueProposal, pendingProposals, rebaseProposal, rejectProposal, validateDayBlocks } from '../../src/core/proposals';
import { buildRescue, buildWeekRescue, rescueOptions, STRATEGY_LABEL } from '../../src/core/rescue';
import { slotRates, weekStats } from '../../src/core/stats';
import { goalProgress, goalsFor, upsertGoal, type GoalInput } from '../../src/core/goals';
import type { Category, Doc, Mission, Outcome, PlanBlock, ProposedDay, RescueStrategy } from '../../src/core/types';
import { addDays, dayStartMs, MIN, offsetOf, weekKey } from '../../src/core/time';
import type { HubDb } from '../db';
import { writeAudit } from './audit';
import { githubForBlock } from './github';
import { blockView, checkDate, dayView, hhmm, InputError, overview, proposalView, taskView, timeZone, today, toOffset, weekView } from './format';
import { PRINCIPLES, PROMPTS } from './texts';

// The connector's tools, resources and prompts. Every call is audited; every write goes through
// HubDb.mutate with the device label "mcp:<client>", so it has history and can be undone.
// Small things (tasks, missions, outcomes, pins, confirmed logs) apply directly. Anything that
// rearranges a day or a week becomes a proposal the user applies.

export interface ToolCtx {
  db: HubDb;
  client: string;
  clock?: () => number;
  extraTools?: (reg: Register, ctx: ToolCtx) => void; // later phases add tools here
  extraResources?: (server: McpServer, ctx: ToolCtx) => void;
  githubFor?: (doc: Doc, startMs: number, endMs: number, cacheKey: string) => Promise<unknown>;
  analyticsFor?: (doc: Doc, from: string, to: string, now: number) => Out;
}

export interface CallTx {
  now: number;
  doc: Doc;
  write: <R>(op: Op<R>) => R;
}

export interface Out {
  summary: string;
  data: Record<string, unknown>;
}

export type Register = (name: string, cfg: { title: string; description: string; kind: 'read' | 'write' | 'proposal'; input: z.ZodObject<z.ZodRawShape> }, fn: (args: never, tx: CallTx) => Out | Promise<Out>) => void;

export const CORE_TOOLS = [
  'get_overview',
  'get_day',
  'get_week',
  'list_tasks',
  'get_block_context',
  'get_analytics',
  'get_principles',
  'list_proposals',
  'get_playbook',
  'add_tasks',
  'set_mission',
  'set_outcomes',
  'pin_block',
  'log_session',
  'propose_day_plan',
  'propose_week_plan',
  'propose_rescue',
  'apply_proposal',
  'reject_proposal',
  'get_goals',
  'upsert_goals',
] as const;

const MAX_RESULT = 50 * 1024;
const TIMEOUT = 20_000;

const CATEGORIES = ['sleep', 'devotion', 'iit', 'founder', 'meal', 'care', 'rest', 'buffer', 'entertainment'] as const;
const AREAS = ['iit', 'founder', 'personal'] as const;
const date = () => z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const time = () => z.string().regex(/^([01]?\d|2[0-4]):[0-5]\d$/, 'HH:MM (24-hour)');
const https = () => z.string().max(2000).url().refine((u) => u.startsWith('https://'), 'Links must use https://');
const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

const blockInput = strict({
  title: z.string().min(1).max(120),
  category: z.enum(CATEGORIES),
  start: time(),
  end: time(),
  pinned: z.boolean().optional(),
  mission: strict({ title: z.string().min(1).max(200), steps: z.array(z.string().min(1).max(200)).max(12).optional() }).optional(),
  joinUrl: https().optional(),
});
const outcomeInput = strict({ text: z.string().min(1).max(200), area: z.enum(AREAS) });
const LEVELS = ['year', 'month', 'week', 'day'] as const;
const goalInput = strict({
  id: z.string().max(80).optional(),
  level: z.enum(LEVELS).optional(),
  period: z.string().max(10).optional(),
  parentId: z.string().max(80).optional(),
  title: z.string().min(1).max(160).optional(),
  area: z.enum(AREAS).optional(),
  why: z.string().max(500).optional(),
  metric: z
    .union([
      strict({ kind: z.literal('hours'), categories: z.array(z.enum(CATEGORIES)).max(9).optional() }),
      strict({ kind: z.literal('count'), unit: z.string().min(1).max(40) }),
      strict({ kind: z.literal('binary') }),
      strict({ kind: z.literal('milestones'), items: z.array(strict({ id: z.string().max(40).optional(), text: z.string().min(1).max(200), done: z.boolean().optional() })).max(20) }),
    ])
    .optional(),
  target: z.number().min(0).max(10000).optional(),
  status: z.enum(['active', 'done', 'dropped']).optional(),
});

function goalView(doc: Doc, g: Doc['goals'][string], now: number) {
  const p = goalProgress(doc, g, now);
  return {
    id: g.id,
    level: g.level,
    period: g.period,
    ...(g.parentId ? { parentId: g.parentId } : {}),
    title: g.title,
    area: g.area,
    ...(g.why ? { why: g.why } : {}),
    metric: g.metric.kind === 'count' ? `count (${g.metric.unit})` : g.metric.kind,
    ...(g.metric.kind === 'milestones' ? { milestones: g.metric.items.map((i) => ({ text: i.text, done: i.done })) } : {}),
    target: p.target,
    actual: p.actual,
    percent: Math.round(Math.min(1, p.pct) * 100),
    expectedPercent: Math.round(p.expectedPct * 100),
    pace: p.pace,
    status: g.status,
  };
}

function writeGoals(tx: CallTx, goals: z.infer<typeof goalInput>[]): string[] {
  return tx.write((d, now) => goals.map((g) => upsertGoal(g as GoalInput, 'ai')(d, now)));
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new InputError('The request took too long. Try again with less data.')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** A day plan drafted by the AI: listed blocks replace only the time they cover; everything else stays. */
export function draftDay(doc: Doc, d: string, blocks: z.infer<typeof blockInput>[], outcomes: z.infer<typeof outcomeInput>[] | undefined, now: number) {
  const ds = doc.settings.dayStart;
  const isToday = d === today(doc, now);
  const from = isToday ? Math.max(0, Math.floor(offsetOf(now, d, ds) / 5) * 5) : 0;
  const errors: string[] = [];
  const proposed: PlanBlock[] = [];
  const missions: Record<string, Mission> = {};
  for (const b of blocks) {
    const s = toOffset(b.start, ds);
    const e = toOffset(b.end, ds, true);
    if (e <= s) {
      errors.push(`"${b.title}" ends (${b.end}) before it starts (${b.start}) within the day that starts at ${hhmm(0, ds)}.`);
      continue;
    }
    const id = ops.uid('a', now);
    proposed.push({ id, title: b.title, category: b.category as Category, s, e, fixed: !!b.pinned, focus: b.category === 'iit' || b.category === 'founder', minMinutes: 0, priority: 3, source: 'ai', ...(b.pinned ? { pinned: true } : {}), ...(b.joinUrl ? { joinUrl: b.joinUrl } : {}) });
    if (b.mission) missions[id] = { title: b.mission.title, steps: (b.mission.steps ?? []).map((t) => ({ id: ops.uid('st', now), text: t, done: false })), source: 'ai' };
  }
  const sorted = [...proposed].sort((a, b) => a.s - b.s);
  for (let i = 1; i < sorted.length; i++) if (sorted[i].s < sorted[i - 1].e) errors.push(`"${sorted[i - 1].title}" and "${sorted[i].title}" overlap.`);
  let flex = liveBlocks(planFor(doc, d)).filter((b) => !b.fixed && b.e > from);
  if (!errors.length) for (const p of proposed) flex = ops.carve(flex, p);
  const v = validateDayBlocks(doc, d, flex, { from, kind: 'day_plan' });
  const ids = new Set(v.blocks.map((b) => b.id));
  const day: ProposedDay = {
    date: d,
    blocks: v.blocks,
    lines: v.lines,
    missions: Object.fromEntries(Object.entries(missions).filter(([k]) => ids.has(k))),
    ...(outcomes?.length ? { outcomes: outcomes.slice(0, 3).map((o) => ({ id: ops.uid('o', now), text: o.text, area: o.area, done: false }) as Outcome) } : {}),
  };
  return { day, errors: [...errors, ...v.errors], warnings: v.warnings };
}

export function buildServer(ctx: ToolCtx): McpServer {
  const server = new McpServer(
    { name: 'execution-os', title: 'Execution OS', version: __APP_VERSION__ },
    {
      instructions:
        'Execution OS is the user’s personal 24-hour command system. Call get_overview first. Rules decide when, you suggest what: never try to move sleep/devotion anchors or pinned blocks. Structural changes become proposals — ask the user before apply_proposal. Times are HH:MM in the hub’s time zone.',
    },
  );
  const device = `mcp:${ctx.client}`;
  const clock = () => ctx.clock?.() ?? Date.now();

  const reg: Register = (name, cfg, fn) => {
    const annotations = { title: cfg.title, readOnlyHint: cfg.kind === 'read', destructiveHint: false, idempotentHint: cfg.kind === 'read', openWorldHint: false };
    server.registerTool(name, { title: cfg.title, description: cfg.description, inputSchema: cfg.input, annotations }, (async (args: Record<string, unknown>) => {
      const changed: string[] = [];
      const revBefore = ctx.db.rev;
      const now = clock();
      const tx: CallTx = {
        now,
        get doc() {
          return ctx.db.doc;
        },
        write: (op) => {
          const r = ctx.db.mutate(op, device);
          changed.push(...r.changed);
          return r.result;
        },
      };
      try {
        const out = await withTimeout(Promise.resolve().then(() => fn(args as never, tx)), TIMEOUT);
        const json = JSON.stringify(out.data);
        if (json.length > MAX_RESULT) throw new InputError('The result is larger than 50 KB. Ask for less (a shorter range or a smaller limit).');
        writeAudit(ctx.db, { client: ctx.client, tool: name, args, ok: true, summary: out.summary, changed: [...new Set(changed)], revBefore, revAfter: ctx.db.rev });
        return { content: [{ type: 'text' as const, text: `${out.summary}\n\n${json}` }], structuredContent: out.data };
      } catch (e) {
        const known = e instanceof OpError || e instanceof InputError;
        const msg = known ? (e as Error).message : `Something went wrong in Execution OS: ${(e as Error).message}`;
        writeAudit(ctx.db, { client: ctx.client, tool: name, args, ok: false, summary: msg, changed: [...new Set(changed)], revBefore, revAfter: ctx.db.rev });
        return { isError: true, content: [{ type: 'text' as const, text: msg }] };
      }
    }) as never);
  };

  const dayOf = (doc: Doc, d: string | undefined, now: number) => (d ? checkDate(d) : today(doc, now));
  const blockOn = (doc: Doc, d: string, blockId: string) => {
    const b = planFor(doc, d).blocks.find((x) => x.id === blockId && !x.missed);
    if (!b) throw new InputError(`blockId ${blockId} does not exist on ${d}; call get_day first and copy the id.`);
    return b;
  };

  // ---------------- read ----------------

  reg('get_overview', { title: 'Overview (call first)', kind: 'read', input: strict({}), description: 'Right now in Execution OS: local time and time zone, logical date, day status (on track / drifting / rescue + reason), the current block with its mission and minutes left, the next 3 blocks, the 3 daily outcomes, day score, pending proposals and finished focus blocks that are not logged yet. Call this first.' }, (_a, tx) => {
    const o = overview(tx.doc, tx.now);
    return { summary: `${o.date} ${o.now} (${o.timeZone}) · ${o.status.title} · now: ${o.current ? `${o.current.title} until ${o.current.end}` : 'no block'}`, data: o };
  });

  reg('get_day', { title: 'One day', kind: 'read', input: strict({ date: date().optional() }), description: 'All blocks of one logical date (id, start, end, title, category, pinned/anchor, focus, mission, proof status, join link), the outcomes and the rescue history. Times are HH:MM local; the logical day starts at dayStart, so earlier times belong to the next calendar morning. Default: today.' }, (a: { date?: string }, tx) => {
    const d = dayOf(tx.doc, a.date, tx.now);
    const v = dayView(tx.doc, d, tx.now);
    return { summary: `${d}: ${v.blocks.length} blocks, ${v.blocks.filter((b) => 'pinned' in b).length} pinned, ${v.outcomes.length} outcomes.`, data: v };
  });

  reg('get_week', { title: 'One week', kind: 'read', input: strict({ weekStart: date().optional() }), description: 'Seven day summaries (planned focus minutes, missions, outcomes, pinned blocks, what was logged, rescues) for the week containing weekStart (Monday-based), plus adherence so far. Default: this week.' }, (a: { weekStart?: string }, tx) => {
    const ws = weekKey(dayOf(tx.doc, a.weekStart, tx.now));
    const v = weekView(tx.doc, ws, tx.now);
    return { summary: `Week of ${ws}: adherence so far ${Math.round(v.adherenceSoFar * 100)}%.`, data: v };
  });

  reg('list_tasks', { title: 'Task inbox', kind: 'read', input: strict({ area: z.enum(AREAS).optional(), includeDone: z.boolean().optional(), limit: z.number().int().min(1).max(100).optional() }), description: 'The task inbox with priority (1 = high), deadline, estimate (minutes) and goal link. Open tasks only unless includeDone is true.' }, (a: { area?: string; includeDone?: boolean; limit?: number }, tx) => {
    const list = Object.values(tx.doc.tasks)
      .filter((t) => !t.del && (a.includeDone || !t.done) && (!a.area || t.area === a.area))
      .sort((x, y) => x.priority - y.priority || (x.deadline ?? '9999').localeCompare(y.deadline ?? '9999'))
      .slice(0, a.limit ?? 50)
      .map(taskView);
    return { summary: `${list.length} task${list.length === 1 ? '' : 's'}.`, data: { tasks: list } };
  });

  reg('get_block_context', { title: 'Block context', kind: 'read', input: strict({ date: date(), blockId: z.string().min(1).max(80) }), description: 'Everything about one block, for logging it: mission and steps, earlier logs of the same mission in the last 30 days, timed sessions, and GitHub activity in the block window when the user set a GitHub username.' }, async (a: { date: string; blockId: string }, tx) => {
    const d = checkDate(a.date);
    const b = blockOn(tx.doc, d, a.blockId);
    const plan = planFor(tx.doc, d);
    const m = missionFor(plan, b);
    const previous: { date: string; status: string; note: string }[] = [];
    if (m) {
      for (let i = 1; i <= 30; i++) {
        const k = addDays(d, -i);
        const p2 = planFor(tx.doc, k);
        for (const x of liveBlocks(p2)) {
          const mm = missionFor(p2, x);
          const pr = proofFor(tx.doc, k, x.id);
          if (mm && pr && mm.title.trim().toLowerCase() === m.title.trim().toLowerCase()) previous.push({ date: k, status: pr.status, note: pr.note });
        }
      }
    }
    const sessions = sessionsFor(tx.doc, d)
      .filter((s) => s.blockId === b.id)
      .map((s) => ({ start: new Date(s.start).toTimeString().slice(0, 5), end: s.end ? new Date(s.end).toTimeString().slice(0, 5) : null, minutes: Math.round(((s.end ?? tx.now) - s.start) / MIN) }));
    const ds = tx.doc.settings.dayStart;
    const github = await (ctx.githubFor ?? githubForBlock)(tx.doc, dayStartMs(d, ds) + b.s * MIN, Math.min(tx.now, dayStartMs(d, ds) + b.e * MIN), `${d}:${b.id}`);
    const proof = proofFor(tx.doc, d, b.id);
    return {
      summary: `${b.title} ${hhmm(b.s, ds)}–${hhmm(b.e, ds)}${m ? ` · mission: ${m.title}` : ' · no mission'}${proof ? ` · logged: ${proof.status}` : ''}.`,
      data: { date: d, block: blockView(tx.doc, d, b, tx.now), previousLogs: previous.slice(0, 5), sessions, ...(proof ? { existingLog: { status: proof.status, note: proof.note, links: proof.links } } : {}), github },
    };
  });

  reg('get_analytics', { title: 'Analytics', kind: 'read', input: strict({ from: date(), to: date() }), description: 'Plan-versus-reality statistics for a date range (weekly statistics per week touched). Numbers are computed by the engine; narrate them, never invent or round them up.' }, (a: { from: string; to: string }, tx) => {
    const from = checkDate(a.from);
    const to = checkDate(a.to);
    if (to < from) throw new InputError('"to" is before "from".');
    if (ctx.analyticsFor) return ctx.analyticsFor(tx.doc, from, to, tx.now);
    const weeks: ReturnType<typeof weekStats>[] = [];
    for (let w = weekKey(from); w <= to && weeks.length < 13; w = addDays(w, 7)) weeks.push(weekStats(tx.doc, w, tx.now));
    return { summary: `${weeks.length} week${weeks.length === 1 ? '' : 's'} of statistics.`, data: { from, to, weeks: weeks.map((s) => ({ weekStart: s.weekStart, adherence: s.adherence, iitRate: s.iitRate, founderMinutes: s.founderMinutes, distractionMin: s.distractionMin, insights: s.insights, recommendation: s.recommendation })) } };
  });

  reg('get_principles', { title: 'Principles', kind: 'read', input: strict({}), description: 'The 12 principles of Execution OS and how the engine treats AI (what applies directly, what becomes a proposal, time conventions). Read once per conversation.' }, () => ({ summary: 'The principles of Execution OS.', data: { text: PRINCIPLES } }));

  reg('list_proposals', { title: 'Proposals', kind: 'read', input: strict({ status: z.enum(['pending', 'applied', 'rejected', 'expired', 'superseded']).optional() }), description: 'Proposals (rescue, day/week plans, imports) with their per-day changes. Default: pending.' }, (a: { status?: string }, tx) => {
    const st = a.status ?? 'pending';
    const list = Object.values(tx.doc.proposals)
      .filter((p) => !p.del && p.status === st)
      .sort((x, y) => y.createdAt - x.createdAt)
      .slice(0, 20)
      .map((p) => proposalView(tx.doc, p));
    return { summary: `${list.length} ${st} proposal${list.length === 1 ? '' : 's'}.`, data: { proposals: list } };
  });

  reg('get_playbook', { title: 'Playbook', kind: 'read', input: strict({ name: z.enum(PROMPTS.map((p) => p.name) as [string, ...string[]]) }), description: 'The step-by-step operating procedure for a common request (same text as the matching prompt): plan_my_day, plan_my_week, rescue_my_day, log_my_execution, weekly_review, import_class_schedule, morning_brief, shutdown. Use it when your client does not show prompts.' }, (a: { name: string }, tx) => {
    const p = PROMPTS.find((x) => x.name === a.name)!;
    return { summary: p.title, data: { name: p.name, text: p.text(promptDefaults(tx.doc, tx.now, {})) } };
  });

  // ---------------- write (direct, audited, undoable) ----------------

  reg('add_tasks', { title: 'Add tasks', kind: 'write', input: strict({ tasks: z.array(strict({ title: z.string().min(1).max(200), area: z.enum(AREAS), priority: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(), deadline: date().optional(), estimate: z.number().int().min(5).max(600).optional(), notes: z.string().max(1000).optional(), goalId: z.string().max(80).optional() })).min(1).max(20) }), description: 'Add up to 20 tasks to the inbox (applies immediately; the user can undo). Only add tasks the user asked for.' }, (a: { tasks: Parameters<typeof ops.addTask>[0][] }, tx) => {
    const ids = tx.write((d, now) => a.tasks.map((t) => ops.addTask({ ...t, title: t.title.trim() })(d, now)));
    return { summary: `Added ${ids.length} task${ids.length === 1 ? '' : 's'} to the inbox.`, data: { added: ids.length, ids } };
  });

  reg('set_mission', { title: 'Set a mission', kind: 'write', input: strict({ date: date(), blockId: z.string().min(1).max(80), title: z.string().min(1).max(200), steps: z.array(z.string().min(1).max(200)).max(12).optional(), estimate: z.number().int().min(5).max(600).optional(), goalId: z.string().max(80).optional(), force: z.boolean().optional() }), description: 'Set the one mission of a focus block ("Finish Assignment 3, Q1–Q5", not "study"). Copy blockId from get_day. Refuses non-focus blocks unless force is true.' }, (a: { date: string; blockId: string; title: string; steps?: string[]; estimate?: number; goalId?: string; force?: boolean }, tx) => {
    const d = checkDate(a.date);
    const b = blockOn(tx.doc, d, a.blockId);
    if (!b.focus && !a.force) throw new InputError(`"${b.title}" is not a focus block. Missions belong in focus blocks; pass force: true only if the user insists.`);
    const plan = planFor(tx.doc, d);
    const key = plan.missions[b.id] ? b.id : b.origin && plan.missions[b.origin] ? b.origin : b.id;
    const m: Mission = { title: a.title.trim(), steps: (a.steps ?? []).map((t) => ({ id: ops.uid('st', tx.now), text: t, done: false })), source: 'ai', ...(a.estimate ? { estimate: a.estimate } : {}), ...(a.goalId ? { goalId: a.goalId } : {}) };
    tx.write(ops.setMission(d, key, m));
    return { summary: `Mission for "${b.title}" on ${d}: ${m.title}.`, data: { date: d, blockId: b.id, mission: m.title } };
  });

  reg('set_outcomes', { title: 'Set the 3 outcomes', kind: 'write', input: strict({ date: date(), outcomes: z.array(outcomeInput).min(1).max(3) }), description: 'Replace the day’s three outcomes (the results that would make the day a success).' }, (a: { date: string; outcomes: { text: string; area: 'iit' | 'founder' | 'personal' }[] }, tx) => {
    const d = checkDate(a.date);
    tx.write(ops.setOutcomes(d, a.outcomes.map((o) => ({ id: ops.uid('o', tx.now), text: o.text.trim(), area: o.area, done: false }))));
    return { summary: `Outcomes for ${d}: ${a.outcomes.map((o) => o.text).join(' · ')}.`, data: { date: d, outcomes: a.outcomes } };
  });

  reg('pin_block', { title: 'Pin or unpin a block', kind: 'write', input: strict({ date: date(), blockId: z.string().min(1).max(80), pinned: z.boolean() }), description: 'Pin a block to its clock time (Rescue then never moves it) or unpin it. Anchors (sleep, devotion) are already fixed and cannot be pinned or unpinned. Copy blockId from get_day.' }, (a: { date: string; blockId: string; pinned: boolean }, tx) => {
    const d = checkDate(a.date);
    const b = blockOn(tx.doc, d, a.blockId);
    tx.write(ops.pinBlock(d, b.id, a.pinned));
    return { summary: `${a.pinned ? 'Pinned' : 'Unpinned'} "${b.title}" ${hhmm(b.s, tx.doc.settings.dayStart)}–${hhmm(b.e, tx.doc.settings.dayStart)}.`, data: { date: d, blockId: b.id, pinned: a.pinned } };
  });

  reg('log_session', { title: 'Log a session (after the user confirms)', kind: 'write', input: strict({ date: date(), blockId: z.string().min(1).max(80), status: z.enum(['done', 'partial', 'none']), percent: z.number().int().min(0).max(100).optional(), note: z.string().max(2000), links: z.array(https()).max(10), remaining: z.string().max(1000).optional(), blockers: z.string().max(1000).optional(), goalId: z.string().max(80).optional(), countDelta: z.number().int().min(0).max(100).optional(), userConfirmed: z.literal(true) }), description: 'Post proof of work for a block, exactly as the user described it. Ask the user "Post this?" first and set userConfirmed: true only after they say yes. Never add accomplishments yourself. If a log exists, the new note is appended and links are merged. "remaining" becomes an inbox task.' }, (a: { date: string; blockId: string; status: 'done' | 'partial' | 'none'; percent?: number; note: string; links: string[]; remaining?: string; blockers?: string; goalId?: string; countDelta?: number }, tx) => {
    const d = checkDate(a.date);
    const b = blockOn(tx.doc, d, a.blockId);
    const r = tx.write(ops.logSession({ ...a, date: d, blockId: b.id, via: 'mcp', confirmed: true }));
    return { summary: `Logged "${b.title}" as ${a.status}${r.taskId ? '; the remaining work is now an inbox task' : ''}.`, data: { date: d, blockId: b.id, status: a.status, ...(r.taskId ? { taskId: r.taskId } : {}) } };
  });

  // ---------------- proposals ----------------

  const created = (doc: Doc, id: string) => proposalView(doc, doc.proposals[id]);

  reg('propose_day_plan', { title: 'Propose a day plan', kind: 'proposal', input: strict({ date: date(), blocks: z.array(blockInput).max(40), outcomes: z.array(outcomeInput).max(3).optional(), rationale: z.string().max(500).optional() }), description: 'Draft a full or partial plan for one logical date in Execution OS. Times are 24-hour HH:MM in the user’s local time zone (returned by get_overview); the logical day starts at dayStart, so times before it belong to the following calendar morning. Do not include sleep or devotion anchors — they are fixed and will be restored automatically. Blocks you list replace flexible time only; existing pinned blocks are kept. This creates a proposal; nothing changes until the user applies it. After calling, show the user the returned summary and ask "Apply for today?".' }, (a: { date: string; blocks: z.infer<typeof blockInput>[]; outcomes?: z.infer<typeof outcomeInput>[]; rationale?: string }, tx) => {
    const d = checkDate(a.date);
    const draft = draftDay(tx.doc, d, a.blocks, a.outcomes, tx.now);
    if (draft.errors.length) throw new InputError(`The plan was not created: ${draft.errors.join(' ')}`);
    const p = makeProposal(tx.doc, { kind: 'day_plan', source: 'mcp', client: ctx.client, title: `Plan for ${d}`, rationale: a.rationale, date: d, days: [draft.day], scopeAllowed: ['today'], warnings: draft.warnings }, tx.now);
    const id = tx.write(addProposal(p));
    const v = created(tx.doc, id);
    return { summary: `Proposal ${id} ready: ${v.days[0].changes.length} change(s)${draft.warnings.length ? `, ${draft.warnings.length} warning(s)` : ''}. Show it to the user and ask "Apply for today?".`, data: { proposal: v } };
  });

  reg('propose_week_plan', { title: 'Propose a week plan', kind: 'proposal', input: strict({ weekStart: date(), goals: z.array(goalInput).max(10).optional(), days: z.array(strict({ date: date(), blocks: z.array(blockInput).max(40), outcomes: z.array(outcomeInput).max(3).optional() })).min(1).max(7), tasks: z.array(strict({ title: z.string().min(1).max(200), area: z.enum(AREAS), priority: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(), deadline: date().optional(), estimate: z.number().int().min(5).max(600).optional() })).max(20).optional(), rationale: z.string().max(500).optional() }), description: 'Draft plans for up to 7 days of one week (same rules as propose_day_plan, per day), plus tasks to add. "goals" creates or updates weekly targets right away (like upsert_goals). Creates one proposal; summarise each day in one line and ask "Apply for the week?".' }, (a: { weekStart: string; goals?: z.infer<typeof goalInput>[]; days: { date: string; blocks: z.infer<typeof blockInput>[]; outcomes?: z.infer<typeof outcomeInput>[] }[]; tasks?: { title: string; area: 'iit' | 'founder' | 'personal'; priority?: 1 | 2 | 3; deadline?: string; estimate?: number }[]; rationale?: string }, tx) => {
    const ws = weekKey(checkDate(a.weekStart));
    const days: ProposedDay[] = [];
    const errors: string[] = [];
    const warnings: string[] = [];
    for (const x of [...a.days].sort((p, q) => p.date.localeCompare(q.date))) {
      const d = checkDate(x.date);
      if (weekKey(d) !== ws) throw new InputError(`${d} is not in the week starting ${ws}.`);
      const r = draftDay(tx.doc, d, x.blocks, x.outcomes, tx.now);
      errors.push(...r.errors.map((e) => `${d}: ${e}`));
      warnings.push(...r.warnings.map((w) => `${d}: ${w}`));
      days.push(r.day);
    }
    if (errors.length) throw new InputError(`The plan was not created: ${errors.join(' ')}`);
    const goalIds = a.goals?.length ? writeGoals(tx, a.goals.map((g) => ({ level: 'week' as const, period: ws, ...g }))) : [];
    const p = makeProposal(tx.doc, { kind: 'week_plan', source: 'mcp', client: ctx.client, title: `Week plan from ${ws}`, rationale: a.rationale, date: days[0].date, days, scopeAllowed: ['week', 'today'], tasksToAdd: a.tasks, tasksToAddToday: [], warnings }, tx.now);
    const id = tx.write(addProposal(p));
    return { summary: `Proposal ${id} ready for ${days.length} day(s)${goalIds.length ? `; ${goalIds.length} weekly target(s) saved` : ''}. Summarise each day and ask "Apply for the week?".`, data: { proposal: created(tx.doc, id), ...(goalIds.length ? { goalIds } : {}) } };
  });

  reg('propose_rescue', { title: 'Propose a rescue', kind: 'proposal', input: strict({ date: date().optional(), strategy: z.enum(['balanced', 'protect_study', 'ship', 'light']).optional(), scope: z.enum(['today', 'week']), hints: z.array(strict({ blockId: z.string().min(1).max(80), priority: z.number().int().min(1).max(5).optional(), missionTitle: z.string().min(1).max(200).optional() })).max(20).optional() }), description: 'Run Rescue (the engine decides all times; your hints may only change a block’s priority 1–5 or its mission title). Without a strategy it returns up to three alternatives (balanced, protect study, ship the deliverable, light day) as proposals, each with a headline saying what it protects and what it gives up. Show them, recommend one in a sentence, and ask "Apply for today or for the week?".' }, (a: { date?: string; strategy?: RescueStrategy; scope: 'today' | 'week'; hints?: { blockId: string; priority?: number; missionTitle?: string }[] }, tx) => {
    const d = dayOf(tx.doc, a.date, tx.now);
    const base = { slotRates: slotRates(tx.doc, d, tx.now), hints: a.hints };
    const results = a.strategy ? [buildRescue(tx.doc, d, tx.now, { ...base, strategy: a.strategy })] : rescueOptions(tx.doc, d, tx.now, base);
    const group = ops.uid('g', tx.now);
    const out: Record<string, unknown>[] = [];
    for (const r of results) {
      const week = a.scope === 'week' ? buildWeekRescue(tx.doc, d, tx.now, { ...base, strategy: r.strategy }) : null;
      const p = { ...makeRescueProposal(tx.doc, d, tx.now, r, week, { source: 'mcp', client: ctx.client, reason: 'manual' }), group, title: `Rescue (${STRATEGY_LABEL[r.strategy]}) for ${d}` };
      const id = tx.write(addProposal(p));
      out.push({ proposalId: id, strategy: r.strategy, headline: r.headline ?? STRATEGY_LABEL[r.strategy], feasible: r.feasible, pinnedBlocksKept: r.pinnedCount, changes: r.lines.filter((l) => l.kind !== 'kept').map((l) => l.reason) });
    }
    return { summary: `${out.length} rescue option${out.length === 1 ? '' : 's'} ready. Recommend one and ask "Apply for today or for the week?".`, data: { date: d, options: out } };
  });

  reg('apply_proposal', { title: 'Apply a proposal (after the user says yes)', kind: 'write', input: strict({ proposalId: z.string().min(1).max(80), scope: z.enum(['today', 'week']) }), description: 'Apply a pending proposal for today or for the week. Only call this after the user explicitly agreed. If the user changed the plan meanwhile, the proposal is re-checked instead of applied: show the user the updated proposal and ask again.' }, (a: { proposalId: string; scope: 'today' | 'week' }, tx) => {
    const p = tx.doc.proposals[a.proposalId];
    if (!p || p.del) throw new InputError(`Proposal ${a.proposalId} does not exist; call list_proposals.`);
    if (p.status === 'applied') throw new InputError('That proposal was already applied.');
    if (p.status === 'pending' && isStale(tx.doc, p)) {
      const fresh = tx.write(rebaseProposal(p.id, { slotRates: slotRates(tx.doc, p.date, tx.now) }));
      return { summary: `Not applied: the plan changed since the proposal was made. It was re-checked as proposal ${fresh}. Show the user the update and ask again.`, data: { applied: false, rebasedProposalId: fresh, proposal: created(tx.doc, fresh) } };
    }
    const r = tx.write(applyProposal(p.id, a.scope, device));
    return { summary: `Applied for ${a.scope === 'week' ? 'the week' : 'today'}: ${r.dates.join(', ')}${r.tasks ? `; ${r.tasks} task(s) added` : ''}.`, data: { applied: true, dates: r.dates, tasksAdded: r.tasks } };
  });

  reg('reject_proposal', { title: 'Reject a proposal', kind: 'write', input: strict({ proposalId: z.string().min(1).max(80), reason: z.string().max(300).optional() }), description: 'Mark a pending proposal rejected. Nothing else changes.' }, (a: { proposalId: string; reason?: string }, tx) => {
    tx.write(rejectProposal(a.proposalId, a.reason, device));
    return { summary: `Rejected ${a.proposalId}.`, data: { rejected: a.proposalId } };
  });

  reg('get_goals', { title: 'Targets', kind: 'read', input: strict({ level: z.enum(LEVELS).optional(), period: z.string().max(10).optional() }), description: 'Year → month → week → day targets with progress: actual vs target, percent, where the user should be by now (expectedPercent) and pace (ahead / on_track / behind / at_risk / done). Periods: year "2026", month "2026-10", week = its Monday "2026-10-19", day "2026-10-24".' }, (a: { level?: 'year' | 'month' | 'week' | 'day'; period?: string }, tx) => {
    const list = goalsFor(tx.doc, a.level, a.level === 'week' && a.period ? weekKey(a.period) : a.period).slice(0, 60).map((g) => goalView(tx.doc, g, tx.now));
    return { summary: `${list.length} target${list.length === 1 ? '' : 's'}.`, data: { goals: list } };
  });

  reg('upsert_goals', { title: 'Create or update targets', kind: 'write', input: strict({ goals: z.array(goalInput).min(1).max(20) }), description: 'Create targets (no id) or update them (with id). Never deletes — to drop one, set status "dropped". Keep it small: at most 5 yearly targets and 3 per goal per month. Measurable metrics only: hours (optionally of categories), count (with a unit), binary, or milestones. Link months to a year target and weeks to a month target with parentId.' }, (a: { goals: z.infer<typeof goalInput>[] }, tx) => {
    const ids = writeGoals(tx, a.goals);
    return { summary: `Saved ${ids.length} target${ids.length === 1 ? '' : 's'}.`, data: { ids, goals: ids.map((id) => goalView(tx.doc, tx.doc.goals[id], tx.now)) } };
  });

  ctx.extraTools?.(reg, ctx);

  // ---------------- resources ----------------

  server.registerResource('principles', 'eos://principles', { title: 'Principles', description: 'The 12 principles and how the engine treats AI', mimeType: 'text/plain' }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/plain', text: PRINCIPLES }] }));
  server.registerResource('today', 'eos://today', { title: 'Today', description: 'Overview and all blocks of today', mimeType: 'application/json' }, async (uri) => {
    const now = clock();
    const doc = ctx.db.doc;
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ overview: overview(doc, now), day: dayView(doc, today(doc, now), now) }) }] };
  });
  server.registerResource('week', 'eos://week', { title: 'This week', description: 'Seven day summaries of this week', mimeType: 'application/json' }, async (uri) => {
    const now = clock();
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(weekView(ctx.db.doc, weekKey(today(ctx.db.doc, now)), now)) }] };
  });
  server.registerResource('goals', 'eos://goals', { title: 'Targets', description: 'Active targets with progress', mimeType: 'application/json' }, async (uri) => {
    const now = clock();
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(goalsFor(ctx.db.doc).filter((g) => g.status === 'active').slice(0, 60).map((g) => goalView(ctx.db.doc, g, now))) }] };
  });
  ctx.extraResources?.(server, ctx);

  // ---------------- prompts ----------------

  for (const p of PROMPTS) {
    const shape = Object.fromEntries(p.args.map((a) => [a.name, z.string().describe(a.description).optional()])) as Record<string, ZodTypeAny>;
    server.registerPrompt(p.name, { title: p.title, description: p.description, argsSchema: shape as never }, ((args: Record<string, string | undefined>) => ({
      messages: [{ role: 'user' as const, content: { type: 'text' as const, text: p.text(promptDefaults(ctx.db.doc, clock(), args)) } }],
    })) as never);
  }

  return server;
}

export function promptDefaults(doc: Doc, now: number, args: Record<string, string | undefined>): Record<string, string> {
  const d = today(doc, now);
  return {
    date: args.date || d,
    weekStart: args.weekStart || weekKey(d),
    strictness: args.strictness || (doc.settings as { coachStrictness?: string }).coachStrictness || 'direct',
    range: args.range || 'next week',
  };
}

export const connectorEnabledFlag = (doc: Doc) => isOn(doc.settings, 'mcp');
export { timeZone, pendingProposals };
