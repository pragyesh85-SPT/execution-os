import { analytics, type Analytics } from './analytics';
import { OpError, type Op } from './ops';
import type { Category, CoachingNote, Doc, RuleAction, RuleTrigger } from './types';
import { addDays, fmtDur, weekKey } from './time';

// The weekly grade. Computed here, never by the AI: the connector fills grade, score, profile and
// evidence from the engine, so nobody can round them up. The coach is blunt about behaviour and
// never labels the person (Kluger & DeNisi, 1996: feedback aimed at the self often backfires).

export interface CoachVerdict {
  grade: 'A' | 'B' | 'C' | 'D' | 'F' | 'Not enough data';
  score: number; // 0..100
  profile: string;
  evidence: string[]; // exactly 3 numeric facts
  components: { S: number; C: number; A: number; D: number };
  leak: string;
  change: { cue: string; trigger?: RuleTrigger; action?: RuleAction };
  wentWell?: string;
}

const MIN_BLOCKS = 5;
const pct = (v: number) => `${Math.round(v * 100)}%`;

export function components(a: Analytics) {
  const S = a.onTime.rate;
  const C = a.completion.rate;
  const A = a.anchors.mean ?? 1;
  const D = 1 - Math.min(1, a.plannedFocusMinutes ? a.drift.distractionMinutes / (0.25 * a.plannedFocusMinutes) : 0);
  return { S, C, A, D };
}

export function scoreOf(c: { S: number; C: number; A: number; D: number }) {
  return Math.round(100 * (0.3 * c.S + 0.35 * c.C + 0.2 * c.A + 0.15 * c.D));
}

export function gradeOf(score: number, finished: number): CoachVerdict['grade'] {
  if (finished < MIN_BLOCKS) return 'Not enough data';
  return score >= 85 ? 'A' : score >= 72 ? 'B' : score >= 60 ? 'C' : score >= 45 ? 'D' : 'F';
}

/** First match wins, always with the numbers that triggered it. */
export function profileOf(a: Analytics, c: ReturnType<typeof components>, score: number, prevScore: number | null): string {
  const s = pct(c.S);
  const cc = pct(c.C);
  if (c.S >= 0.8 && c.C >= 0.8) return `Consistent executor (on time ${s}, completion ${cc})`;
  if (prevScore !== null && score >= prevScore + 10) return `Recovering (score ${score}, up from ${prevScore})`;
  if (a.rescues.count >= 4) return `Firefighter (${a.rescues.count} rescues)`;
  if (c.S >= 0.7 && c.C < 0.5) return `Strong starter, weak finisher (on time ${s}, completion ${cc})`;
  if (c.S < 0.5 && c.C >= 0.7) return `Late starter, real finisher (on time ${s}, completion ${cc})`;
  if (a.missionsPlannedRate >= 0.8 && c.C < 0.4) return `Planner, not yet executor (${pct(a.missionsPlannedRate)} of blocks had a mission, completion ${cc})`;
  if (c.D < 0.5) return `Drifting (${fmtDur(a.drift.distractionMinutes)} of unplanned distraction against ${fmtDur(a.plannedFocusMinutes)} planned focus)`;
  return `Inconsistent (on time ${s}, completion ${cc})`;
}

const WEEKDAY = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function biggestLeak(a: Analytics): { text: string; hour: number | null; category: Category | null } {
  let best = { v: 0, wd: 0, h: 0 };
  a.drift.heat.forEach((row, wd) => row.forEach((v, h) => v > best.v && (best = { v, wd, h })));
  if (best.v === 0) return { text: 'No measurable leak this period.', hour: null, category: null };
  const hh = String(best.h).padStart(2, '0');
  return { text: `${fmtDur(best.v)} lost around ${hh}:00 on ${WEEKDAY[best.wd]}s (late starts and unplanned distraction).`, hour: best.h, category: null };
}

function suggestChange(a: Analytics, c: ReturnType<typeof components>): CoachVerdict['change'] {
  const lateFocus = [...a.planAccuracy.byCategory].sort((x, y) => x.ratio - y.ratio)[0]?.category;
  if (c.S < 0.6) {
    const cat: Category = lateFocus === 'founder' ? 'founder' : 'iit';
    return { cue: `IF the ${cat === 'iit' ? 'IIT' : 'Founder'} block starts THEN open the mission and turn Focus Guard on.`, trigger: { type: 'block_start', category: cat }, action: { type: 'focus' } };
  }
  if (c.D < 0.6) return { cue: 'IF I feel like opening YouTube during a focus block THEN save it to Later instead.', trigger: { type: 'urge' }, action: { type: 'save_later' } };
  if (c.C < 0.6) {
    const cat: Category = lateFocus === 'founder' ? 'founder' : 'iit';
    return { cue: `IF I miss more than 20 minutes of a ${cat === 'iit' ? 'study' : 'founder'} block THEN activate Rescue Mode.`, trigger: { type: 'block_missed', category: cat, minutes: 20 }, action: { type: 'rescue' } };
  }
  return { cue: 'IF a week goes to plan THEN keep the schedule unchanged — consistent context turns blocks into habits.' };
}

