import { newCard, recallNow, review, type Grade } from './fsrs';
import { DAY_MS } from './ids';
import { MISTAKE_CLASSES, type ConceptState, type FsrsCard, type Mastery, type MistakeClass, type Repair, type Rung, type StudyEvent } from './types';

// The status ladder, the mastery dimensions, review cards and repair items — all computed from
// evidence events, never stored. The Quick Tutor and Claude write evidence; only this file decides
// what that evidence means.
//
// Evidence data by kind:
//   segment_done  { index?, url?, alternate? }             a resource segment watched to the end
//   iitj_lecture  { asset?, lecture? }                     an IITJ lecture watched (counts as Seen)
//   explain       { coverage 0..1, pass }                  explanation checked against the pack
//   quick         { question, correct, repair? }           one quick question
//   lab           { passed, passedTests, total }           hidden tests of the lab
//   review        { grade 1..4 }                           spaced review (2+ = recalled)
//   test_item     { correct, score 0..1, timed, transfer, kind }
//   mistake       { cls, detail }                          a classified mistake
//   repair_done   { key }                                  the repair's retest was passed

export const UNDERSTOOD_AT = 0.8; // share of key points
export const APPLIED_AT = 0.8; // quick-check accuracy
export const RETAIN_AFTER_DAYS = 3;
export const REPAIR_AFTER = 2; // the same mistake twice

export interface LadderInput {
  concept: string;
  events: StudyEvent[]; // this concept only, any order
  packQuestions: number; // quick questions in the pack (0 = no pack yet)
  hasLab: boolean;
  pathLength: number; // segments in the resource path
  now: number;
}

const byTime = (a: StudyEvent, b: StudyEvent) => a.at - b.at || a.seq - b.seq;
const yes = (v: unknown) => v === true || v === 'true' || v === 1;
const n01 = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : null);

/** Review grade of an event that tests recall (null = not a recall event). */
function recallGrade(e: StudyEvent): Grade | null {
  if (e.kind === 'review') {
    const g = Number(e.data.grade);
    return g >= 1 && g <= 4 ? (Math.round(g) as Grade) : yes(e.data.correct) ? 3 : 1;
  }
  if (e.kind === 'test_item') return yes(e.data.correct) ? 3 : 1;
  return null;
}

/** Replay the review card from the moment the concept was Applied. */
export function replayCard(events: StudyEvent[], appliedAt: number | undefined): FsrsCard | null {
  if (appliedAt === undefined) return null;
  let card = newCard(appliedAt, 3);
  for (const e of [...events].sort(byTime)) {
    if (e.at <= appliedAt) continue;
    const g = recallGrade(e);
    if (g) card = review(card, e.at, g);
  }
  return card;
}

