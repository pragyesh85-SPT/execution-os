import { creditedMinutes, liveBlocks, missionFor, planFor, proofFor, sessionsFor } from './engine';
import type { Category, Doc, PlanBlock, RescueReason } from './types';
import { addDays, dayStartMs, MIN, logicalDate, parseKey, weekKey } from './time';
import { trackingStart } from './stats';

// Plan versus reality, deterministic. Every number on the Insights tab comes from here (and is unit
// tested); the AI only narrates it. Rolling lines, never "chains" or streaks.

export interface FocusRow {
  date: string;
  block: PlanBlock;
  planned: number; // minutes
  tracked: number;
  credited: number; // tracked, or the block (or its done share) when logged without a timer
  firstStartLate: number | null; // minutes after block start the first session began (null = never started)
  status: 'done' | 'partial' | 'none' | 'unlogged';
  hasMission: boolean;
  estimate?: number;
}

export interface Analytics {
  from: string;
  to: string;
  days: number; // days counted (from the first tracked day, up to today)
  finishedFocus: number;
  deepWorkHours: number;
  onTime: { count: number; rate: number };
  completion: { done: number; partial: number; none: number; unlogged: number; rate: number }; // rate = (done + .5 partial) / finished
  drift: { lateMinutes: number; distractionMinutes: number; total: number; heat: number[][] }; // heat[weekday Mon=0][hour]
  rescues: { count: number; perWeek: number; reasons: Record<RescueReason, number> };
  planAccuracy: { byCategory: { category: Category; planned: number; actual: number; ratio: number }[]; estimateRatio: number | null };
  anchors: { wakeOnTime: number | null; devotionMet: number | null; studyMet: number | null; mean: number | null };
  entertainment: { planned: number; unplanned: number; budget: number };
  focus: { avgSession: number; longestSession: number; sessions: number };
  missionsPlannedRate: number; // share of finished focus blocks that had a mission
  plannedFocusMinutes: number;
  overrides: { swap: number; borrow: number; drift: number }; // "I'm doing something else", by kind
  daily: { date: string; deepWorkHours: number; completion: number | null; onTime: number | null }[];
}

const ON_TIME_MIN = 5;

/** Every finished focus block in the range with what actually happened. */
export function focusRows(doc: Doc, from: string, to: string, nowMs: number): FocusRow[] {
  const ds = doc.settings.dayStart;
  const rows: FocusRow[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    const plan = planFor(doc, date);
    const sessions = sessionsFor(doc, date);
    const base = dayStartMs(date, ds);
    for (const b of liveBlocks(plan)) {
      if (!b.focus || base + b.e * MIN > nowMs) continue;
      const mine = sessions.filter((s) => s.blockId === b.id).sort((a, c) => a.start - c.start);
      const tracked = mine.reduce((a, s) => a + Math.max(0, ((s.end ?? nowMs) - s.start) / MIN), 0);
      const proof = proofFor(doc, date, b.id);
      const len = b.e - b.s;
      let credited = tracked;
      if (tracked < 1 && proof) credited = proof.status === 'done' ? len : proof.status === 'partial' ? (len * (proof.percent ?? 50)) / 100 : 0;
      const first = mine[0];
      const m = missionFor(plan, b);
      rows.push({
        date,
        block: b,
        planned: len,
        tracked,
        credited,
        firstStartLate: first ? Math.max(0, (first.start - (base + b.s * MIN)) / MIN) : null,
        status: proof ? proof.status : 'unlogged',
        hasMission: !!m,
        ...(m?.estimate ? { estimate: m.estimate } : {}),
      });
    }
  }
  return rows;
}

