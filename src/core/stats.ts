import { CATEGORY_META } from './defaults';
import { adherence, creditedMinutes, dayScore, liveBlocks, minutesForBlock, planFor, proofFor, sessionsFor } from './engine';
import type { Category, Doc } from './types';
import { MIN, WEEKDAYS, addDays, clockOf, fmtClock, fmtDur, parseKey, weekDays } from './time';

// Observe -> Measure -> Adjust. Deterministic statistics the weekly review is built from.
// The AI (when configured) only narrates these numbers; it never invents them.

export interface DayStat {
  date: string;
  adherence: number;
  counted: number;
  score: number;
  iit: number;
  founder: number;
  devotion: number;
  distraction: number;
  entertainmentPlanned: number;
  outcomesDone: number;
  outcomesTotal: number;
  rescued: boolean;
}

export interface SlotStat {
  key: string;
  category: Category;
  clock: number;
  label: string;
  scheduled: number;
  score: number; // sum of success values
  rate: number;
}

export interface WeekStats {
  weekStart: string;
  days: DayStat[];
  adherence: number;
  prevAdherence: number | null;
  iitRate: number;
  prevIitRate: number | null;
  founderMinutes: number;
  slots: SlotStat[];
  weekday: { day: string; rate: number; n: number }[];
  bestWindow: { start: number; end: number; minutes: number } | null;
  hourMinutes: number[]; // focus minutes per clock hour 0..23
  distractionMin: number;
  topDistraction: string | null;
  entertainmentPlanned: number;
  insights: string[];
  recommendation: string | null;
}

/** First day that counts for statistics: the onboarding day, or the earliest day with any record. */
export function trackingStart(doc: Doc): string | null {
  if (doc.settings.startedOn) return doc.settings.startedOn;
  const keys: string[] = [
    ...Object.values(doc.days).filter((d) => !d.del).map((d) => d.id),
    ...Object.values(doc.wake).filter((w) => !w.del).map((w) => w.id),
    ...Object.values(doc.sessions).filter((x) => !x.del).map((x) => x.date),
    ...Object.values(doc.proofs).filter((x) => !x.del).map((x) => x.date),
  ];
  return keys.length ? keys.sort()[0] : null;
}

export function dayStat(doc: Doc, date: string, nowMs: number): DayStat {
  const plan = planFor(doc, date);
  const adh = adherence(doc, date, nowMs);
  const dist = Object.values(doc.distractions).filter((d) => !d.del && d.date === date && d.kind === 'unplanned');
  return {
    date,
    adherence: adh.value,
    counted: adh.counted,
    score: dayScore(doc, date, nowMs).score,
    iit: creditedMinutes(doc, date, 'iit', nowMs),
    founder: creditedMinutes(doc, date, 'founder', nowMs),
    devotion: creditedMinutes(doc, date, 'devotion', nowMs),
    distraction: dist.reduce((a, d) => a + d.minutes, 0),
    entertainmentPlanned: liveBlocks(plan)
      .filter((b) => b.category === 'entertainment')
      .reduce((a, b) => a + (b.e - b.s), 0),
    outcomesDone: plan.outcomes.filter((o) => o.done).length,
    outcomesTotal: plan.outcomes.length,
    rescued: !!plan.rescue,
  };
}

function blockSuccess(doc: Doc, date: string, blockId: string, len: number, nowMs: number): number {
  const p = proofFor(doc, date, blockId);
  if (p?.status === 'done') return 1;
  if (p?.status === 'partial') return 0.5;
  const tracked = minutesForBlock(doc, date, blockId, nowMs);
  return Math.min(1, tracked / (len * 0.7));
}

