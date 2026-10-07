import { CATEGORY_META } from './defaults';
import { liveBlocks, planFor, proofFor } from './engine';
import type { Area, Doc, Mission, Outcome, PlanBlock, Task } from './types';
import { addDays, clockOf, fmtClock, fmtDur, offsetOf, parseKey } from './time';
import type { WeekStats } from './stats';

// Rules engine = authority, AI = strategist.
// The clock decides WHEN each kind of work happens. The planner (AI or the built-in
// smart fill) only decides WHAT the highest-value work inside each flexible block is.

export interface PlannerBlock {
  id: string;
  title: string;
  category: string;
  start: string;
  end: string;
  minutes: number;
}

export interface PlannerContext {
  date: string;
  name: string;
  blocks: PlannerBlock[];
  tasks: { id: string; title: string; area: Area; deadline?: string; daysLeft?: number; estimate?: number; priority: number; notes?: string }[];
  yesterdayMisses: string[];
  carried: string[];
}

export interface PlannerResult {
  outcomes: { text: string; area: Area }[];
  missions: { blockId: string; title: string; steps: string[]; estimate?: number }[];
  note?: string;
}

/** Focus blocks that have not ended yet (all of them for a future day). */
export function plannableBlocks(doc: Doc, date: string, nowMs = Date.now()): PlanBlock[] {
  const off = offsetOf(nowMs, date, doc.settings.dayStart);
  return liveBlocks(planFor(doc, date)).filter((b) => b.focus && b.e > off);
}

export function openTasks(doc: Doc): Task[] {
  return Object.values(doc.tasks).filter((t) => !t.del && !t.done);
}

function daysLeft(deadline: string | undefined, date: string): number | undefined {
  if (!deadline) return undefined;
  return Math.round((parseKey(deadline).getTime() - parseKey(date).getTime()) / 86_400_000);
}

export function taskValue(t: Task, date: string): number {
  const dl = daysLeft(t.deadline, date);
  let v = (4 - t.priority) * 10;
  if (dl !== undefined) v += dl <= 0 ? 40 : dl <= 1 ? 30 : dl <= 3 ? 20 : dl <= 7 ? 10 : 0;
  if (t.carried) v += 5;
  return v;
}

export function plannerContext(doc: Doc, date: string, nowMs = Date.now()): PlannerContext {
  const ds = doc.settings.dayStart;
  const blocks = plannableBlocks(doc, date, nowMs).map((b) => ({
    id: b.id,
    title: b.title,
    category: CATEGORY_META[b.category].label,
    start: fmtClock(clockOf(b.s, ds)),
    end: fmtClock(clockOf(b.e, ds)),
    minutes: b.e - b.s,
  }));
  const tasks = openTasks(doc)
    .sort((a, b) => taskValue(b, date) - taskValue(a, date))
    .slice(0, 40)
    .map((t) => ({
      id: t.id,
      title: t.title,
      area: t.area,
      deadline: t.deadline,
      daysLeft: daysLeft(t.deadline, date),
      estimate: t.estimate,
      priority: t.priority,
      notes: t.notes,
    }));
  const yesterday = addDays(date, -1);
  const yplan = planFor(doc, yesterday);
  const yesterdayMisses = liveBlocks(yplan)
    .filter((b) => b.focus)
    .filter((b) => {
      const p = proofFor(doc, yesterday, b.id);
      return !p || p.status !== 'done';
    })
    .map((b) => {
      const m = yplan.missions[b.id] ?? (b.origin ? yplan.missions[b.origin] : undefined);
      return m ? `${m.title} (${CATEGORY_META[b.category].short})` : `${b.title} block`;
    });
  return {
    date,
    name: doc.settings.name,
    blocks,
    tasks,
    yesterdayMisses,
    carried: openTasks(doc)
      .filter((t) => t.carried)
      .map((t) => t.title),
  };
}

