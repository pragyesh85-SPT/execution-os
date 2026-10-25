import { CATEGORY_META } from './defaults';
import { activeSession, creditedMinutes, liveBlocks, minutesForBlock, missionFor, planFor, proofFor } from './engine';
import { openTasks, taskValue } from './planner';
import type { Area, Category, Doc, Mission, PlanBlock, RescueStrategy } from './types';
import { DAY_MIN, addDays, clockOf, fmtClock, fmtDur, offsetOf, shortDate, weekKey } from './time';

// Rescue Mode: never carry lateness forward block by block.
// Instead, take everything that is still undone, keep the time-anchored blocks where they are,
// protect the daily minimums, compress the low-priority work and pack a feasible rest-of-day.
//
// v2 builds on the same algorithm:
// - pinned blocks are fixed like anchors and are asserted to come out untouched;
// - strategies only change priorities and minimums, never the times of fixed blocks;
// - with history, priority-1 focus work goes into the hours where it usually succeeds;
// - every change carries a one-sentence reason; alternatives and a week scope are offered.
// With no pins, the balanced strategy and no history, the result is exactly v1's.

export interface RescueChange {
  category: Category;
  before: number;
  after: number;
}

export type RescueLineKind = 'kept' | 'moved' | 'shortened' | 'split' | 'dropped' | 'added';

export interface RescueChangeLine {
  kind: RescueLineKind;
  blockId: string;
  title: string;
  from?: [number, number];
  to?: [number, number];
  reason: string; // one human sentence
}

export interface RescueHint {
  blockId: string;
  priority?: number;
  missionTitle?: string;
}

export interface RescueOptions {
  lateWakeMin?: number;
  strategy?: RescueStrategy; // default 'balanced' = v1 behaviour
  slotRates?: Record<string, number>; // `${category}@${clockHour}` -> success rate 0..1 (see stats.slotRates)
  hints?: RescueHint[]; // from AI, validated here: may only change priorities or mission titles
}

export interface RescueResult {
  blocks: PlanBlock[];
  summary: string[];
  dropped: PlanBlock[];
  reduced: PlanBlock[];
  changes: RescueChange[];
  feasible: boolean;
  from: number; // offset the rescue starts at
  lines: RescueChangeLine[];
  strategy: RescueStrategy;
  pinnedCount: number;
  freeMinutes: number;
  headline?: string;
  missions?: Record<string, Mission>; // mission title changes from validated hints, keyed by block id
}

export const STRATEGY_LABEL: Record<RescueStrategy, string> = {
  balanced: 'Balanced',
  protect_study: 'Protect study',
  ship: 'Ship the deliverable',
  light: 'Light day',
};

interface PoolItem {
  block: PlanBlock;
  dur: number;
  min: number;
  order: number;
  prio: number; // working priority (strategies and hints change this, never the stored block)
  recovered: boolean;
  protectedCat: boolean;
  extra?: 'rest';
  fit?: { rate: number };
}

const SNAP = 5;
const MIN_CHUNK = 15;
const FIT_MIN = 0.5; // only hours where this work succeeds at least half the time attract it
const snapUp = (m: number) => Math.ceil(m / SNAP) * SNAP;
const snapDown = (m: number) => Math.floor(m / SNAP) * SNAP;

const areaOf = (c: Category): Area => (c === 'iit' ? 'iit' : c === 'founder' ? 'founder' : 'personal');

/** Value of the mission in a block, from the task it came from (planner taskValue). */
function missionValue(doc: Doc, date: string, m: Mission | undefined): number {
  if (!m) return -1;
  const tasks = openTasks(doc);
  const linked = tasks.find((t) => m.taskIds?.includes(t.id)) ?? tasks.find((t) => t.title.trim().toLowerCase() === m.title.trim().toLowerCase());
  return linked ? taskValue(linked, date) : 0;
}

