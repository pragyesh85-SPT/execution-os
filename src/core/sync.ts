import { COLLECTIONS, type CollectionKey, type Doc, type Synced } from './types';
import { longDate } from './time';

// Sync protocol between devices and the hub on the PC (the single source of truth).
//
// Every device keeps three things:
//   local  — what the user sees and edits (works fully offline)
//   synced — the last copy of each record it received from the hub (the common "base")
//   remote — the hub's current copy (fetched each cycle)
// For every record we compare local and remote against the base:
//   only local changed   -> upload it (the hub accepts only if nobody changed it meanwhile)
//   only remote changed  -> take the hub's version
//   both changed         -> merge field by field; if the same field was changed differently
//                           on both sides, it becomes a Conflict and the user decides.
// Decisions never depend on device clocks, so a phone with the wrong time cannot win by accident.

export type RecCol = 'settings' | 'template' | CollectionKey;

export interface Change {
  col: RecCol;
  id: string;
  baseR: number; // hub revision this edit was based on (0 = new record)
  record: Synced;
}

export interface Conflict {
  key: string;
  col: RecCol;
  id: string;
  base: Synced | null;
  mine: Synced;
  theirs: Synced | null;
  fields: string[];
  at: number;
}

export interface SyncPlan {
  local: Doc;
  push: Change[];
  conflicts: Conflict[]; // new conflicts found this cycle
  updatedConflicts: Conflict[]; // existing conflicts whose hub side changed again
  changedLocal: boolean;
}

export const recKey = (col: RecCol, id: string) => `${col}/${id}`;

export function splitKey(key: string): { col: RecCol; id: string } {
  const i = key.indexOf('/');
  return { col: key.slice(0, i) as RecCol, id: key.slice(i + 1) };
}

export function getRec(doc: Doc, col: RecCol, id: string): Synced | undefined {
  if (col === 'settings') return doc.settings;
  if (col === 'template') return doc.template;
  return (doc[col] as Record<string, Synced>)[id];
}

export function setRec(doc: Doc, col: RecCol, id: string, rec: Synced | undefined) {
  if (col === 'settings' || col === 'template') {
    if (rec) (doc as unknown as Record<string, Synced>)[col] = rec;
    return;
  }
  const c = doc[col] as Record<string, Synced>;
  if (rec) c[id] = rec;
  else delete c[id];
}

export function allKeys(...docs: Doc[]): string[] {
  const keys = new Set<string>(['settings/settings', 'template/template']);
  for (const d of docs) for (const col of COLLECTIONS) for (const id of Object.keys(d[col] ?? {})) keys.add(recKey(col, id));
  return [...keys];
}

// ---------- comparison ----------

function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      if (k === 'u' || k === 'r') continue;
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = stable(x);
    }
    return out;
  }
  return v;
}

/** Content equality, ignoring key order and the u / r bookkeeping fields. */
export function sameRec(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
}

const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const same = (a: unknown, b: unknown) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));

/** Untouched default (never edited anywhere) — never counts as a change. */
const isDefault = (r: Synced | undefined) => !!r && r.u === 0;

// ---------- three-way merge ----------

const isEmpty = (v: unknown) =>
  v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0) || (isPlain(v) && Object.keys(v).length === 0);

