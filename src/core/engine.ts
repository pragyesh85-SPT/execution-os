import { CATEGORY_META } from './defaults';
import type { BlockDef, Category, DayPlan, DayState, Doc, PlanBlock, Proof, Session } from './types';
import { DAY_MIN, MIN, dayStartMs, logicalDate, offsetFromClock, offsetOf } from './time';

// ---------- plans ----------

export function blocksFromTemplate(defs: BlockDef[], dayStart: number): PlanBlock[] {
  return defs
    .map((b) => {
      const s = offsetFromClock(b.start, dayStart);
      return {
        id: b.id,
        origin: b.id,
        title: b.title,
        category: b.category,
        s,
        e: Math.min(DAY_MIN, s + b.dur),
        fixed: b.fixed,
        focus: b.focus,
        minMinutes: b.minMinutes,
        priority: b.priority,
      } satisfies PlanBlock;
    })
    .sort((a, b) => a.s - b.s);
}

/** The plan for a date: the saved one, or a fresh copy of the template (not yet saved). */
export function planFor(doc: Doc, key: string): DayPlan {
  const saved = doc.days[key];
  if (saved && !saved.del) return saved;
  return {
    id: key,
    u: 0,
    blocks: blocksFromTemplate(doc.template.blocks, doc.settings.dayStart),
    missions: {},
    outcomes: [],
  };
}

export function liveBlocks(plan: DayPlan): PlanBlock[] {
  return plan.blocks.filter((b) => !b.missed).sort((a, b) => a.s - b.s);
}

export function blockAt(plan: DayPlan, offset: number): PlanBlock | undefined {
  return liveBlocks(plan).find((b) => offset >= b.s && offset < b.e);
}

export function nextBlocks(plan: DayPlan, offset: number, n = 3): PlanBlock[] {
  return liveBlocks(plan)
    .filter((b) => b.s > offset)
    .slice(0, n);
}

export function missionFor(plan: DayPlan, block: PlanBlock) {
  return plan.missions[block.id] ?? (block.origin ? plan.missions[block.origin] : undefined);
}

// ---------- sessions & proof ----------

export function sessionsFor(doc: Doc, date: string): Session[] {
  return Object.values(doc.sessions).filter((s) => !s.del && s.date === date);
}

export function activeSession(doc: Doc): Session | undefined {
  return Object.values(doc.sessions).find((s) => !s.del && s.end === undefined);
}

export function sessionMinutes(s: Session, nowMs: number): number {
  return Math.max(0, ((s.end ?? nowMs) - s.start) / MIN);
}

export function minutesForBlock(doc: Doc, date: string, blockId: string, nowMs: number): number {
  return sessionsFor(doc, date)
    .filter((s) => s.blockId === blockId)
    .reduce((acc, s) => acc + sessionMinutes(s, nowMs), 0);
}

export function minutesForCategory(doc: Doc, date: string, category: Category, nowMs: number): number {
  return sessionsFor(doc, date)
    .filter((s) => s.category === category)
    .reduce((acc, s) => acc + sessionMinutes(s, nowMs), 0);
}

export function proofFor(doc: Doc, date: string, blockId: string): Proof | undefined {
  const p = doc.proofs[`${date}:${blockId}`];
  return p && !p.del ? p : undefined;
}

/** Credited minutes for a category: tracked sessions, plus full block length for blocks marked done without a timer. */
export function creditedMinutes(doc: Doc, date: string, category: Category, nowMs: number): number {
  const plan = planFor(doc, date);
  let total = 0;
  for (const b of liveBlocks(plan).filter((x) => x.category === category)) {
    const tracked = minutesForBlock(doc, date, b.id, nowMs);
    const proof = proofFor(doc, date, b.id);
    let credit = tracked;
    if (tracked < 1 && proof) {
      credit = proof.status === 'done' ? b.e - b.s : proof.status === 'partial' ? (b.e - b.s) / 2 : 0;
    }
    total += credit;
  }
  // sessions on blocks that no longer exist in the plan (e.g. before a rescue) still count
  const known = new Set(plan.blocks.map((b) => b.id));
  total += sessionsFor(doc, date)
    .filter((s) => s.category === category && !known.has(s.blockId))
    .reduce((acc, s) => acc + sessionMinutes(s, nowMs), 0);
  return total;
}

// ---------- day status (ON TRACK / DRIFTING / RESCUE) ----------

export interface StatusInfo {
  state: DayState;
  title: string;
  detail: string;
  lateMin: number;
  block?: PlanBlock;
  reason?: 'wake' | 'not_started' | 'missed_protected';
}