export const PLANNER_SYSTEM = `You are the planning strategist inside Execution OS, a personal 24-hour command system.
The schedule (when each kind of work happens) is fixed by rules and is NOT yours to change.
Your only job: decide the single highest-value mission for each focus block today, and the day's 3 outcomes.

Rules:
- Exactly 3 daily outcomes. At least one must be IIT (studies) when an IIT block exists today.
- One mission per block. A mission is a concrete, checkable result ("Submit Week 6 statistics assignment"), never a vague activity ("Study").
- Missions must fit the block's minutes. Split into 2-5 concrete steps.
- Prefer tasks with near deadlines and high priority. Carry yesterday's misses forward when still relevant.
- Never invent tasks that conflict with the given list; you may add a sensible review/revision step if a block has no tasks.
- Respond with JSON only, no prose, matching:
{"outcomes":[{"text":string,"area":"iit"|"founder"|"personal"}],
 "missions":[{"blockId":string,"title":string,"steps":[string],"estimate":number}],
 "note":string}`;

export function plannerUserPrompt(ctx: PlannerContext): string {
  return `Plan ${ctx.name}'s day for ${ctx.date}.

FOCUS BLOCKS (use these exact blockId values):
${ctx.blocks.map((b) => `- blockId=${b.id} | ${b.category} | ${b.title} | ${b.start}–${b.end} (${b.minutes} min)`).join('\n') || '- none'}

OPEN TASKS (highest value first):
${
  ctx.tasks
    .map(
      (t) =>
        `- [${t.area}] ${t.title}${t.deadline ? ` | deadline ${t.deadline} (${t.daysLeft} days left)` : ''}${t.estimate ? ` | ~${t.estimate} min` : ''} | priority ${t.priority}${t.notes ? ` | notes: ${t.notes}` : ''}`,
    )
    .join('\n') || '- (no tasks entered — propose sensible missions from the block names)'
}

YESTERDAY'S MISSES: ${ctx.yesterdayMisses.join('; ') || 'none'}
CARRIED BY RESCUE MODE: ${ctx.carried.join('; ') || 'none'}

Return the JSON now.`;
}

export function fullPlannerPrompt(ctx: PlannerContext): string {
  return `${PLANNER_SYSTEM}\n\n---\n\n${plannerUserPrompt(ctx)}`;
}

/** Pull the first JSON object out of a model reply (handles ```json fences and stray prose). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('No JSON object found in the reply.');
  return JSON.parse(body.slice(start, end + 1));
}

const AREAS: Area[] = ['iit', 'founder', 'personal'];

export function parsePlannerReply(text: string, validBlockIds: string[]): PlannerResult {
  const raw = extractJson(text) as Record<string, unknown>;
  const outcomes = Array.isArray(raw.outcomes) ? raw.outcomes : [];
  const missions = Array.isArray(raw.missions) ? raw.missions : [];
  const res: PlannerResult = {
    outcomes: outcomes
      .map((o) => o as Record<string, unknown>)
      .filter((o) => typeof o.text === 'string' && o.text.trim())
      .slice(0, 3)
      .map((o) => ({
        text: String(o.text).trim(),
        area: AREAS.includes(o.area as Area) ? (o.area as Area) : 'founder',
      })),
    missions: missions
      .map((m) => m as Record<string, unknown>)
      .filter((m) => typeof m.blockId === 'string' && validBlockIds.includes(m.blockId) && typeof m.title === 'string')
      .map((m) => ({
        blockId: String(m.blockId),
        title: String(m.title).trim(),
        steps: Array.isArray(m.steps) ? m.steps.map(String).filter(Boolean).slice(0, 8) : [],
        estimate: typeof m.estimate === 'number' ? Math.round(m.estimate) : undefined,
      })),
    note: typeof raw.note === 'string' ? raw.note : undefined,
  };
  if (!res.outcomes.length && !res.missions.length) throw new Error('The reply had no outcomes or missions.');
  return res;
}

/** Built-in planner (no AI): assigns the most valuable open tasks to blocks of the matching area. */
export function smartFill(doc: Doc, date: string, nowMs = Date.now()): PlannerResult {
  const blocks = plannableBlocks(doc, date, nowMs);
  const used = new Set<string>();
  const ranked = openTasks(doc).sort((a, b) => taskValue(b, date) - taskValue(a, date));
  const missions: PlannerResult['missions'] = [];
  for (const b of blocks) {
    const area: Area = b.category === 'iit' ? 'iit' : b.category === 'founder' ? 'founder' : 'personal';
    const len = b.e - b.s;
    const picks: Task[] = [];
    let budget = len;
    for (const t of ranked) {
      if (used.has(t.id) || t.area !== area) continue;
      const est = t.estimate ?? Math.min(len, 60);
      if (picks.length && est > budget) continue;
      picks.push(t);
      used.add(t.id);
      budget -= est;
      if (budget <= 15) break;
    }
    if (!picks.length) continue;
    missions.push({
      blockId: b.id,
      title: picks[0].title,
      steps: picks.length > 1 ? picks.map((p) => `${p.title}${p.estimate ? ` (${fmtDur(p.estimate)})` : ''}`) : [],
      estimate: picks.reduce((a, p) => a + (p.estimate ?? 0), 0) || undefined,
    });
  }
  const outcomes: PlannerResult['outcomes'] = [];
  const iit = ranked.find((t) => t.area === 'iit');
  if (iit) outcomes.push({ text: iit.title, area: 'iit' });
  for (const t of ranked) {
    if (outcomes.length >= 3) break;
    if (outcomes.some((o) => o.text === t.title)) continue;
    outcomes.push({ text: t.title, area: t.area });
  }
  return { outcomes, missions };
}