function mergeValue(base: unknown, mine: unknown, theirs: unknown, path: string, conflicts: string[]): unknown {
  if (same(mine, theirs)) return theirs;
  // No common base (e.g. both devices created today's plan on their own): an empty side is "untouched".
  if (base === undefined && isEmpty(mine)) return theirs;
  if (base === undefined && isEmpty(theirs)) return mine;
  if (same(mine, base)) return theirs; // only the hub side changed
  if (same(theirs, base)) return mine; // only this device changed
  if (isPlain(mine) && isPlain(theirs) && (base === undefined || isPlain(base))) {
    const b = (base ?? {}) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of new Set([...Object.keys(mine), ...Object.keys(theirs), ...Object.keys(b)])) {
      if (k === 'u' || k === 'r') continue;
      const v = mergeValue(b[k], mine[k], theirs[k], path ? `${path}.${k}` : k, conflicts);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  conflicts.push(path || '(whole record)');
  return mine;
}

export function threeWay(base: Synced | undefined, mine: Synced, theirs: Synced): { ok: true; value: Synced } | { ok: false; fields: string[] } {
  if (isDefault(mine)) return { ok: true, value: theirs };
  if (isDefault(theirs)) return { ok: true, value: { ...mine, r: theirs.r } };
  const fields: string[] = [];
  const merged = mergeValue(base, mine, theirs, '', fields) as Synced;
  if (fields.length) return { ok: false, fields };
  return { ok: true, value: { ...merged, id: theirs.id, u: Math.max(mine.u, theirs.u), r: theirs.r } };
}

// ---------- the plan for one sync cycle ----------

export function planSync(synced: Doc, local: Doc, remote: Doc, open: Map<string, Conflict>, now: number): SyncPlan {
  const next = structuredClone(local);
  const push: Change[] = [];
  const conflicts: Conflict[] = [];
  const updatedConflicts: Conflict[] = [];
  let changedLocal = false;

  for (const key of allKeys(synced, local, remote)) {
    const { col, id } = splitKey(key);
    const s = getRec(synced, col, id);
    const l = getRec(local, col, id);
    const t = getRec(remote, col, id);
    const localChanged = !!l && !isDefault(l) && !sameRec(l, s);
    const remoteChanged = !sameRec(t, s);

    const existing = open.get(key);
    if (existing) {
      // Waiting for the user's decision: keep showing this device's version, track the hub's.
      if (!sameRec(existing.theirs, t)) updatedConflicts.push({ ...existing, theirs: t ?? null });
      continue;
    }

    if (!localChanged) {
      if (remoteChanged && t) {
        setRec(next, col, id, t);
        changedLocal = true;
      } else if (t && l && t.r !== l.r && sameRec(t, l)) {
        setRec(next, col, id, { ...l, r: t.r }); // adopt the hub's revision number
        changedLocal = true;
      }
      continue;
    }

    if (!remoteChanged || !t) {
      push.push({ col, id, baseR: t?.r ?? 0, record: l });
      continue;
    }

    if (sameRec(l, t)) {
      setRec(next, col, id, t);
      changedLocal = true;
      continue;
    }

    const m = threeWay(s, l, t);
    if (m.ok) {
      setRec(next, col, id, m.value);
      changedLocal = true;
      if (!sameRec(m.value, t)) push.push({ col, id, baseR: t.r ?? 0, record: m.value });
    } else {
      conflicts.push({ key, col, id, base: s ?? null, mine: l, theirs: t, fields: m.fields, at: now });
    }
  }
  return { local: next, push, conflicts, updatedConflicts, changedLocal };
}

/** Records changed on this device that the hub has not received yet. */
export function pendingKeys(synced: Doc, local: Doc, open: Map<string, Conflict>): string[] {
  return allKeys(synced, local).filter((key) => {
    if (open.has(key)) return false;
    const { col, id } = splitKey(key);
    const l = getRec(local, col, id);
    return !!l && !isDefault(l) && !sameRec(l, getRec(synced, col, id));
  });
}

export function describeRec(col: RecCol, rec: Synced | null | undefined): string {
  if (!rec) return col;
  const r = rec as unknown as Record<string, unknown>;
  switch (col) {
    case 'settings':
      return 'Settings';
    case 'template':
      return 'Master clock';
    case 'days':
      return `Plan for ${/^\d{4}-\d{2}-\d{2}$/.test(rec.id) ? longDate(rec.id) : rec.id}`;
    case 'tasks':
      return `Task · ${String(r.title ?? '')}`;
    case 'rules':
      return `Rule · ${String(r.cue ?? '')}`;
    case 'later':
      return `Later · ${String(r.text ?? '')}`;
    case 'proofs':
      return `Proof · ${String(r.date ?? '')} ${String(r.blockId ?? '')}`;
    case 'wake':
      return `Wake checkpoint · ${rec.id}`;
    case 'sessions':
      return `Focus session · ${String(r.date ?? '')}`;
    case 'reviews':
      return `Weekly review · ${rec.id}`;
    case 'distractions':
      return `Distraction · ${String(r.source ?? '')}`;
  }
}
