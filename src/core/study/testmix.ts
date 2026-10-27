import { rungIndex, type Concept, type ConceptState, type StudyEvent, type TestBucket } from './types';

// The 3-day test blueprint: one cumulative test of everything studied so far, split by subject.
//   40 % concepts learned since the last test · 25 % older concepts (retention)
//   20 % past mistakes (was the repair real?) · 15 % mixed and transfer questions
// plus 1–2 items per subject in the style of IITJ quizzes and assignments, and a programming part.

export const MIX: Record<TestBucket, number> = { new: 0.4, retention: 0.25, mistake: 0.2, transfer: 0.15 };
export const BUCKETS: TestBucket[] = ['new', 'retention', 'mistake', 'transfer'];

/** Largest-remainder split of n items over the mix; empty buckets hand their share on. */
export function allocate(n: number, available: Record<TestBucket, number>): Record<TestBucket, number> {
  const live = BUCKETS.filter((b) => available[b] > 0);
  const out: Record<TestBucket, number> = { new: 0, retention: 0, mistake: 0, transfer: 0 };
  if (!live.length || n <= 0) return out;
  const w = live.reduce((a, b) => a + MIX[b], 0);
  const raw = live.map((b) => ({ b, x: (n * MIX[b]) / w }));
  for (const r of raw) out[r.b] = Math.floor(r.x);
  let left = n - raw.reduce((a, r) => a + Math.floor(r.x), 0);
  for (const r of [...raw].sort((a, b) => b.x - Math.floor(b.x) - (a.x - Math.floor(a.x)))) {
    if (left <= 0) break;
    out[r.b]++;
    left--;
  }
  return out;
}

export interface SubjectBlueprint {
  subject: string;
  written: number;
  programming: number;
  iitjStyle: number;
  counts: Record<TestBucket, number>;
  concepts: Record<TestBucket, string[]>; // candidates for each bucket
  transferPairs: [string, string][];
}

export interface BlueprintInput {
  subjects: { id: string }[];
  concepts: Concept[];
  states: Map<string, ConceptState>;
  events: StudyEvent[];
  lastTestAt: number | null; // when the previous test was taken (null: first test)
  writtenPerSubject?: number; // default 5
  programmingPerSubject?: number; // default 1
}

const studied = (s: ConceptState | undefined) => !!s && rungIndex(s.rung) >= rungIndex('seen');

export function blueprint(inp: BlueprintInput): SubjectBlueprint[] {
  const mistakes = new Map<string, number>();
  for (const e of inp.events) if (e.kind === 'mistake' && e.concept) mistakes.set(e.concept, (mistakes.get(e.concept) ?? 0) + 1);
  const out: SubjectBlueprint[] = [];
  for (const s of inp.subjects) {
    const cs = inp.concepts.filter((c) => c.subject === s.id && studied(inp.states.get(c.id)));
    if (!cs.length) continue;
    const since = (c: Concept) => inp.states.get(c.id)?.reachedAt.seen ?? 0;
    const fresh = cs.filter((c) => inp.lastTestAt === null || since(c) > inp.lastTestAt).map((c) => c.id);
    const old = cs.filter((c) => inp.lastTestAt !== null && since(c) <= inp.lastTestAt).map((c) => c.id);
    const wrong = cs.filter((c) => mistakes.has(c.id)).sort((a, b) => (mistakes.get(b.id) ?? 0) - (mistakes.get(a.id) ?? 0)).map((c) => c.id);
    const ids = new Set(cs.map((c) => c.id));
    const pairs: [string, string][] = [];
    for (const c of cs) for (const p of [...c.prereqs, ...c.confusedWith]) if (ids.has(p) && p !== c.id && !pairs.some(([a, b]) => (a === p && b === c.id) || (a === c.id && b === p))) pairs.push([p, c.id]);
    if (!pairs.length && cs.length >= 2) pairs.push([cs[0].id, cs[1].id]);
    const transfer = [...new Set(pairs.flat())];
    const written = inp.writtenPerSubject ?? 5;
    const counts = allocate(written, { new: fresh.length, retention: old.length, mistake: wrong.length, transfer: transfer.length });
    out.push({ subject: s.id, written, programming: inp.programmingPerSubject ?? 1, iitjStyle: Math.min(2, Math.max(1, Math.round(written / 4))), counts, concepts: { new: fresh, retention: old, mistake: wrong, transfer }, transferPairs: pairs });
  }
  return out;
}

/** An item counts as answered correctly at 60 % of its marks or more. */
export const ITEM_CORRECT_AT = 0.6;
