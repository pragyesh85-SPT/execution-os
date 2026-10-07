import { emptyDoc } from './defaults';
import { COLLECTIONS, type Doc, type Synced } from './types';

// Per-record last-write-wins merge. Each record carries `u` (ms of last edit).
// Ties keep `a` so that merging is stable; deletions are tombstones (`del: true`) so they propagate.

function pick<T extends Synced>(a: T | undefined, b: T | undefined): T | undefined {
  if (!a) return b;
  if (!b) return a;
  return b.u > a.u ? b : a;
}

export function mergeDocs(a: Doc, b: Doc): Doc {
  const out: Doc = {
    settings: pick(a.settings, b.settings)!,
    template: pick(a.template, b.template)!,
  } as Doc;
  for (const key of COLLECTIONS) {
    const ca = (a[key] ?? {}) as Record<string, Synced>;
    const cb = (b[key] ?? {}) as Record<string, Synced>;
    const merged: Record<string, Synced> = { ...ca };
    for (const id of Object.keys(cb)) merged[id] = pick(ca[id], cb[id])!;
    (out as unknown as Record<string, unknown>)[key] = merged;
  }
  return out;
}

/** Fill any missing parts of a (possibly older or partial) doc with defaults. */
export function normalizeDoc(input: Partial<Doc> | undefined | null): Doc {
  const base = emptyDoc();
  if (!input) return base;
  const out: Doc = {
    settings: { ...base.settings, ...(input.settings ?? {}) },
    template: input.template?.blocks?.length ? input.template : base.template,
  } as Doc;
  for (const key of COLLECTIONS) {
    const v = (input as Record<string, unknown>)[key];
    (out as unknown as Record<string, unknown>)[key] =
      v && typeof v === 'object' ? v : (base as unknown as Record<string, unknown>)[key];
  }
  // Keep default rules if the incoming doc never had any.
  if (!Object.keys(out.rules).length) out.rules = base.rules;
  return out;
}

/** Highest `u` anywhere in the doc — a cheap change fingerprint. */
export function docStamp(doc: Doc): number {
  let max = Math.max(doc.settings.u, doc.template.u);
  for (const key of COLLECTIONS) {
    for (const r of Object.values(doc[key] as Record<string, Synced>)) if (r.u > max) max = r.u;
  }
  return max;
}

/** Remove tombstones older than `days` to keep the doc small. */
export function compactDoc(doc: Doc, nowMs: number, days = 30): Doc {
  const cutoff = nowMs - days * 86_400_000;
  const out = { ...doc } as Doc;
  for (const key of COLLECTIONS) {
    const col = doc[key] as Record<string, Synced>;
    const next: Record<string, Synced> = {};
    for (const [id, r] of Object.entries(col)) if (!(r.del && r.u < cutoff)) next[id] = r;
    (out as unknown as Record<string, unknown>)[key] = next;
  }
  return out;
}