export function coachVerdict(doc: Doc, from: string, to: string, nowMs: number): CoachVerdict & { analytics: Analytics } {
  const a = analytics(doc, from, to, nowMs);
  const c = components(a);
  const score = scoreOf(c);
  const span = Math.round((new Date(`${to}T00:00:00`).getTime() - new Date(`${from}T00:00:00`).getTime()) / 86_400_000) + 1;
  const prevA = analytics(doc, addDays(from, -span), addDays(from, -1), nowMs);
  const prevScore = prevA.finishedFocus >= MIN_BLOCKS ? scoreOf(components(prevA)) : null;
  const grade = gradeOf(score, a.finishedFocus);
  const evidence = [
    `Started ${a.onTime.count} of ${a.finishedFocus} focus blocks on time (${pct(c.S)}).`,
    `Completed ${a.completion.done} and partly ${a.completion.partial} of ${a.finishedFocus} focus blocks (${pct(c.C)}); ${a.completion.unlogged} not logged.`,
    c.D <= c.A
      ? `${fmtDur(a.drift.distractionMinutes)} of unplanned distraction against ${fmtDur(a.plannedFocusMinutes)} of planned focus.`
      : `Anchors kept ${pct(c.A)} of the time (wake, devotion and study minimums).`,
  ];
  const strongest = [
    [c.S, `Started ${pct(c.S)} of focus blocks on time.`],
    [c.C, `Finished ${pct(c.C)} of what you planned.`],
    [c.A, `Kept your anchors ${pct(c.A)} of the time.`],
  ].sort((x, y) => (y[0] as number) - (x[0] as number))[0];
  return {
    grade,
    score,
    profile: grade === 'Not enough data' ? `Not enough data (${a.finishedFocus} finished focus blocks; 5 needed)` : profileOf(a, c, score, prevScore),
    evidence,
    components: c,
    leak: biggestLeak(a).text,
    change: suggestChange(a, c),
    ...((strongest[0] as number) >= 0.75 && grade !== 'Not enough data' ? { wentWell: strongest[1] as string } : {}),
    analytics: a,
  };
}

// ---------- coaching notes ----------

export interface CoachInput {
  wentWell?: string;
  leak?: string;
  change?: { cue: string; trigger?: RuleTrigger; action?: RuleAction };
  text?: string;
}

const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/** Save the week's coaching card. Grade, score, profile and evidence always come from the engine. */
export const postCoachingNote =
  (weekStart: string, input: CoachInput, source: 'engine' | 'mcp', client?: string, atMs?: number): Op<string> =>
  (d, now) => {
    const ws = weekKey(weekStart);
    if (input.text && wordCount(input.text) > 120) throw new OpError('too_long', 'The coaching text must be 120 words or fewer.');
    const v = coachVerdict(d, ws, addDays(ws, 6), atMs ?? now);
    const n = Object.values(d.coaching ?? {}).filter((c) => !c.del && c.period === ws).length + 1;
    const id = `${ws}:${n}`;
    const note: CoachingNote = {
      id,
      u: now,
      period: ws,
      grade: v.grade,
      score: v.score,
      profile: v.profile,
      evidence: v.evidence,
      ...(input.wentWell?.trim() ? { wentWell: input.wentWell.trim().slice(0, 300) } : v.wentWell && source === 'engine' ? { wentWell: v.wentWell } : {}),
      leak: (input.leak?.trim() || v.leak).slice(0, 400),
      change: input.change?.cue?.trim() ? { ...input.change, cue: input.change.cue.trim().slice(0, 300) } : v.change,
      ...(input.text?.trim() ? { text: input.text.trim() } : {}),
      source,
      ...(client ? { client } : {}),
      createdAt: now,
    };
    d.coaching[id] = note;
    return id;
  };

export function latestNote(doc: Doc, weekStart: string): CoachingNote | undefined {
  return Object.values(doc.coaching ?? {})
    .filter((c) => !c.del && c.period === weekKey(weekStart))
    .sort((a, b) => b.createdAt - a.createdAt)[0];
}