export function buildRescue(doc: Doc, date: string, nowMs: number, opts: RescueOptions = {}): RescueResult {
  const { settings } = doc;
  const strategy: RescueStrategy = opts.strategy ?? 'balanced';
  const ds = settings.dayStart;
  const plan = planFor(doc, date);
  // Start the rebuilt day at the current 5-minute mark so there is never an uncovered gap before it.
  const t = Math.min(DAY_MIN, Math.max(0, snapDown(offsetOf(nowMs, date, ds))));
  const all = liveBlocks(plan);
  const running = activeSession(doc);
  const clock = (off: number) => fmtClock(clockOf(off, ds), true);
  const span = (s: number, e: number) => `${clock(s)}–${clock(e)}`;

  // Strategy-adjusted protected minimums (strategies never touch fixed blocks).
  const protect = { ...settings.protect };
  if (strategy === 'protect_study') protect.iit = Math.max(protect.iit ?? 0, settings.targets.iit ?? 0);

  const kept: PlanBlock[] = []; // stays exactly where it is
  const keptWhy = new Map<string, 'history' | 'pinned' | 'anchor' | 'started'>();
  const ghosts: PlanBlock[] = plan.blocks.filter((b) => b.missed);
  const pool: PoolItem[] = [];
  let order = 0;

  for (const b of all) {
    if (b.e <= t) {
      kept.push(b); // history
      keptWhy.set(b.id, 'history');
      continue;
    }
    const isCurrent = b.s < t;
    const tracked = minutesForBlock(doc, date, b.id, nowMs);
    const proof = proofFor(doc, date, b.id);
    const touched = tracked > 0 || (running && running.blockId === b.id) || !!proof;
    if (b.fixed || (isCurrent && touched)) {
      kept.push(b);
      keptWhy.set(b.id, b.pinned ? 'pinned' : b.fixed ? 'anchor' : 'started');
      continue;
    }
    if (isCurrent && t - b.s >= SNAP) {
      ghosts.push({ ...b, id: `${b.id}~missed`, e: t, missed: true });
    }
    pool.push({
      block: b,
      dur: b.e - b.s,
      min: Math.min(b.minMinutes, b.e - b.s),
      order: order++,
      prio: b.priority,
      recovered: false,
      protectedCat: !!protect[b.category],
    });
  }

  // ---- strategies: priorities and minimums only ----
  if (strategy === 'protect_study') {
    for (const p of pool) if (p.block.category === 'iit' && p.block.focus) p.prio = 1;
  } else if (strategy === 'ship') {
    let best: PoolItem | undefined;
    let bestV = -1;
    for (const p of pool) {
      if (!p.block.focus) continue;
      const v = missionValue(doc, date, missionFor(plan, p.block));
      if (v > bestV) {
        bestV = v;
        best = p;
      }
    }
    if (best && bestV >= 0) {
      best.prio = 1;
      best.order = -0.5; // straight after recovered minimums, before everything else
      // Study may fall to its protected minimum to make room.
      for (const p of pool) if (p !== best && p.block.category === 'iit') p.prio = Math.max(p.prio, 2);
    }
  } else if (strategy === 'light') {
    for (const p of pool) if (p.block.category === 'founder' || p.block.category === 'care') p.min = snapDown(p.min / 2);
  }

  // ---- AI hints: validated, priorities and mission titles only ----
  const hintMissions: Record<string, Mission> = {};
  for (const h of opts.hints ?? []) {
    const p = pool.find((x) => x.block.id === h.blockId);
    if (!p) continue;
    if (typeof h.priority === 'number' && Number.isInteger(h.priority) && h.priority >= 1 && h.priority <= 5) p.prio = h.priority;
    if (typeof h.missionTitle === 'string' && h.missionTitle.trim()) {
      const m = missionFor(plan, p.block);
      hintMissions[p.block.id] = { ...(m ?? { steps: [] }), title: h.missionTitle.trim().slice(0, 200), source: 'ai' };
    }
  }

  // Protected minimums that the remaining plan no longer covers (e.g. the IIT block already passed).
  for (const [cat, protectMin] of Object.entries(protect) as [Category, number][]) {
    if (!protectMin) continue;
    const done = creditedMinutes(doc, date, cat, nowMs);
    const keptFuture = kept
      .filter((b) => b.category === cat && b.e > t)
      .reduce((a, b) => a + (b.e - Math.max(b.s, t)), 0);
    const pooled = pool.filter((p) => p.block.category === cat).reduce((a, p) => a + p.dur, 0);
    const need = snapUp(protectMin - done - keptFuture - pooled);
    if (need >= MIN_CHUNK) {
      const template = all.find((b) => b.category === cat);
      pool.push({
        block: {
          id: `r-${cat}-${nowMs.toString(36)}`,
          origin: template?.origin ?? template?.id,
          title: `${CATEGORY_META[cat].label} — recovered`,
          category: cat,
          s: t,
          e: t + need,
          fixed: false,
          focus: template?.focus ?? (cat === 'iit' || cat === 'founder'),
          minMinutes: need,
          priority: 1,
          rescued: true,
        },
        dur: need,
        min: need,
        order: -1,
        prio: 1,
        recovered: true,
        protectedCat: true,
      });
    }
  }

  if (strategy === 'light') {
    const firstFocus = pool.filter((p) => p.block.focus && !p.recovered).sort((a, b) => a.order - b.order)[0];
    pool.push({
      block: {
        id: `r-rest-${nowMs.toString(36)}`,
        title: 'Rest — light day',
        category: 'rest',
        s: t,
        e: t + 30,
        fixed: false,
        focus: false,
        minMinutes: 30,
        priority: 5,
        rescued: true,
        source: 'rescue',
      },
      dur: 30,
      min: 30,
      order: firstFocus ? firstFocus.order + 0.5 : order + 1,
      prio: 5,
      recovered: false,
      protectedCat: false,
      extra: 'rest',
    });
  }

  // Free windows between kept blocks, from t to the end of the day.
  const occupied = kept
    .filter((b) => b.e > t)
    .map((b) => [Math.max(b.s, t), b.e] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const windows: [number, number][] = [];
  let cursor = t;
  for (const [s, e] of occupied) {
    if (s > cursor) windows.push([cursor, s]);
    cursor = Math.max(cursor, e);
  }
  if (cursor < DAY_MIN) windows.push([cursor, DAY_MIN]);
  const capacity = windows.reduce((a, [s, e]) => a + (e - s), 0);
  const protectedNeed = pool.filter((p) => p.protectedCat).reduce((a, p) => a + p.min, 0);
  const workNeed = pool.reduce((a, p) => a + p.dur, 0);

  // Compress: lowest priority first, then the block with the most slack.
  const original = new Map(pool.map((p) => [p.block.id, p.dur]));
  let over = pool.reduce((a, p) => a + p.dur, 0) - capacity;
  let feasible = true;
  if (over > 0) {
    const byCut = [...pool].sort((a, b) => b.prio - a.prio || b.dur - b.min - (a.dur - a.min));
    for (const p of byCut) {
      if (over <= 0) break;
      const cut = Math.min(over, p.dur - p.min);
      p.dur -= cut;
      over -= cut;
    }
  }
  if (over > 0) {
    const byDrop = [...pool].filter((p) => !p.protectedCat).sort((a, b) => b.prio - a.prio || a.order - b.order);
    // Cut below the minimum only as much as needed — never drop a whole block to free 10 minutes.
    for (const p of byDrop) {
      if (over <= 0) break;
      const cut = Math.min(p.dur, over);
      p.dur -= cut;
      over -= cut;
      if (p.dur < MIN_CHUNK) p.dur = 0; // a 10-minute sliver is not a block; the time becomes buffer
    }
  }
  if (over > 0) {
    feasible = false;
    const remaining = pool.reduce((a, p) => a + p.dur, 0);
    const factor = remaining ? capacity / remaining : 0;
    for (const p of pool) p.dur = snapDown(p.dur * factor);
  }
  for (const p of pool) p.dur = snapDown(p.dur);

  // ---- placement ----
  // Free space is a list of [start, end) intervals. With history, priority-1 focus items first go,
  // whole, into the hours where that kind of work usually succeeds. Everything else is packed in
  // original order (recovered minimums first) — exactly v1 when nothing was placed by fit.
  const queue = pool.filter((p) => p.dur > 0).sort((a, b) => a.order - b.order);
  const free: [number, number][] = windows.map((w) => [w[0], w[1]]);
  const placed: PlanBlock[] = [];
  const chunks = new Map<PoolItem, PlanBlock[]>();
  const unplaced: PoolItem[] = [];
  const rates = opts.slotRates ?? {};
  const rateAt = (cat: Category, off: number) => rates[`${cat}@${Math.floor(clockOf(off, ds) / 60) * 60}`];
  // Hours with no history count as this category's average, so a window is not rewarded for
  // touching one strong hour while sitting mostly in unknown ones.
  const catMean = (cat: Category) => {
    const v = Object.entries(rates).filter(([k]) => k.startsWith(`${cat}@`)).map(([, r]) => r);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : undefined;
  };

  const fitPlaced = new Set<PoolItem>();
  if (Object.keys(rates).length) {
    for (const item of queue) {
      if (item.prio !== 1 || !item.block.focus) continue;
      let best: { at: number; score: number; wi: number } | null = null;
      free.forEach(([ws, we], wi) => {
        if (we - ws < item.dur) return;
        const starts = new Set<number>([ws]);
        for (let x = ws; x <= we - item.dur; x += SNAP) if (clockOf(x, ds) % 60 === 0) starts.add(x);
        for (const st of [...starts].sort((a, b) => a - b)) {
          const samples: number[] = [];
          let known = 0;
          for (let x = st; x < st + item.dur; x += 60) {
            const r = rateAt(item.block.category, x);
            if (r !== undefined) known++;
            const v = r ?? catMean(item.block.category);
            if (v !== undefined) samples.push(v);
          }
          if (!known) continue;
          if (samples.reduce((a, b) => a + b, 0) / samples.length < FIT_MIN) continue; // weak history is no reason to move work
          const score = samples.reduce((a, b) => a + b, 0) / samples.length;
          if (!best || score > best.score + 1e-9) best = { at: st, score, wi };
        }
      });
      if (!best) continue;
      const { at, wi, score } = best as { at: number; score: number; wi: number };
      const [ws, we] = free[wi];
      const parts: [number, number][] = [];
      if (at > ws) parts.push([ws, at]);
      if (at + item.dur < we) parts.push([at + item.dur, we]);
      free.splice(wi, 1, ...parts);
      const blk: PlanBlock = { ...item.block, origin: item.block.origin ?? item.block.id, s: at, e: at + item.dur, rescued: true };
      placed.push(blk);
      chunks.set(item, [blk]);
      fitPlaced.add(item);
      item.fit = { rate: score };
    }
  }

  let wi = 0;
  let pos = free[0]?.[0] ?? DAY_MIN;
  for (const item of queue) {
    if (fitPlaced.has(item)) continue;
    let remaining = item.dur;
    let chunkNo = 0;
    const mine: PlanBlock[] = [];
    while (remaining > 0 && wi < free.length) {
      const [, we] = free[wi];
      const room = we - pos;
      if (room <= 0 || (room < MIN_CHUNK && remaining > room)) {
        wi++;
        pos = free[wi]?.[0] ?? DAY_MIN;
        continue;
      }
      const chunk = Math.min(room, remaining);
      const id = chunkNo === 0 ? item.block.id : `${item.block.id}~${chunkNo + 1}`;
      const blk: PlanBlock = {
        ...item.block,
        id,
        origin: item.block.origin ?? item.block.id,
        s: pos,
        e: pos + chunk,
        rescued: true,
      };
      placed.push(blk);
      mine.push(blk);
      pos += chunk;
      remaining -= chunk;
      chunkNo++;
    }
    chunks.set(item, mine);
    if (remaining > 0) {
      item.dur -= remaining;
      if (item.dur <= 0) unplaced.push(item);
    }
  }

  // Leftover gaps become explicit buffer time instead of silent holes.
  const sorted = [...kept.filter((b) => b.e > t), ...placed].sort((a, b) => a.s - b.s);
  const buffers: PlanBlock[] = [];
  let c = t;
  for (const b of sorted) {
    if (b.s - c >= SNAP) buffers.push(makeBuffer(c, b.s));
    c = Math.max(c, b.e);
  }
  if (DAY_MIN - c >= SNAP) buffers.push(makeBuffer(c, DAY_MIN));

  const blocks = [...kept, ...ghosts, ...placed, ...buffers].sort((a, b) => a.s - b.s || (a.missed ? -1 : 1));

  // Pins are sacred. If one moved, that is a bug in this function, not a user situation.
  for (const pin of plan.blocks.filter((b) => b.pinned && !b.missed)) {
    const out = blocks.find((b) => b.id === pin.id);
    if (!out || out.s !== pin.s || out.e !== pin.e) throw new Error(`Rescue bug: pinned block "${pin.title}" was moved`);
  }

  // ---- explanation ----
  const dropped = pool.filter((p) => p.dur === 0 || unplaced.includes(p)).map((p) => p.block);
  const reduced = pool.filter((p) => p.dur > 0 && p.dur < (original.get(p.block.id) ?? 0)).map((p) => p.block);
  const cats = new Set<Category>([...pool.map((p) => p.block.category)]);
  const changes: RescueChange[] = [];
  for (const cat of cats) {
    const before = all
      .filter((b) => b.category === cat && b.e > t && !b.fixed)
      .reduce((a, b) => a + (b.e - b.s), 0);
    const after = placed.filter((b) => b.category === cat).reduce((a, b) => a + (b.e - b.s), 0);
    changes.push({ category: cat, before, after });
  }

  const futurePins = kept.filter((b) => b.pinned && b.e > t);
  const summary: string[] = [];
  if (!feasible && futurePins.length && protectedNeed > capacity) {
    const names = futurePins.map((p) => `"${p.title}" (${span(p.s, p.e)})`).join(', ');
    summary.push(
      `Over-constrained: the pin${futurePins.length > 1 ? 's' : ''} ${names} and the anchors leave ${fmtDur(capacity)} of free time — ${protectedNeed - capacity} minutes short of the protected minimums. Pins are never moved; move or unpin one to make room.`,
    );
  }
  if (opts.lateWakeMin && opts.lateWakeMin > 0) summary.push(`Morning schedule was missed by ${fmtDur(opts.lateWakeMin)}.`);
  const startClock = fmtClock(clockOf(t, ds));
  summary.push(`Rebuilt the day from ${startClock}. Fixed anchors stay where they are.`);
  if (strategy !== 'balanced') summary.push(`Strategy: ${STRATEGY_LABEL[strategy]}.`);
  for (const ch of changes.sort((a, b) => b.after - a.after)) {
    const label = CATEGORY_META[ch.category].label;
    const prot = protect[ch.category];
    if (prot && ch.after + creditedMinutes(doc, date, ch.category, nowMs) >= prot - 5) {
      summary.push(`${label} minimum (${fmtDur(prot)}) remains protected.`);
    } else if (ch.after < ch.before && ch.after > 0) {
      summary.push(`${label} reduced ${fmtDur(ch.before)} → ${fmtDur(ch.after)}.`);
    } else if (ch.after > ch.before) {
      summary.push(`${label} recovered: ${fmtDur(ch.after)} placed back into the day.`);
    }
  }
  for (const d of dropped) summary.push(`${d.title} moved out of today.`);
  if (!feasible) summary.push('Not everything protected fits — the minimums were scaled down. Consider an earlier night.');

  // ---- one sentence per change ----
  const lines: RescueChangeLine[] = [];
  for (const b of kept) {
    if (b.e <= t) continue;
    const why = keptWhy.get(b.id);
    if (why === 'pinned') lines.push({ kind: 'kept', blockId: b.id, title: b.title, from: [b.s, b.e], to: [b.s, b.e], reason: `Kept "${b.title}" ${span(b.s, b.e)} — pinned to its time.` });
    else if (why === 'anchor')
      lines.push({ kind: 'kept', blockId: b.id, title: b.title, from: [b.s, b.e], to: [b.s, b.e], reason: `Kept "${b.title}" ${span(b.s, b.e)} — ${b.exception ? 'planned for this time' : 'fixed anchor'}.` });
    else if (why === 'started') lines.push({ kind: 'kept', blockId: b.id, title: b.title, from: [b.s, b.e], to: [b.s, b.e], reason: `Kept "${b.title}" — already in progress.` });
  }
  const fixedFuture = kept.filter((b) => b.e > t && b.fixed);
  const blocker = (s: number, e: number) => fixedFuture.find((f) => f.s < e && f.e > s);
  const freeTotal = fmtDur(capacity);
  for (const item of [...pool].sort((a, b) => a.order - b.order)) {
    const b = item.block;
    const mine = (chunks.get(item) ?? []).sort((x, y) => x.s - y.s);
    const total = mine.reduce((a, x) => a + (x.e - x.s), 0);
    const origLen = original.get(b.id) ?? b.e - b.s;
    if (item.recovered) {
      if (mine.length) {
        const where = mine.map((x) => span(x.s, x.e)).join(' and ');
        lines.push({ kind: 'added', blockId: b.id, title: b.title, to: [mine[0].s, mine.at(-1)!.e], reason: `Added "${b.title}" ${where} to protect the ${fmtDur(protect[b.category] ?? total)} ${CATEGORY_META[b.category].short} minimum.` });
      }
      continue;
    }
    if (item.extra === 'rest') {
      if (mine.length) lines.push({ kind: 'added', blockId: b.id, title: b.title, to: [mine[0].s, mine[0].e], reason: `Added a 30-minute rest at ${clock(mine[0].s)} — light day.` });
      continue;
    }
    if (!mine.length || total === 0) {
      const m = missionFor(plan, b);
      lines.push({
        kind: 'dropped',
        blockId: b.id,
        title: b.title,
        from: [b.s, b.e],
        reason: `Dropped "${b.title}" (${span(b.s, b.e)}) — no room left today after higher-priority work${b.focus && m ? `; its mission "${m.title}" goes to your task inbox` : ''}.`,
      });
      continue;
    }
    const first = mine[0];
    const last = mine.at(-1)!;
    const movedWhy = (): string => {
      if (b.s < t) return `because it had not started by ${clock(t)}`;
      const f = blocker(b.s, b.e);
      if (f) return `because the ${clock(f.s)} ${f.pinned ? 'pin' : f.exception ? 'planned block' : 'anchor'} "${f.title}" takes that time`;
      if (item.fit) return `into the hours where ${CATEGORY_META[b.category].short} usually succeeds (${Math.round(item.fit.rate * 100)}%)`;
      const other = placed.find((x) => x.origin !== (b.origin ?? b.id) && x.s < b.e && x.e > b.s && x.id !== first.id);
      if (other) return `because "${other.title}" now runs then`;
      return 'to keep the rest of the day in order';
    };
    if (mine.length > 1) {
      const around = fixedFuture.find((f) => f.s >= first.e && f.e <= last.s) ?? fixedFuture.find((f) => f.s >= first.s && f.s < last.e);
      lines.push({
        kind: 'split',
        blockId: b.id,
        title: b.title,
        from: [b.s, b.e],
        to: [first.s, last.e],
        reason: `Split "${b.title}" into ${mine.length} parts (${mine.map((x) => span(x.s, x.e)).join(', ')})${around ? ` around the ${clock(around.s)} ${around.pinned ? 'pin' : 'anchor'} "${around.title}"` : ' to use the free gaps'}${total < origLen ? `, ${fmtDur(origLen)} → ${fmtDur(total)}` : ''}.`,
      });
      continue;
    }
    if (total < origLen) {
      const f = blocker(Math.max(b.s, t), b.e);
      const cause = f ? `the ${clock(f.s)} ${f.pinned ? 'pin' : f.exception ? 'planned block' : 'anchor'} "${f.title}" takes part of that time and ` : '';
      const why =
        strategy === 'light' && (b.category === 'founder' || b.category === 'care')
          ? 'the light day halves this minimum'
          : `${cause}the rest of the day has ${freeTotal} free for ${fmtDur(workNeed)} of work, so lower priorities shrink first`;
      lines.push({
        kind: 'shortened',
        blockId: b.id,
        title: b.title,
        from: [b.s, b.e],
        to: [first.s, first.e],
        reason: `Shortened "${b.title}" ${span(b.s, b.e)} → ${span(first.s, first.e)} (${fmtDur(origLen)} → ${fmtDur(total)}) because ${why}.`,
      });
      continue;
    }
    if (first.s !== b.s) {
      lines.push({ kind: 'moved', blockId: b.id, title: b.title, from: [b.s, b.e], to: [first.s, first.e], reason: `Moved "${b.title}" ${span(b.s, b.e)} → ${span(first.s, first.e)} ${movedWhy()}.` });
    }
  }

  return {
    blocks,
    summary,
    dropped,
    reduced,
    changes,
    feasible,
    from: t,
    lines,
    strategy,
    pinnedCount: futurePins.length,
    freeMinutes: capacity,
    ...(Object.keys(hintMissions).length ? { missions: hintMissions } : {}),
  };
}

function makeBuffer(s: number, e: number): PlanBlock {
  return {
    id: `buf-${s}`,
    title: 'Buffer',
    category: 'buffer',
    s,
    e,
    fixed: false,
    focus: false,
    minMinutes: 0,
    priority: 5,
    rescued: true,
  };
}

// ---------- alternatives ----------

const layoutSig = (blocks: PlanBlock[]) =>
  blocks
    .filter((b) => !b.missed)
    .map((b) => `${b.category}:${b.title}:${b.s}-${b.e}`)
    .join('|');

function headlineFor(doc: Doc, r: RescueResult): string {
  const protects: Record<RescueStrategy, string> = {
    balanced: 'Keeps every protected minimum and the original order',
    protect_study: `Protects study: IIT gets its full ${fmtDur(doc.settings.targets.iit ?? doc.settings.protect.iit ?? 0)}`,
    ship: 'Puts the most valuable mission first',
    light: 'Lighter day: halves founder and care minimums and adds a rest',
  };
  const lost = r.changes
    .filter((c) => c.after < c.before)
    .sort((a, b) => b.before - b.after - (a.before - a.after))
    .map((c) => `${CATEGORY_META[c.category].short} −${fmtDur(c.before - c.after)}`);
  return `${protects[r.strategy]} · gives up ${lost.length ? lost.slice(0, 3).join(', ') : 'nothing'}`;
}

/** Up to three distinct rescue plans (identical layouts are dropped), each with a one-line headline. */
export function rescueOptions(doc: Doc, date: string, nowMs: number, opts: Omit<RescueOptions, 'strategy'> = {}): RescueResult[] {
  const out: RescueResult[] = [];
  const seen = new Set<string>();
  for (const strategy of ['balanced', 'protect_study', 'ship', 'light'] as RescueStrategy[]) {
    const r = buildRescue(doc, date, nowMs, { ...opts, strategy });
    const sig = layoutSig(r.blocks);
    if (seen.has(sig)) continue;
    seen.add(sig);
    r.headline = headlineFor(doc, r);
    out.push(r);
    if (out.length === 3) break;
  }
  return out;
}

// ---------- week scope ----------

export interface WeekRescueDay {
  date: string;
  blocks: PlanBlock[];
  missions: Record<string, Mission>;
  lines: RescueChangeLine[];
}

export interface WeekRescueResult {
  today: RescueResult;
  date: string;
  days: WeekRescueDay[]; // only future days of this week that change
  toInbox: { title: string; area: Area; estimate?: number; blockId: string }[];
  strategy: RescueStrategy;
}

/**
 * Rescue today, then offer today's dropped focus missions to the rest of this week: each goes,
 * highest priority first, into the first flexible focus block of the same category that has no
 * mission yet. Pins and every block time on those days stay as they are. Missions that fit
 * nowhere go to the task inbox, as in a today-only rescue.
 */
export function buildWeekRescue(doc: Doc, fromDate: string, nowMs: number, opts: RescueOptions = {}): WeekRescueResult {
  const ds = doc.settings.dayStart;
  const today = buildRescue(doc, fromDate, nowMs, opts);
  const plan = planFor(doc, fromDate);
  const candidates = today.dropped
    .filter((b) => b.focus)
    .map((b) => ({ block: b, mission: missionFor(plan, b) }))
    .filter((x): x is { block: PlanBlock; mission: Mission } => !!x.mission)
    .sort((a, b) => a.block.priority - b.block.priority);

  const weekEnd = addDays(weekKey(fromDate), 6);
  const future: { date: string; blocks: PlanBlock[]; missions: Record<string, Mission>; lines: RescueChangeLine[] }[] = [];
  for (let d = addDays(fromDate, 1); d <= weekEnd; d = addDays(d, 1)) {
    const p = planFor(doc, d);
    future.push({ date: d, blocks: p.blocks, missions: { ...p.missions }, lines: [] });
  }
  const toInbox: WeekRescueResult['toInbox'] = [];
  for (const c of candidates) {
    let done = false;
    for (const day of future) {
      const target = liveBlocks({ id: day.date, u: 0, blocks: day.blocks, missions: day.missions, outcomes: [] }).find(
        (b) => b.focus && !b.fixed && b.category === c.block.category && !missionFor({ id: day.date, u: 0, blocks: day.blocks, missions: day.missions, outcomes: [] }, b),
      );
      if (!target) continue;
      day.missions[target.id] = { ...c.mission };
      day.lines.push({
        kind: 'moved',
        blockId: target.id,
        title: c.mission.title,
        from: [c.block.s, c.block.e],
        to: [target.s, target.e],
        reason: `Moved the mission "${c.mission.title}" to ${shortDate(day.date)}, ${target.title} ${fmtClock(clockOf(target.s, ds), true)}–${fmtClock(clockOf(target.e, ds), true)} — it no longer fits today.`,
      });
      done = true;
      break;
    }
    if (!done) toInbox.push({ title: c.mission.title, area: areaOf(c.block.category), estimate: c.mission.estimate, blockId: c.block.id });
  }
  return {
    today,
    date: fromDate,
    days: future.filter((d) => d.lines.length).map((d) => ({ date: d.date, blocks: d.blocks, missions: d.missions, lines: d.lines })),
    toInbox,
    strategy: today.strategy,
  };
}