export function wakeVerified(doc: Doc, date: string): boolean {
  const w = doc.wake[date];
  return !!w && !w.del;
}

/** Is the wake checkpoint ringing right now? */
export function wakeDue(doc: Doc, nowMs: number): { due: boolean; date: string; lateMin: number } {
  const { settings } = doc;
  const date = logicalDate(nowMs, settings.dayStart);
  if (!settings.wakeGate) return { due: false, date, lateMin: 0 };
  const off = offsetOf(nowMs, date, settings.dayStart);
  // Only ring during the first 6 hours of the day; after that the morning is handled by Rescue Mode.
  if (wakeVerified(doc, date) || off < 0 || off > 360) return { due: false, date, lateMin: 0 };
  return { due: true, date, lateMin: Math.max(0, Math.floor(off)) };
}

export function dayStatus(doc: Doc, nowMs: number): StatusInfo {
  const { settings } = doc;
  const date = logicalDate(nowMs, settings.dayStart);
  const plan = planFor(doc, date);
  const off = offsetOf(nowMs, date, settings.dayStart);
  const rescuedAt = plan.rescue?.at ?? 0;
  const dismissedAt = plan.dismissedRescueAt ?? 0;
  const lastAck = Math.max(rescuedAt, dismissedAt);
  const current = blockAt(plan, off);

  // 1. Morning wake checkpoint missed.
  const wake = wakeDue(doc, nowMs);
  if (wake.due && wake.lateMin > settings.rescueMin && lastAck < dayStartMs(date, settings.dayStart)) {
    return {
      state: 'rescue',
      title: `Morning missed by ${fmtShort(wake.lateMin)}`,
      detail: 'Verify you are awake, then rebuild the rest of the day.',
      lateMin: wake.lateMin,
      reason: 'wake',
    };
  }

  // 2. Current focus block not started.
  if (current && current.focus && !activeSession(doc)) {
    const started = minutesForBlock(doc, date, current.id, nowMs) > 0 || !!proofFor(doc, date, current.id);
    const late = Math.floor(off - current.s);
    const blockStartAbs = dayStartMs(date, settings.dayStart) + current.s * MIN;
    if (!started && late >= settings.driftMin && lastAck < blockStartAbs) {
      const label = CATEGORY_META[current.category].short;
      if (late >= settings.rescueMin) {
        return {
          state: 'rescue',
          title: `${label} block missed by ${fmtShort(late)}`,
          detail: 'Start now, or let Rescue Mode rebuild the remaining day.',
          lateMin: late,
          block: current,
          reason: 'not_started',
        };
      }
      return {
        state: 'drifting',
        title: `${label} block started ${late} minutes ago`,
        detail: 'Start the planned mission or reschedule it.',
        lateMin: late,
        block: current,
        reason: 'not_started',
      };
    }
  }

  // 3. A protected category finished the day short (e.g. IIT block passed untouched).
  for (const [cat, min] of Object.entries(settings.protect) as [Category, number][]) {
    if (!min) continue;
    const blocks = liveBlocks(plan).filter((b) => b.category === cat);
    if (!blocks.length) continue;
    const futureMin = blocks.filter((b) => b.e > off).reduce((a, b) => a + (b.e - Math.max(b.s, off)), 0);
    const done = creditedMinutes(doc, date, cat, nowMs);
    const lastMissed = blocks.filter((b) => b.e <= off).at(-1);
    if (lastMissed && done + futureMin < min - 5) {
      const missedAbs = dayStartMs(date, settings.dayStart) + lastMissed.e * MIN;
      if (lastAck < missedAbs) {
        return {
          state: 'rescue',
          title: `${CATEGORY_META[cat].short} minimum at risk`,
          detail: `${fmtShort(done)} done of a protected ${fmtShort(min)}. Rebuild the day to fit it back in.`,
          lateMin: Math.round(min - done - futureMin),
          block: lastMissed,
          reason: 'missed_protected',
        };
      }
    }
  }

  const a = activeSession(doc);
  return {
    state: 'on_track',
    title: a ? 'In focus' : 'On track',
    detail: plan.rescue ? 'Running on a rescued plan.' : 'No intervention needed.',
    lateMin: 0,
    block: current,
  };
}

function fmtShort(min: number): string {
  const m = Math.max(0, Math.round(min));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (!h) return `${r}m`;
  return r ? `${h}h ${r}m` : `${h}h`;
}

// ---------- day score ----------

export interface ScoreRow {
  category: Category;
  label: string;
  done: number; // minutes
  target: number; // minutes for the full day
  expected: number; // minutes expected by now
  state: 'done' | 'partial' | 'pending' | 'missed';
}

