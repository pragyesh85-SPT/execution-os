import { CATEGORY_META } from './defaults';
import { activeSession, creditedMinutes, liveBlocks, minutesForBlock, planFor, proofFor } from './engine';
import type { Category, Doc, PlanBlock } from './types';
import { DAY_MIN, clockOf, fmtClock, fmtDur, offsetOf } from './time';

// Rescue Mode: never carry lateness forward block by block.
// Instead, take everything that is still undone, keep the time-anchored blocks where they are,
// protect the daily minimums, compress the low-priority work and pack a feasible rest-of-day.

export interface RescueChange {
  category: Category;
  before: number;
  after: number;
}

export interface RescueResult {
  blocks: PlanBlock[];
  summary: string[];
  dropped: PlanBlock[];
  reduced: PlanBlock[];
  changes: RescueChange[];
  feasible: boolean;
  from: number; // offset the rescue starts at
}

interface PoolItem {
  block: PlanBlock;
  dur: number;
  min: number;
  order: number;
  recovered: boolean;
  protectedCat: boolean;
}

const SNAP = 5;
const MIN_CHUNK = 15;
const snapUp = (m: number) => Math.ceil(m / SNAP) * SNAP;
const snapDown = (m: number) => Math.floor(m / SNAP) * SNAP;

export function buildRescue(doc: Doc, date: string, nowMs: number, opts: { lateWakeMin?: number } = {}): RescueResult {
  const { settings } = doc;
  const plan = planFor(doc, date);
  // Start the rebuilt day at the current 5-minute mark so there is never an uncovered gap before it.
  const t = Math.min(DAY_MIN, Math.max(0, snapDown(offsetOf(nowMs, date, settings.dayStart))));
  const all = liveBlocks(plan);
  const running = activeSession(doc);

  const kept: PlanBlock[] = []; // stays exactly where it is
  const ghosts: PlanBlock[] = plan.blocks.filter((b) => b.missed);
  const pool: PoolItem[] = [];
  let order = 0;

  for (const b of all) {
    if (b.e <= t) {
      kept.push(b); // history
      continue;
    }
    const isCurrent = b.s < t;
    const tracked = minutesForBlock(doc, date, b.id, nowMs);
    const proof = proofFor(doc, date, b.id);
    const touched = tracked > 0 || (running && running.blockId === b.id) || !!proof;
    if (b.fixed || (isCurrent && touched)) {
      kept.push(b);
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
      recovered: false,
      protectedCat: !!settings.protect[b.category],
    });
  }

  // Protected minimums that the remaining plan no longer covers (e.g. the IIT block already passed).
  for (const [cat, protectMin] of Object.entries(settings.protect) as [Category, number][]) {
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
        recovered: true,
        protectedCat: true,
      });
    }
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

  // Compress: lowest priority first, then the block with the most slack.
  const original = new Map(pool.map((p) => [p.block.id, p.dur]));
  let over = pool.reduce((a, p) => a + p.dur, 0) - capacity;
  let feasible = true;
  if (over > 0) {
    const byCut = [...pool].sort((a, b) => b.block.priority - a.block.priority || b.dur - b.min - (a.dur - a.min));
    for (const p of byCut) {
      if (over <= 0) break;
      const cut = Math.min(over, p.dur - p.min);
      p.dur -= cut;
      over -= cut;
    }
  }
  if (over > 0) {
    const byDrop = [...pool]
      .filter((p) => !p.protectedCat)
      .sort((a, b) => b.block.priority - a.block.priority || a.order - b.order);
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

  // Pack in order: recovered minimums first, then the original sequence.
  const queue = pool.filter((p) => p.dur > 0).sort((a, b) => a.order - b.order);
  const placed: PlanBlock[] = [];
  const unplaced: PoolItem[] = [];
  let wi = 0;
  let pos = windows[0]?.[0] ?? DAY_MIN;
  for (const item of queue) {
    let remaining = item.dur;
    let chunkNo = 0;
    while (remaining > 0 && wi < windows.length) {
      const [, we] = windows[wi];
      const room = we - pos;
      if (room <= 0 || (room < MIN_CHUNK && remaining > room)) {
        wi++;
        pos = windows[wi]?.[0] ?? DAY_MIN;
        continue;
      }
      const chunk = Math.min(room, remaining);
      const id = chunkNo === 0 ? item.block.id : `${item.block.id}~${chunkNo + 1}`;
      placed.push({
        ...item.block,
        id,
        origin: item.block.origin ?? item.block.id,
        s: pos,
        e: pos + chunk,
        rescued: true,
      });
      pos += chunk;
      remaining -= chunk;
      chunkNo++;
    }
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

  const summary: string[] = [];
  if (opts.lateWakeMin && opts.lateWakeMin > 0) summary.push(`Morning schedule was missed by ${fmtDur(opts.lateWakeMin)}.`);
  const startClock = fmtClock(clockOf(t, settings.dayStart));
  summary.push(`Rebuilt the day from ${startClock}. Fixed anchors stay where they are.`);
  for (const ch of changes.sort((a, b) => b.after - a.after)) {
    const label = CATEGORY_META[ch.category].label;
    const prot = settings.protect[ch.category];
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

  return { blocks, summary, dropped, reduced, changes, feasible, from: t };
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
