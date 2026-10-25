import { liveBlocks, planFor } from './engine';
import { carve, isAnchor, uid } from './ops';
import { makeProposal, validateDayBlocks } from './proposals';
import type { Category, Doc, PlanBlock, Proposal, ProposedDay, ProposedLine } from './types';
import { clockOf, fmtClock, offsetFromClock, shortDate } from './time';

// Imports (e.g. class schedules found in email by the AI). Each event becomes a pinned block with an
// optional Join link and reminder. A stable externalId makes re-imports update instead of duplicate.
// Events that collide with a pin or an anchor are reported, never forced.

export interface ImportEvent {
  externalId: string;
  title: string;
  date: string; // logical date
  start: string; // HH:MM
  end: string; // HH:MM
  category?: Category; // default iit
  joinUrl?: string;
  location?: string;
  pinned?: boolean; // default true
  reminderMin?: number; // default 10
}

export interface ImportResult {
  days: ProposedDay[];
  skipped: string[];
  changed: number;
  added: number;
  unchanged: number;
}

const HHMM = /^([01]?\d|2[0-4]):([0-5]\d)$/;

function toOff(text: string, ds: number, isEnd: boolean): number | null {
  const m = HHMM.exec(text.trim());
  if (!m) return null;
  const off = offsetFromClock((Number(m[1]) * 60 + Number(m[2])) % 1440, ds);
  const snapped = Math.round(off / 5) * 5;
  return isEnd && snapped === 0 ? 1440 : snapped;
}

export function planImport(doc: Doc, events: ImportEvent[], nowMs: number): ImportResult {
  const ds = doc.settings.dayStart;
  const clock = (o: number) => fmtClock(clockOf(o, ds), true);
  const skipped: string[] = [];
  let changed = 0;
  let added = 0;
  let unchanged = 0;
  const byDate = new Map<string, ImportEvent[]>();
  const seen = new Set<string>();
  for (const e of events) {
    if (seen.has(e.externalId)) {
      skipped.push(`"${e.title}" on ${e.date} appears twice in this import; kept the first.`);
      continue;
    }
    seen.add(e.externalId);
    byDate.set(e.date, [...(byDate.get(e.date) ?? []), e]);
  }
  const days: ProposedDay[] = [];
  for (const [date, list] of [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const plan = planFor(doc, date);
    const live = liveBlocks(plan);
    const lines: ProposedLine[] = [];
    const ids = new Set(list.map((e) => e.externalId));
    const replaced = live.filter((b) => b.externalId && ids.has(b.externalId));
    const fixed = live.filter((b) => b.fixed && !replaced.includes(b));
    // start from the day without the blocks this import replaces
    let flex = live.filter((b) => !b.fixed);
    const keepPins: PlanBlock[] = [];
    let dayChanged = false;
    for (const e of list) {
      const s = toOff(e.start, ds, false);
      const en = toOff(e.end, ds, true);
      if (s === null || en === null || en <= s) {
        skipped.push(`"${e.title}" on ${shortDate(date)} has an unreadable time (${e.start}–${e.end}).`);
        continue;
      }
      if (e.joinUrl && !e.joinUrl.startsWith('https://')) {
        skipped.push(`"${e.title}" on ${shortDate(date)}: the link is not https, so it was left out.`);
        e.joinUrl = undefined;
      }
      const clash = fixed.find((b) => b.s < en && b.e > s);
      if (clash) {
        skipped.push(`"${e.title}" ${shortDate(date)} ${clock(s)}–${clock(en)} overlaps the ${clash.pinned ? 'pinned block' : isAnchor(doc, clash) ? 'anchor' : 'planned block'} "${clash.title}" — not imported.`);
        const old = replaced.find((b) => b.externalId === e.externalId);
        if (old) keepPins.push(old); // keep the previous version rather than losing it
        continue;
      }
      const old = replaced.find((b) => b.externalId === e.externalId);
      const block: PlanBlock = {
        id: old?.id ?? uid('i', nowMs),
        title: e.title.slice(0, 120),
        category: e.category ?? 'iit',
        s,
        e: en,
        fixed: e.pinned !== false,
        focus: (e.category ?? 'iit') === 'iit' || e.category === 'founder',
        minMinutes: en - s,
        priority: 1,
        ...(e.pinned !== false ? { pinned: true } : {}),
        source: 'import',
        externalId: e.externalId,
        reminderMin: Math.max(0, Math.min(120, e.reminderMin ?? 10)),
        ...(e.joinUrl ? { joinUrl: e.joinUrl } : {}),
        ...(e.location ? { location: e.location.slice(0, 120) } : {}),
      };
      if (old && old.s === s && old.e === en && old.title === block.title && old.joinUrl === block.joinUrl) {
        unchanged++;
        keepPins.push(old);
        continue;
      }
      dayChanged = true;
      if (old) {
        changed++;
        lines.push({ kind: 'moved', blockId: block.id, title: block.title, from: [old.s, old.e], to: [s, en], reason: `Changed "${block.title}" ${clock(old.s)}–${clock(old.e)} → ${clock(s)}–${clock(en)}.` });
      } else {
        added++;
        lines.push({ kind: 'added', blockId: block.id, title: block.title, to: [s, en], reason: `Add "${block.title}" ${clock(s)}–${clock(en)}${block.joinUrl ? ` with a Join link (${new URL(block.joinUrl).hostname})` : ''}, reminder ${block.reminderMin} min before.` });
      }
      // overlapping imports in the same batch: the later one is reported, not forced
      if (keepPins.some((p) => p.s < en && p.e > s) || flex.some((p) => p.pinned && p.s < en && p.e > s)) {
        skipped.push(`"${e.title}" ${shortDate(date)} overlaps another imported class — not imported.`);
        lines.pop();
        if (old) changed--;
        else added--;
        continue;
      }
      flex = carve(flex, block);
    }
    if (!dayChanged) continue;
    // Validation treats replaced pins as movable; everything else that is fixed stays.
    const draft = [...flex, ...keepPins.filter((p) => !flex.some((f) => f.id === p.id))];
    const baseDoc: Doc = { ...doc, days: { ...doc.days, [date]: { ...plan, blocks: plan.blocks.filter((b) => !replaced.includes(b)) } } };
    const v = validateDayBlocks(baseDoc, date, draft, {});
    skipped.push(...v.errors);
    days.push({ date, blocks: v.blocks, lines });
  }
  return { days, skipped, changed, added, unchanged };
}

export function makeImportProposal(doc: Doc, events: ImportEvent[], nowMs: number, meta: { rationale?: string; client?: string } = {}): { proposal: Proposal | null; result: ImportResult } {
  const result = planImport(doc, events, nowMs);
  if (!result.days.length) return { proposal: null, result };
  const n = result.added + result.changed;
  const proposal = makeProposal(
    doc,
    {
      kind: 'import',
      source: 'mcp',
      client: meta.client,
      title: `${n} class${n === 1 ? '' : 'es'} found${result.changed ? ` (${result.changed} changed)` : ''}`,
      rationale: meta.rationale,
      date: result.days[0].date,
      days: result.days,
      scopeAllowed: ['week', 'today'],
      warnings: result.skipped,
    },
    nowMs,
  );
  return { proposal, result };
}