export interface DayScore {
  score: number; // 0..100
  rows: ScoreRow[];
  wake: 'done' | 'late' | 'pending' | 'off';
}

export function dayScore(doc: Doc, date: string, nowMs: number): DayScore {
  const { settings } = doc;
  const plan = planFor(doc, date);
  const off = Math.min(DAY_MIN, offsetOf(nowMs, date, settings.dayStart));
  const cats: Category[] = ['devotion', 'iit', 'founder', 'care'];
  const weights: Record<string, number> = { devotion: 20, iit: 30, founder: 25, care: 10, wake: 15 };
  const rows: ScoreRow[] = [];
  let earned = 0;
  let possible = 0;

  for (const cat of cats) {
    const blocks = liveBlocks(plan).filter((b) => b.category === cat);
    const scheduled = blocks.reduce((a, b) => a + (b.e - b.s), 0);
    const target = settings.targets[cat] ?? scheduled;
    if (!target && !scheduled) continue;
    const elapsed = blocks.reduce((a, b) => a + Math.max(0, Math.min(b.e, off) - b.s), 0);
    const expected = scheduled ? (target * elapsed) / scheduled : 0;
    const done = creditedMinutes(doc, date, cat, nowMs);
    let state: ScoreRow['state'] = 'pending';
    if (done >= target - 1) state = 'done';
    else if (done > 0) state = 'partial';
    else if (expected > 0 && elapsed >= scheduled) state = 'missed';
    rows.push({ category: cat, label: CATEGORY_META[cat].label, done, target, expected, state });
    if (expected > 0) {
      earned += weights[cat] * Math.min(1, done / expected);
      possible += weights[cat];
    }
  }

  let wake: DayScore['wake'] = 'off';
  if (settings.wakeGate) {
    const w = doc.wake[date];
    if (w && !w.del) {
      wake = w.lateMin <= settings.wakeGraceMin ? 'done' : 'late';
      const credit = w.lateMin <= settings.wakeGraceMin ? 1 : Math.max(0, 1 - w.lateMin / 180);
      earned += weights.wake * credit;
      possible += weights.wake;
    } else if (off > settings.wakeGraceMin) {
      wake = off > 360 ? 'late' : 'pending';
      possible += weights.wake;
    } else {
      wake = 'pending';
    }
  }

  const score = possible ? Math.round((earned / possible) * 100) : 100;
  return { score, rows, wake };
}

// ---------- focus guard ----------

export interface FocusState {
  active: boolean;
  date: string;
  block?: PlanBlock;
  until?: number; // ms
  pausedUntil?: number;
  blocked: string[];
  allowed: string[];
  keywords: string[];
  mission?: string;
}

export function focusState(doc: Doc, nowMs: number): FocusState {
  const { settings } = doc;
  const date = logicalDate(nowMs, settings.dayStart);
  const plan = planFor(doc, date);
  const off = offsetOf(nowMs, date, settings.dayStart);
  const b = blockAt(plan, off);
  const paused = plan.guardPausedUntil && plan.guardPausedUntil > nowMs ? plan.guardPausedUntil : undefined;
  const session = activeSession(doc);
  const inFocusBlock = !!b && b.focus;
  const active = (inFocusBlock || !!session) && !paused && !(b && b.category === 'entertainment');
  return {
    active,
    date,
    block: b,
    until: b ? dayStartMs(date, settings.dayStart) + b.e * MIN : undefined,
    pausedUntil: paused,
    blocked: settings.focusBlock,
    allowed: settings.focusAllow,
    keywords: settings.focusKeywords,
    mission: b ? missionFor(plan, b)?.title : undefined,
  };
}

// ---------- adherence ----------

/** Share of finished, meaningful blocks that were actually executed. No streaks, no punishment. */
export function adherence(doc: Doc, date: string, nowMs: number): { value: number; counted: number } {
  const plan = planFor(doc, date);
  const off = offsetOf(nowMs, date, doc.settings.dayStart);
  const relevant = liveBlocks(plan).filter(
    (b) => b.e <= off && !['sleep', 'rest', 'buffer', 'meal', 'entertainment'].includes(b.category),
  );
  if (!relevant.length) return { value: 0, counted: 0 };
  let sum = 0;
  for (const b of relevant) {
    const p = proofFor(doc, date, b.id);
    const tracked = minutesForBlock(doc, date, b.id, nowMs);
    const len = b.e - b.s;
    let v = 0;
    if (p?.status === 'done') v = 1;
    else if (p?.status === 'partial') v = 0.5;
    else if (tracked > 0) v = Math.min(1, tracked / (len * 0.7));
    sum += v;
  }
  return { value: sum / relevant.length, counted: relevant.length };
}
