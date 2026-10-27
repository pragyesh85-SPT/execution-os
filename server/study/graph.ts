import { slug } from '../../src/core/study/ids';
import type { Concept } from '../../src/core/study/types';

// The week-end graph check: likely duplicate concepts, links to concepts that do not exist (or were
// merged away), and prerequisite cycles. Claude fixes what it finds; this only reports.

const STOP = new Set(['and', 'the', 'of', 'a', 'an', 'in', 'to', 'for', 'with', 'its', 'on']);
const tokens = (t: string) => new Set(slug(t).split('-').filter((w) => w && !STOP.has(w)).map((w) => w.replace(/s$/, '')));

export function graphReport(all: Concept[]) {
  const live = all.filter((c) => !c.mergedInto);
  const byId = new Map(all.map((c) => [c.id, c]));
  const duplicates: { a: string; b: string; similarity: number }[] = [];
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i];
      const b = live[j];
      if (a.subject !== b.subject) continue;
      const ta = tokens(a.title);
      const tb = tokens(b.title);
      const inter = [...ta].filter((x) => tb.has(x)).length;
      const sim = inter / Math.max(1, new Set([...ta, ...tb]).size);
      if (sim >= 0.6) duplicates.push({ a: a.id, b: b.id, similarity: Math.round(sim * 100) / 100 });
    }
  }
  const broken: { concept: string; field: string; target: string; problem: string }[] = [];
  for (const c of all) {
    for (const [field, list] of [['prereqs', c.prereqs], ['confusedWith', c.confusedWith]] as const) {
      for (const t of list) {
        const tc = byId.get(t);
        if (!tc) broken.push({ concept: c.id, field, target: t, problem: 'does not exist' });
        else if (tc.mergedInto) broken.push({ concept: c.id, field, target: t, problem: `was merged into ${tc.mergedInto}` });
      }
    }
    if (c.mergedInto && !byId.has(c.mergedInto)) broken.push({ concept: c.id, field: 'mergedInto', target: c.mergedInto, problem: 'does not exist' });
  }
  const cycles: string[][] = [];
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const visit = (id: string) => {
    state.set(id, 1);
    stack.push(id);
    for (const p of byId.get(id)?.prereqs ?? []) {
      if (!byId.has(p)) continue;
      if (state.get(p) === 1) cycles.push([...stack.slice(stack.indexOf(p)), p]);
      else if (!state.get(p)) visit(p);
    }
    stack.pop();
    state.set(id, 2);
  };
  for (const c of live) if (!state.get(c.id)) visit(c.id);
  return { concepts: live.length, duplicates, broken, cycles };
}
