import { recallNow } from './fsrs';
import { addDays, clamp01, daysBetween } from './ids';
import { rungIndex, type Assessment, type Concept, type ConceptState, type FsrsCard, type Progress, type SubjectProgress } from './types';

// The numbers on the Study home screen. Every one is computed from evidence (ConceptState) — the
// ladder, review cards and Execution OS session minutes — never typed in.

export interface ProgressInput {
  today: string;
  now: number;
  assessment: Assessment;
  concepts: Concept[]; // syllabus concepts (merged duplicates excluded)
  states: Map<string, ConceptState & { card?: FsrsCard | null }>;
  released: (c: Concept) => boolean;
  iitj: { lectures: number; lecturesWatched: number; assignments: number; assignmentsSubmitted: number };
  studyMinutesToday: number;
  studyMinutesTotal: number;
}

export const readyByOf = (a: Pick<Assessment, 'readyBy' | 'examStart'>) => a.readyBy || addDays(a.examStart, -15);

const applied = (s: ConceptState | undefined) => !!s && rungIndex(s.rung) >= rungIndex('applied');
const retained = (s: ConceptState | undefined) => !!s && rungIndex(s.rung) >= rungIndex('retained');

export function progress(inp: ProgressInput): Progress {
  const { assessment: a, today, now } = inp;
  const readyBy = readyByOf(a);
  const subjects: SubjectProgress[] = a.subjects.map((s) => {
    const cs = inp.concepts.filter((c) => c.subject === s.id);
    const rel = cs.filter(inp.released);
    const w = cs.reduce((acc, c) => acc + (c.examWeight || 1), 0);
    const ready = cs.reduce((acc, c) => {
      const st = inp.states.get(c.id);
      return acc + (retained(st) && st?.card ? (c.examWeight || 1) * recallNow(st.card, now) : 0);
    }, 0);
    const ap = cs.filter((c) => applied(inp.states.get(c.id))).length;
    const rap = rel.filter((c) => applied(inp.states.get(c.id))).length;
    return {
      subject: s.id,
      title: s.title,
      concepts: cs.length,
      applied: ap,
      coverage: cs.length ? ap / cs.length : 0,
      released: rel.length,
      releasedApplied: rap,
      releasedCoverage: rel.length ? rap / rel.length : 0,
      readiness: w ? ready / w : 0,
    };
  });

  const total = inp.concepts.length;
  const done = subjects.reduce((acc, s) => acc + s.applied, 0);
  const rel = subjects.reduce((acc, s) => acc + s.released, 0);
  const relDone = subjects.reduce((acc, s) => acc + s.releasedApplied, 0);
  const sw = a.subjects.reduce((acc, s) => acc + (s.examWeight || 1), 0) || 1;
  const readiness = subjects.reduce((acc, s, i) => acc + s.readiness * ((a.subjects[i].examWeight || 1) / sw), 0);

  // Pace: concepts reaching Applied per day (3-day average) versus what is needed to finish by readyBy.
  const remaining = total - done;
  const daysLeft = Math.max(1, daysBetween(today, readyBy) + 1);
  const elapsed = Math.max(0, daysBetween(a.studyStart, today)); // full days before today
  const window = Math.max(1, Math.min(3, elapsed + 1));
  const from = addDays(today, -(window - 1));
  const recent = inp.concepts.filter((c) => {
    const t = inp.states.get(c.id)?.reachedAt.applied;
    if (t === undefined) return false;
    const d = new Date(t);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return key >= from && key <= today;
  }).length;
  const averagePerDay = recent / window;
  const neededPerDay = remaining / daysLeft;
  const span = Math.max(1, daysBetween(a.studyStart, readyBy) + 1);
  const expected = today < a.studyStart ? 0 : (total * Math.min(span, elapsed + 1)) / span;
  const behindBy = Math.max(0, Math.round(expected - done));
  let status: Progress['pace']['status'];
  if (!total || (done === 0 && elapsed < 1)) status = 'no_data';
  else if (behindBy > 0) status = 'behind';
  else status = done > expected + 1 ? 'ahead' : 'on_pace';

  let projectedReady: string | null;
  if (total && remaining <= 0) projectedReady = today;
  else if (averagePerDay > 0) projectedReady = addDays(today, Math.ceil(remaining / averagePerDay)); // counted from tomorrow
  else projectedReady = null;
  const reorderedByWeight = total > 0 && remaining > 0 && elapsed >= 1 && (projectedReady === null || projectedReady > readyBy);

  const lec = inp.iitj;
  const iitjAll = lec.lectures + lec.assignments;
  return {
    date: today,
    examStart: a.examStart,
    readyBy,
    daysToExam: daysBetween(today, a.examStart),
    daysToReady: daysBetween(today, readyBy),
    coverage: total ? done / total : 0,
    releasedCoverage: rel ? relDone / rel : 0,
    readiness: clamp01(readiness),
    iitjTrack: iitjAll ? (lec.lecturesWatched + lec.assignmentsSubmitted) / iitjAll : 0,
    iitj: lec,
    pace: { status, neededPerDay, averagePerDay, behindBy, remaining },
    projectedReady,
    subjects,
    studyMinutesToday: Math.round(inp.studyMinutesToday),
    studyMinutesTotal: Math.round(inp.studyMinutesTotal),
    reorderedByWeight,
  };
}
