import { recallNow } from './fsrs';
import { DAY_MS } from './ids';
import { MISTAKE_LABEL, rungIndex, type Concept, type ConceptState, type FsrsCard, type QueueItem, type Repair, type ResourcePath, type Segment, type Subject, type SubjectProgress } from './types';

// The study queue — what to do next, in this order:
//   1. repair items (the same mistake twice), most recent first
//   2. due reviews (the first 10–15 minutes of a study day)
//   3. the 3-day test when it is due
//   4. concepts to learn: ones already started first, then the subject that is furthest behind,
//      in syllabus order with prerequisites first. When the projected ready date slips past the
//      target, the remaining concepts are ordered by exam weight × weakness instead.

export interface QueueInput {
  now: number;
  concepts: Concept[]; // syllabus concepts, duplicates excluded
  states: Map<string, ConceptState & { card?: FsrsCard | null }>;
  repairs: Repair[];
  paths: Map<string, ResourcePath>;
  subjects: Subject[];
  progress: SubjectProgress[];
  testDue?: { id: string; title: string; minutes: number } | null;
  byWeight: boolean;
  limit?: number;
}

const REVIEW_MIN = 3;

/** The segment to watch next: the first one not done yet, or an alternate after a missed check. */
export function nextSegment(path: ResourcePath | undefined, state: ConceptState | undefined, doneCount: number): Segment | undefined {
  if (!path) return undefined;
  const live = path.segments.filter((s) => !s.dead);
  const alts = path.alternates.filter((s) => !s.dead);
  if (state && state.missedChecks > 0 && state.nextStep === 'watch' && alts.length) return alts[(state.missedChecks - 1) % alts.length];
  return live[Math.min(doneCount, live.length - 1)] ?? alts[0];
}

/** The most visual explanation available (a repair starts with it). */
export const visualSegment = (path: ResourcePath | undefined) => path && ([...path.segments, ...path.alternates].find((s) => !s.dead && s.kind === 'intuition') ?? [...path.segments, ...path.alternates].find((s) => !s.dead));

const segMinutes = (s: Segment | undefined, fallback: number) => (s?.start !== undefined && s?.end !== undefined && s.end > s.start && s.timestampVerified !== false ? Math.max(1, Math.round((s.end - s.start) / 60)) : fallback);

export function buildQueue(inp: QueueInput): QueueItem[] {
  const out: QueueItem[] = [];
  const byId = new Map(inp.concepts.map((c) => [c.id, c]));
  const title = (id: string) => byId.get(id)?.title ?? id;
  const subj = (id: string) => byId.get(id)?.subject ?? '';

  for (const r of inp.repairs) {
    if (!byId.has(r.concept)) continue;
    out.push({ kind: 'repair', concept: r.concept, title: title(r.concept), subject: subj(r.concept), why: `Same mistake twice (${MISTAKE_LABEL[r.cls]}${r.detail ? `: ${r.detail}` : ''}) — watch the visual explanation, then retest.`, repair: r, minutes: 15 });
  }

  const endOfDay = inp.now + DAY_MS / 2;
  const due = inp.concepts
    .map((c) => ({ c, st: inp.states.get(c.id) }))
    .filter((x) => x.st?.card && rungIndex(x.st.rung) >= rungIndex('applied') && x.st.card.due <= endOfDay)
    .sort((a, b) => recallNow(a.st!.card!, inp.now) - recallNow(b.st!.card!, inp.now));
  for (const { c, st } of due) {
    out.push({ kind: 'review', concept: c.id, title: c.title, subject: c.subject, why: `Due for review — recall now about ${Math.round(recallNow(st!.card!, inp.now) * 100)}%.`, due: st!.card!.due, minutes: REVIEW_MIN });
  }

  if (inp.testDue) out.push({ kind: 'test', testId: inp.testDue.id, title: inp.testDue.title, why: 'The cumulative 3-day test is due.', minutes: inp.testDue.minutes });

  const cov = new Map(inp.progress.map((p) => [p.subject, p.coverage]));
  const sw = new Map(inp.subjects.map((s) => [s.id, s.examWeight || 1]));
  const learning = inp.concepts.filter((c) => {
    const st = inp.states.get(c.id);
    return !st || rungIndex(st.rung) < rungIndex('applied');
  });
  const notReady = new Set(learning.map((c) => c.id));
  const blocked = (c: Concept) => c.prereqs.some((p) => notReady.has(p) && p !== c.id && (inp.states.get(p)?.rung ?? 'none') === 'none');
  const started = (c: Concept) => rungIndex(inp.states.get(c.id)?.rung ?? 'none') >= rungIndex('seen');
  const hasPath = (c: Concept) => !!inp.paths.get(c.id)?.segments.some((s) => !s.dead);

  const score = (c: Concept) => (c.examWeight || 1) * (sw.get(c.subject) ?? 1) * (1 - (cov.get(c.subject) ?? 0));
  const syllabus = (a: Concept, b: Concept) => (a.week ?? 999) - (b.week ?? 999) || a.order - b.order;
  const ordered = [...learning].sort((a, b) => {
    const s = Number(started(b)) - Number(started(a));
    if (s) return s;
    const p = Number(hasPath(b)) - Number(hasPath(a));
    if (p) return p;
    const k = Number(blocked(a)) - Number(blocked(b));
    if (k) return k;
    if (inp.byWeight) return score(b) - score(a) || syllabus(a, b);
    const lag = (cov.get(a.subject) ?? 0) / (sw.get(a.subject) ?? 1) - (cov.get(b.subject) ?? 0) / (sw.get(b.subject) ?? 1);
    if (Math.abs(lag) > 1e-9 && a.subject !== b.subject) return lag;
    return syllabus(a, b);
  });

  const lowest = [...inp.progress].sort((a, b) => a.coverage - b.coverage)[0]?.subject;
  for (const c of ordered) {
    const st = inp.states.get(c.id);
    const path = inp.paths.get(c.id);
    const step = st?.nextStep ?? 'watch';
    const doneSegs = st?.mastery.exposure && path ? Math.round(st.mastery.exposure * path.segments.length) : 0;
    const segment = step === 'watch' ? nextSegment(path, st, doneSegs) : undefined;
    let why: string;
    if (!hasPath(c)) why = 'No resource yet — curation runs ahead of your queue tonight.';
    else if (st && st.missedChecks > 0 && step === 'watch') why = 'Missed the check — try the alternate explanation.';
    else if (started(c)) why = step === 'explain' ? 'Watched — now explain it in your own words.' : step === 'quick' ? 'Explained — now the quick check.' : step === 'lab' ? 'Checked — now implement it in the lab.' : 'Continue where you stopped.';
    else if (inp.byWeight) why = `Behind pace — high exam weight × weakness in ${c.subject}.`;
    else if (c.subject === lowest) why = `Next in your lowest-coverage subject${c.week ? ` (week ${c.week})` : ''}.`;
    else why = `Next in the syllabus${c.week ? ` (week ${c.week})` : ''}.`;
    if (blocked(c)) why = `${why} Needs ${c.prereqs.filter((p) => notReady.has(p)).map(title).join(', ')} first.`;
    out.push({ kind: 'learn', concept: c.id, title: c.title, subject: c.subject, why, step, ...(segment ? { segment } : {}), minutes: step === 'watch' ? segMinutes(segment, c.minutes || 30) : step === 'lab' ? 20 : 10 });
  }
  return inp.limit ? out.slice(0, inp.limit) : out;
}