function collect(doc: Doc, dates: string[], nowMs: number) {
  const slots = new Map<string, SlotStat>();
  const weekday = new Map<number, { sum: number; n: number }>();
  const hourMinutes = new Array(24).fill(0);
  let iitDone = 0;
  let iitTarget = 0;
  for (const date of dates) {
    const plan = planFor(doc, date);
    const ds = doc.settings.dayStart;
    for (const b of liveBlocks(plan)) {
      if (!b.focus) continue;
      const startAbs = parseKey(date).getTime() + (ds + b.s) * MIN;
      if (startAbs + (b.e - b.s) * MIN > nowMs) continue; // not finished yet
      const clock = clockOf(b.s, ds);
      const hourClock = Math.floor(clock / 60) * 60;
      const key = `${b.category}@${hourClock}`;
      const v = blockSuccess(doc, date, b.id, b.e - b.s, nowMs);
      const slot = slots.get(key) ?? {
        key,
        category: b.category,
        clock: hourClock,
        label: `${CATEGORY_META[b.category].short} at ${fmtClock(hourClock)}`,
        scheduled: 0,
        score: 0,
        rate: 0,
      };
      slot.scheduled++;
      slot.score += v;
      slots.set(key, slot);
      const wd = parseKey(date).getDay();
      const w = weekday.get(wd) ?? { sum: 0, n: 0 };
      w.sum += v;
      w.n++;
      weekday.set(wd, w);
    }
    for (const s of sessionsFor(doc, date)) {
      let t = s.start;
      const end = s.end ?? nowMs;
      while (t < end) {
        const d = new Date(t);
        const nextHour = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1).getTime();
        const slice = Math.min(end, nextHour) - t;
        hourMinutes[d.getHours()] += slice / MIN;
        t += slice;
      }
    }
    const startOfDay = parseKey(date).getTime() + ds * MIN;
    if (startOfDay < nowMs) {
      iitDone += creditedMinutes(doc, date, 'iit', nowMs);
      iitTarget += doc.settings.targets.iit ?? doc.settings.protect.iit ?? 120;
    }
  }
  for (const s of slots.values()) s.rate = s.scheduled ? s.score / s.scheduled : 0;
  return { slots, weekday, hourMinutes, iitRate: iitTarget ? Math.min(1, iitDone / iitTarget) : 0, hasData: iitTarget > 0 };
}