export function conceptState(inp: LadderInput): ConceptState & { card: FsrsCard | null } {
  const ev = [...inp.events].sort(byTime);
  const reached: Partial<Record<Rung, number>> = {};
  const segs = new Set<string>();
  let seenAt: number | undefined;
  let understoodAt: number | undefined;
  let bestCoverage: number | null = null;
  const latestQuick = new Map<string, { correct: boolean; at: number }>();
  let quickOkAt: number | undefined;
  let labAt: number | undefined;
  let bestLab: number | null = null;
  let missed = 0;
  let lastCheckFailed = false;
  let watchedSinceFail = false;

  for (const e of ev) {
    switch (e.kind) {
      case 'segment_done':
      case 'iitj_lecture':
        seenAt ??= e.at;
        if (e.kind === 'segment_done') segs.add(String(e.data.index ?? e.data.url ?? segs.size));
        if (lastCheckFailed) watchedSinceFail = true;
        break;
      case 'explain': {
        const c = n01(e.data.coverage);
        if (c !== null) bestCoverage = Math.max(bestCoverage ?? 0, c);
        const pass = e.data.pass === undefined ? (c ?? 0) >= UNDERSTOOD_AT : yes(e.data.pass);
        if (pass && (c ?? 1) >= UNDERSTOOD_AT) {
          understoodAt ??= e.at;
          missed = 0;
          lastCheckFailed = false;
        } else {
          missed++;
          lastCheckFailed = true;
          watchedSinceFail = false;
        }
        break;
      }
      case 'quick': {
        const q = String(e.data.question ?? `q${e.seq}`);
        latestQuick.set(q, { correct: yes(e.data.correct), at: e.at });
        const answered = [...latestQuick.values()];
        const need = Math.max(1, Math.min(5, inp.packQuestions || 5));
        const acc = answered.filter((a) => a.correct).length / answered.length;
        if (answered.length >= need && acc >= APPLIED_AT) {
          quickOkAt ??= e.at;
          missed = 0;
          lastCheckFailed = false;
        } else if (!yes(e.data.correct) && answered.length >= need) {
          missed++;
          lastCheckFailed = true;
          watchedSinceFail = false;
        }
        break;
      }
      case 'lab': {
        const total = Number(e.data.total) || 0;
        const passedTests = Number(e.data.passedTests) || 0;
        if (total > 0) bestLab = Math.max(bestLab ?? 0, passedTests / total);
        if (yes(e.data.passed)) labAt ??= e.at;
        break;
      }
    }
  }

  if (seenAt !== undefined) reached.seen = seenAt;
  if (reached.seen !== undefined && understoodAt !== undefined) reached.understood = Math.max(reached.seen, understoodAt);
  const labDone = inp.hasLab ? labAt : (quickOkAt ?? undefined);
  if (reached.understood !== undefined && quickOkAt !== undefined && labDone !== undefined) reached.applied = Math.max(reached.understood, quickOkAt, labDone);

  // Retained: correct recall at least 3 days after Applied. Exam-ready: a correct timed test item and a correct transfer item.
  let retainedAt: number | undefined;
  let timedAt: number | undefined;
  let transferAt: number | undefined;
  const testItems = ev.filter((e) => e.kind === 'test_item');
  for (const e of ev) {
    const g = recallGrade(e);
    if (reached.applied !== undefined && g && g >= 2 && e.at >= reached.applied + RETAIN_AFTER_DAYS * DAY_MS) retainedAt ??= e.at;
    if (e.kind === 'test_item' && yes(e.data.correct)) {
      if (e.data.timed !== false) timedAt ??= e.at;
      if (yes(e.data.transfer)) transferAt ??= e.at;
    }
  }
  if (reached.applied !== undefined && retainedAt !== undefined) reached.retained = retainedAt;
  if (reached.retained !== undefined && timedAt !== undefined && transferAt !== undefined) reached.exam_ready = Math.max(reached.retained, timedAt, transferAt);

  const order: Rung[] = ['seen', 'understood', 'applied', 'retained', 'exam_ready'];
  let rung: Rung = 'none';
  for (const r of order) if (reached[r] !== undefined) rung = r;

  const card = replayCard(ev, reached.applied);
  const answered = [...latestQuick.values()];
  const share = (xs: StudyEvent[]) => (xs.length ? xs.filter((e) => yes(e.data.correct)).length / xs.length : null);
  const mastery: Mastery = {
    exposure: inp.pathLength ? Math.min(1, segs.size / inp.pathLength) : segs.size ? 1 : null,
    understanding: bestCoverage,
    recall: answered.length ? answered.filter((a) => a.correct).length / answered.length : null,
    application: share(testItems.filter((e) => e.data.kind !== 'programming')),
    implementation: bestLab ?? share(testItems.filter((e) => e.data.kind === 'programming')),
    retention: card ? recallNow(card, inp.now) : null,
    transfer: share(testItems.filter((e) => yes(e.data.transfer))),
    speed: share(testItems.filter((e) => e.data.timed !== false)),
  };

  let nextStep: ConceptState['nextStep'];
  if (lastCheckFailed && !watchedSinceFail) nextStep = 'watch'; // a miss sends you to an alternate segment
  else if (reached.seen === undefined) nextStep = 'watch';
  else if (reached.understood === undefined) nextStep = 'explain';
  else if (quickOkAt === undefined) nextStep = 'quick';
  else if (reached.applied === undefined) nextStep = 'lab';
  else if (reached.retained === undefined) nextStep = 'review';
  else if (reached.exam_ready === undefined) nextStep = 'test';
  else nextStep = 'done';

  return { concept: inp.concept, rung, reachedAt: reached, mastery, nextStep, missedChecks: missed, card };
}

// ---------- repairs: the same mistake twice ----------

export const repairKey = (concept: string, cls: string, detail = '') => `${concept}|${cls}|${detail.trim().toLowerCase().slice(0, 80)}`;

/** Open repair items: a (concept, class, detail) seen at least twice since its last passed retest. */
export function openRepairs(events: StudyEvent[]): Repair[] {
  const counts = new Map<string, Repair>();
  for (const e of [...events].sort(byTime)) {
    if (e.kind === 'repair_done') {
      counts.delete(String(e.data.key ?? ''));
      continue;
    }
    if (e.kind !== 'mistake' || !e.concept) continue;
    const cls = (MISTAKE_CLASSES as string[]).includes(String(e.data.cls)) ? (String(e.data.cls) as MistakeClass) : 'concept_gap';
    const detail = typeof e.data.detail === 'string' ? e.data.detail : '';
    const key = repairKey(e.concept, cls, detail);
    const r = counts.get(key);
    if (r) {
      r.count++;
      r.lastAt = e.at;
      if (r.count === REPAIR_AFTER) r.openedAt = e.at;
    } else counts.set(key, { key, concept: e.concept, cls, detail: detail.trim(), count: 1, openedAt: e.at, lastAt: e.at });
  }
  return [...counts.values()].filter((r) => r.count >= REPAIR_AFTER).sort((a, b) => b.lastAt - a.lastAt);
}