export function analytics(doc: Doc, fromIn: string, toIn: string, nowMs: number): Analytics {
  const { settings } = doc;
  const ds = settings.dayStart;
  const todayKey = logicalDate(nowMs, ds);
  const start = trackingStart(doc);
  const from = start && start > fromIn ? start : fromIn;
  const to = toIn > todayKey ? todayKey : toIn;
  const rows = from <= to ? focusRows(doc, from, to, nowMs) : [];
  const dates: string[] = [];
  for (let d = from; d <= to && dates.length < 400; d = addDays(d, 1)) dates.push(d);
  const finished = rows.length;

  const logged = rows.filter((r) => r.status === 'done' || r.status === 'partial');
  const deepWorkHours = logged.reduce((a, r) => a + r.credited, 0) / 60;
  const onTimeCount = rows.filter((r) => r.firstStartLate !== null && r.firstStartLate <= ON_TIME_MIN).length;
  const done = rows.filter((r) => r.status === 'done').length;
  const partial = rows.filter((r) => r.status === 'partial').length;
  const none = rows.filter((r) => r.status === 'none').length;
  const unlogged = rows.filter((r) => r.status === 'unlogged').length;

  // drift: late starts (never started = whole block) + unplanned distraction, by weekday × hour
  const heat = Array.from({ length: 7 }, () => new Array(24).fill(0) as number[]);
  let lateMinutes = 0;
  for (const r of rows) {
    const late = r.firstStartLate === null ? r.planned : Math.min(r.planned, r.firstStartLate);
    lateMinutes += late;
    const at = new Date(dayStartMs(r.date, ds) + r.block.s * MIN);
    heat[(at.getDay() + 6) % 7][at.getHours()] += late;
  }
  const inRange = new Set(dates);
  const distractions = Object.values(doc.distractions).filter((x) => !x.del && x.kind === 'unplanned' && inRange.has(x.date));
  const distractionMinutes = distractions.reduce((a, x) => a + x.minutes, 0);
  for (const x of distractions) {
    const at = new Date(x.at);
    heat[(at.getDay() + 6) % 7][at.getHours()] += x.minutes;
  }

  // rescues
  const reasons: Record<RescueReason, number> = { wake: 0, not_started: 0, missed_protected: 0, manual: 0 };
  let rescueCount = 0;
  for (const d of dates) {
    const p = doc.days[d];
    if (!p || p.del) continue;
    const list = p.rescues ?? (p.rescue ? [p.rescue] : []);
    for (const r of list) {
      rescueCount++;
      reasons[r.reason ?? 'manual']++;
    }
  }
  const weeks = Math.max(1, dates.length / 7);

  // plan accuracy
  const cats = [...new Set(rows.map((r) => r.block.category))];
  const byCategory = cats.map((category) => {
    const rs = rows.filter((r) => r.block.category === category);
    const planned = rs.reduce((a, r) => a + r.planned, 0);
    const actual = rs.reduce((a, r) => a + r.credited, 0);
    return { category, planned, actual: Math.round(actual), ratio: planned ? actual / planned : 0 };
  });
  const est = rows.filter((r) => r.estimate && r.tracked > 0);
  const estimateRatio = est.length ? est.reduce((a, r) => a + r.tracked / (r.estimate as number), 0) / est.length : null;

  // anchors
  let wakeDays = 0;
  let wakeOk = 0;
  let devDays = 0;
  let devOk = 0;
  let studyDays = 0;
  let studyOk = 0;
  for (const d of dates) {
    if (dayStartMs(addDays(d, 1), ds) > nowMs && d === todayKey) continue; // today is not finished
    if (settings.wakeGate) {
      wakeDays++;
      const w = doc.wake[d];
      if (w && !w.del && w.method !== 'bypass' && w.lateMin <= settings.wakeGraceMin) wakeOk++;
    }
    if (settings.protect.devotion) {
      devDays++;
      if (creditedMinutes(doc, d, 'devotion', nowMs) >= settings.protect.devotion - 5) devOk++;
    }
    if (settings.protect.iit) {
      studyDays++;
      if (creditedMinutes(doc, d, 'iit', nowMs) >= settings.protect.iit - 5) studyOk++;
    }
  }
  const comp = [wakeDays ? wakeOk / wakeDays : null, devDays ? devOk / devDays : null, studyDays ? studyOk / studyDays : null];
  const present = comp.filter((x): x is number => x !== null);

  // entertainment
  let entPlanned = 0;
  for (const d of dates) {
    const p = doc.days[d];
    if (p && !p.del) entPlanned += liveBlocks(p).filter((b) => b.category === 'entertainment').reduce((a, b) => a + (b.e - b.s), 0);
  }

  // quick overrides
  const overrides = { swap: 0, borrow: 0, drift: 0 };
  for (const d of dates) {
    const p = doc.days[d];
    if (p && !p.del) for (const o of p.overrides ?? []) overrides[o.kind]++;
  }

  // focus quality
  const sessions = Object.values(doc.sessions).filter((s) => !s.del && inRange.has(s.date) && s.end !== undefined);
  const lens = sessions.map((s) => ((s.end as number) - s.start) / MIN).filter((m) => m >= 1);

  const daily = dates.map((date) => {
    const rs = rows.filter((r) => r.date === date);
    const lg = rs.filter((r) => r.status === 'done' || r.status === 'partial');
    return {
      date,
      deepWorkHours: lg.reduce((a, r) => a + r.credited, 0) / 60,
      completion: rs.length ? (rs.filter((r) => r.status === 'done').length + 0.5 * rs.filter((r) => r.status === 'partial').length) / rs.length : null,
      onTime: rs.length ? rs.filter((r) => r.firstStartLate !== null && r.firstStartLate <= ON_TIME_MIN).length / rs.length : null,
    };
  });

  return {
    from,
    to,
    days: dates.length,
    finishedFocus: finished,
    deepWorkHours,
    onTime: { count: onTimeCount, rate: finished ? onTimeCount / finished : 0 },
    completion: { done, partial, none, unlogged, rate: finished ? (done + 0.5 * partial) / finished : 0 },
    drift: { lateMinutes: Math.round(lateMinutes), distractionMinutes, total: Math.round(lateMinutes + distractionMinutes), heat },
    rescues: { count: rescueCount, perWeek: rescueCount / weeks, reasons },
    planAccuracy: { byCategory, estimateRatio },
    anchors: { wakeOnTime: comp[0], devotionMet: comp[1], studyMet: comp[2], mean: present.length ? present.reduce((a, b) => a + b, 0) / present.length : null },
    entertainment: { planned: entPlanned, unplanned: distractionMinutes, budget: Math.round(settings.entBudgetMin * weeks) },
    focus: { avgSession: lens.length ? lens.reduce((a, b) => a + b, 0) / lens.length : 0, longestSession: lens.length ? Math.max(...lens) : 0, sessions: lens.length },
    missionsPlannedRate: finished ? rows.filter((r) => r.hasMission).length / finished : 0,
    plannedFocusMinutes: rows.reduce((a, r) => a + r.planned, 0),
    overrides,
    daily,
  };
}

/** Rolling mean over the last n days of a daily series (null-safe). Trends, never chains. */
export function rolling(values: (number | null)[], n = 7): (number | null)[] {
  return values.map((_, i) => {
    const w = values.slice(Math.max(0, i - n + 1), i + 1).filter((v): v is number => v !== null);
    return w.length ? w.reduce((a, b) => a + b, 0) / w.length : null;
  });
}

export const weekRange = (date: string): [string, string] => [weekKey(date), addDays(weekKey(date), 6)];
export const lastNDays = (today: string, n: number): [string, string] => [addDays(today, -(n - 1)), today];
export const weekdayIndex = (date: string) => (parseKey(date).getDay() + 6) % 7;