export function weekStats(doc: Doc, weekStart: string, nowMs: number): WeekStats {
  const start = trackingStart(doc) ?? '9999-12-31';
  const dates = weekDays(weekStart).filter((d) => d >= start && parseKey(d).getTime() + doc.settings.dayStart * MIN <= nowMs);
  const prevDates = weekDays(addDays(weekStart, -7)).filter((d) => d >= start);
  const days = dates.map((d) => dayStat(doc, d, nowMs));
  const cur = collect(doc, dates, nowMs);
  const prev = collect(doc, prevDates, nowMs);
  const prevDays = prevDates.map((d) => dayStat(doc, d, nowMs)).filter((d) => d.counted > 0);
  const counted = days.filter((d) => d.counted > 0);

  const adh = counted.length ? counted.reduce((a, d) => a + d.adherence, 0) / counted.length : 0;
  const prevAdh = prevDays.length ? prevDays.reduce((a, d) => a + d.adherence, 0) / prevDays.length : null;

  // best 3-hour window of tracked focus
  let bestWindow: WeekStats['bestWindow'] = null;
  for (let h = 0; h < 24; h++) {
    const minutes = cur.hourMinutes[h] + cur.hourMinutes[(h + 1) % 24] + cur.hourMinutes[(h + 2) % 24];
    if (minutes > 0 && (!bestWindow || minutes > bestWindow.minutes)) bestWindow = { start: h * 60, end: ((h + 3) % 24) * 60, minutes };
  }

  const distractions = Object.values(doc.distractions).filter((d) => !d.del && dates.includes(d.date) && d.kind === 'unplanned');
  const distractionMin = distractions.reduce((a, d) => a + d.minutes, 0);
  const bySource = new Map<string, number>();
  for (const d of distractions) bySource.set(d.source, (bySource.get(d.source) ?? 0) + d.minutes);
  const topDistraction = [...bySource.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  const slots = [...cur.slots.values()].sort((a, b) => a.clock - b.clock);
  const weekday = [...cur.weekday.entries()]
    .map(([wd, v]) => ({ day: WEEKDAYS[wd], rate: v.n ? v.sum / v.n : 0, n: v.n }))
    .sort((a, b) => b.rate - a.rate);

  // ---- insights ----
  const insights: string[] = [];
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  if (prev.hasData) insights.push(`IIT completion moved from ${pct(prev.iitRate)} → ${pct(cur.iitRate)}.`);
  else if (cur.hasData) insights.push(`IIT completion this week: ${pct(cur.iitRate)} of the daily target.`);
  const ranked = slots.filter((s) => s.scheduled >= 2).sort((a, b) => b.rate - a.rate);
  if (ranked.length) {
    const best = ranked[0];
    insights.push(`You completed ${pct(best.rate)} of ${best.label} sessions (${best.scheduled} scheduled).`);
    const worst = ranked.at(-1)!;
    if (worst !== best) insights.push(`Only ${pct(worst.rate)} of ${worst.label} sessions were completed.`);
  }
  if (distractionMin > 0)
    insights.push(`About ${fmtDur(distractionMin)} went to unplanned distraction${topDistraction ? `, mostly ${topDistraction}` : ''}.`);
  if (bestWindow) insights.push(`Your strongest work window was ${fmtClock(bestWindow.start)}–${fmtClock(bestWindow.end)}.`);
  if (weekday.length >= 3) {
    insights.push(`${weekday[0].day} had the highest completion (${pct(weekday[0].rate)}); ${weekday.at(-1)!.day} the lowest (${pct(weekday.at(-1)!.rate)}).`);
  }
  const rescues = days.filter((d) => d.rescued).length;
  if (rescues) insights.push(`Rescue Mode rebuilt ${rescues} day${rescues > 1 ? 's' : ''} instead of writing them off.`);

  // ---- one recommendation ----
  let recommendation: string | null = null;
  const weak = ranked.filter((s) => s.scheduled >= 3 && s.rate < 0.4).sort((a, b) => a.rate - b.rate)[0];
  if (weak) {
    recommendation = bestWindow
      ? `Move ${weak.label} — it succeeds only ${pct(weak.rate)}. Try placing it inside your strongest window (${fmtClock(bestWindow.start)}–${fmtClock(bestWindow.end)}).`
      : `Move ${weak.label} — it succeeds only ${pct(weak.rate)}. Try an earlier slot next week.`;
  } else if (distractionMin >= 120 && topDistraction) {
    recommendation = `Add friction to ${topDistraction}: keep it on the block list for every focus block and keep the phone out of reach for the first 20 minutes.`;
  } else if (cur.hasData && cur.iitRate < 0.7) {
    recommendation = 'Keep IIT at its slot, but make each IIT mission smaller: one assignment or one lecture per block.';
  } else if (counted.length >= 3) {
    recommendation = 'Keep the schedule unchanged next week — consistent context is what turns blocks into habits.';
  }

  return {
    weekStart,
    days,
    adherence: adh,
    prevAdherence: prevAdh,
    iitRate: cur.iitRate,
    prevIitRate: prev.hasData ? prev.iitRate : null,
    founderMinutes: days.reduce((a, d) => a + d.founder, 0),
    slots,
    weekday,
    bestWindow,
    hourMinutes: cur.hourMinutes,
    distractionMin,
    topDistraction,
    entertainmentPlanned: days.reduce((a, d) => a + d.entertainmentPlanned, 0),
    insights,
    recommendation,
  };
}

/** Rolling 30-day adherence, the health metric that replaces streaks. */
export function monthAdherence(doc: Doc, today: string, nowMs: number): { value: number; prev: number | null; days: number } {
  const start = trackingStart(doc) ?? '9999-12-31';
  const span = (from: number, to: number) => {
    const vals: number[] = [];
    for (let i = from; i < to; i++) {
      const key = addDays(today, -i);
      if (key < start) break;
      const a = adherence(doc, key, nowMs);
      if (a.counted > 0) vals.push(a.value);
    }
    return vals;
  };
  const cur = span(0, 30);
  const prev = span(30, 60);
  return {
    value: cur.length ? cur.reduce((a, b) => a + b, 0) / cur.length : 0,
    prev: prev.length ? prev.reduce((a, b) => a + b, 0) / prev.length : null,
    days: cur.length,
  };
}

/** Weekly entertainment balance: budget minus planned exceptions and unplanned distraction. */
export function entertainmentBalance(doc: Doc, weekStart: string, nowMs: number) {
  const dates = weekDays(weekStart);
  let planned = 0;
  let unplanned = 0;
  for (const date of dates) {
    const plan = doc.days[date];
    if (plan && !plan.del) planned += liveBlocks(plan).filter((b) => b.category === 'entertainment').reduce((a, b) => a + (b.e - b.s), 0);
  }
  for (const d of Object.values(doc.distractions)) if (!d.del && d.kind === 'unplanned' && dates.includes(d.date)) unplanned += d.minutes;
  const budget = doc.settings.entBudgetMin;
  return { budget, planned, unplanned, remaining: budget - planned - unplanned };
}