export function toMission(m: PlannerResult['missions'][number], source: Mission['source'], mkId: () => string): Mission {
  return {
    title: m.title,
    steps: m.steps.map((text) => ({ id: mkId(), text, done: false })),
    estimate: m.estimate,
    source,
  };
}

export function toOutcomes(list: PlannerResult['outcomes'], mkId: () => string): Outcome[] {
  return list.slice(0, 3).map((o) => ({ id: mkId(), text: o.text, area: o.area, done: false }));
}

// ---------- weekly review prompt ----------

export const REVIEW_SYSTEM = `You are the weekly reviewer inside Execution OS. You receive measured statistics about one person's week.
Write a short, direct review (max 120 words) in second person: what improved, what failed, and why it likely failed.
Then give exactly ONE concrete schedule modification for next week. Not ten. Use only the numbers provided; never invent data.
No streak language, no guilt, no motivational filler.
Format:
REVIEW: <text>
CHANGE: <one modification>`;

export function reviewUserPrompt(s: WeekStats): string {
  const pct = (v: number | null) => (v === null ? 'n/a' : `${Math.round(v * 100)}%`);
  return `Week starting ${s.weekStart}.
Adherence: ${pct(s.adherence)} (previous week ${pct(s.prevAdherence)})
IIT completion: ${pct(s.iitRate)} (previous week ${pct(s.prevIitRate)})
Founder focus time: ${fmtDur(s.founderMinutes)}
Unplanned distraction: ${fmtDur(s.distractionMin)}${s.topDistraction ? ` (mostly ${s.topDistraction})` : ''}
Planned entertainment: ${fmtDur(s.entertainmentPlanned)}
Strongest window: ${s.bestWindow ? `${fmtClock(s.bestWindow.start)}–${fmtClock(s.bestWindow.end)}` : 'n/a'}
Slot success rates: ${s.slots.map((x) => `${x.label} ${pct(x.rate)} (n=${x.scheduled})`).join('; ') || 'n/a'}
Weekday completion: ${s.weekday.map((w) => `${w.day} ${pct(w.rate)}`).join('; ') || 'n/a'}
Per-day: ${s.days.map((d) => `${d.date} adherence ${pct(d.adherence)}, IIT ${fmtDur(d.iit)}, founder ${fmtDur(d.founder)}${d.rescued ? ', rescued' : ''}`).join(' | ')}
Deterministic recommendation (you may refine it): ${s.recommendation ?? 'none'}`;
}

export function parseReviewReply(text: string): { review: string; change?: string } {
  const r = /REVIEW:\s*([\s\S]*?)(?:\n\s*CHANGE:|$)/i.exec(text);
  const c = /CHANGE:\s*([\s\S]*)$/i.exec(text);
  return { review: (r?.[1] ?? text).trim(), change: c?.[1]?.trim() };
}
