import type { EventKind, EventSource } from '../../src/core/study/types';
import { StudyError } from './errors';
import type { StudyService } from './service';

// The Study API: one method table, served by the hub at /api/study/<method> and called directly by the
// `study` CLI when the hub is not running. Same table, same code path, so the CLI and the app can
// never drift apart. Reads are GET (?p=<json>) or POST; writes are POST.

export interface CallCtx {
  local: boolean; // the request comes from this PC (loopback)
  device: string; // who is calling: "this PC", "Android", "mcp:claude", "cli"
}

export interface Method {
  write?: boolean;
  local?: boolean; // only from this PC (settings that hold keys, paths)
  run: (svc: StudyService, params: Record<string, unknown>, ctx: CallCtx) => unknown | Promise<unknown>;
}

export const str = (v: unknown, name: string, max = 2000): string => {
  if (typeof v !== 'string' || !v.trim()) throw new StudyError(`"${name}" is required`);
  return v.trim().slice(0, max);
};
export const optStr = (v: unknown, max = 2000): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
export const num = (v: unknown, name: string, min = -Infinity, max = Infinity): number => {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) throw new StudyError(`"${name}" must be a number between ${min} and ${max}`);
  return n;
};
const optNum = (v: unknown, name: string, min?: number, max?: number) => (v === undefined || v === null || v === '' ? undefined : num(v, name, min, max));
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Who wrote a piece of evidence. The app and phones are "app"; the CLI may say "claude" (headless jobs). */
export function sourceOf(params: Record<string, unknown>, ctx: CallCtx): EventSource {
  if (ctx.device.startsWith('mcp:')) return 'mcp';
  const s = params.source;
  if (ctx.local && (s === 'claude' || s === 'cli' || s === 'app' || s === 'test' || s === 'lab' || s === 'tutor')) return s;
  return ctx.device === 'cli' || ctx.device === 'study CLI' ? 'cli' : 'app';
}

export const METHODS: Record<string, Method> = {
  status: { run: (svc) => svc.status() },
  overview: { run: (svc) => svc.overview() },
  next: { run: (svc, p) => svc.next({ limit: optNum(p.limit, 'limit', 1, 200) }) },
  progress: { run: (svc) => svc.progress() },
  concepts: { run: (svc, p) => ({ concepts: svc.conceptList({ subject: optStr(p.subject, 80) }) }) },
  concept: { run: (svc, p) => svc.conceptView({ id: str(p.id, 'id', 80) }) },
  session: { run: (svc, p) => svc.session({ id: str(p.id, 'id', 80) }) },
  pending: { run: (svc) => svc.pending() },
  assets: { run: (svc, p) => svc.assets({ status: optStr(p.status, 20), subject: optStr(p.subject, 80) }) },
  reindex: { write: true, run: (svc) => svc.reindex() },
  state: { write: true, run: (svc) => svc.writeState() },
  log: {
    write: true,
    run: (svc, p, ctx) => svc.log({ kind: str(p.kind, 'kind', 40) as EventKind, concept: optStr(p.concept, 80), data: obj(p.data), source: sourceOf(p, ctx) }),
  },
  segment: {
    write: true,
    run: (svc, p, ctx) => svc.log({ kind: 'segment_done', concept: str(p.concept, 'concept', 80), data: { index: optNum(p.index, 'index', 0, 20), url: optStr(p.url, 2000), alternate: p.alternate === true, seconds: optNum(p.seconds, 'seconds', 0, 86_400) }, source: sourceOf(p, ctx) }),
  },
  activity: { write: true, run: (svc) => svc.activity() },
  start: { write: true, run: (svc, p) => svc.start({ concept: optStr(p.concept, 80) }) },
  stop: { write: true, run: (svc, p) => svc.stop({ note: optStr(p.note, 500) }) },
  ingest: {
    write: true,
    local: true,
    run: (svc, p) => svc.ingest({ folder: str(p.folder, 'folder', 1000), subject: optStr(p.subject, 80), week: optNum(p.week, 'week', 0, 60), type: optStr(p.type, 20), move: p.move === true }),
  },
  assetDone: { write: true, local: true, run: (svc, p) => svc.assetDone({ id: str(p.id, 'id', 100) }) },
  deadlineSubmit: { write: true, run: (svc, p) => svc.deadlineSubmit({ id: str(p.id, 'id', 80) }) },
  iitjLecture: { write: true, run: (svc, p) => svc.iitjLecture({ asset: str(p.asset, 'asset', 100), concept: optStr(p.concept, 80) }) },

  // ---------- Quick Tutor (P2) ----------
  tutorStatus: { run: (svc) => svc.tutor.status() },
  tutorExplain: { write: true, run: (svc, p) => svc.tutor.explain({ concept: str(p.concept, 'concept', 80), text: str(p.text, 'text', 8000) }) },
  tutorAnswer: { write: true, run: (svc, p) => svc.tutor.answer({ concept: str(p.concept, 'concept', 80), question: str(p.question, 'question', 80), answer: str(p.answer, 'answer', 2000), repair: optStr(p.repair, 200) }) },
  tutorAudit: { local: true, run: (svc, p) => svc.tutor.audit({ limit: optNum(p.limit, 'limit', 1, 1000) }) },
  tutorRegrade: {
    write: true,
    local: true,
    run: (svc, p) =>
      svc.tutor.regrade({
        id: str(p.id, 'id', 80),
        agree: p.agree === true,
        coverage: optNum(p.coverage, 'coverage', 0, 1),
        pass: typeof p.pass === 'boolean' ? p.pass : undefined,
        correct: typeof p.correct === 'boolean' ? p.correct : undefined,
        note: optStr(p.note, 500),
        mistakes: Array.isArray(p.mistakes) ? (p.mistakes as { cls: never; detail?: string }[]).slice(0, 5) : undefined,
      }),
  },

  // ---------- labs ----------
  labRun: { write: true, run: (svc, p) => svc.runLab({ lab: optStr(p.lab, 80), concept: optStr(p.concept, 80), code: typeof p.code === 'string' ? p.code : '' }) },

  // ---------- the 3-day test ----------
  tests: { run: (svc) => ({ tests: svc.exams.list(), nextDue: svc.model().assessment ? svc.exams.nextDue() : null }) },
  testPlan: { run: (svc, p) => svc.exams.plan({ written: optNum(p.written, 'written', 1, 20), programming: optNum(p.programming, 'programming', 0, 5) }) },
  testBuildDue: { run: (svc) => svc.exams.buildDue() },
  testsAwaitingGrade: { run: (svc) => ({ tests: svc.exams.awaitingGrade() }) },
  testBuild: { write: true, local: true, run: (svc, p) => svc.exams.build({ id: optStr(p.id, 10) }) },
  testCheck: { run: (svc, p) => svc.exams.check({ id: str(p.id, 'id', 10) }) },
  testStart: { write: true, run: (svc, p) => svc.exams.start({ id: str(p.id, 'id', 10), subject: optStr(p.subject, 80) }) },
  testSubmit: { write: true, run: (svc, p) => svc.exams.submit({ id: str(p.id, 'id', 10), subject: optStr(p.subject, 80), answers: obj(p.answers) as Record<string, { text?: string; image?: string; code?: string }> }) },
  testFinalize: { write: true, local: true, run: (svc, p) => svc.exams.finalize({ id: str(p.id, 'id', 10) }) },
  testReport: { run: (svc, p) => svc.exams.report({ id: str(p.id, 'id', 10) }) },

  // ---------- proposals, audit and undo (P3) ----------
  proposals: { run: (svc, p) => ({ proposals: svc.proposals.list({ status: optStr(p.status, 20) }) }) },
  proposalApply: { write: true, run: (svc, p, ctx) => svc.proposals.apply({ id: str(p.id, 'id', 80), by: ctx.device }) },
  proposalReject: { write: true, run: (svc, p) => svc.proposals.reject({ id: str(p.id, 'id', 80) }) },
  changes: { run: (svc) => ({ changes: svc.proposals.auditList() }) },
  undo: { write: true, run: (svc, p) => svc.proposals.undo({ seq: num(p.seq, 'seq', 1) }) },

  // ---------- phone, portfolio, graph ----------
  capture: { write: true, run: (svc, p, ctx) => svc.capture({ text: typeof p.text === 'string' ? p.text : '', url: optStr(p.url, 2000), subject: optStr(p.subject, 80), from: ctx.device }) },
  offlinePack: { run: (svc) => svc.offlinePack() },
  portfolio: { write: true, local: true, run: (svc) => svc.portfolio() },
  dedupe: { run: (svc) => svc.dedupe() },

  // ---------- headless jobs ----------
  jobs: { run: (svc) => ({ jobs: svc.jobs() }) },
  jobReport: {
    write: true,
    local: true,
    run: (svc, p) => {
      svc.db.sql.prepare('INSERT INTO jobs (job, ok, started, ended, log, note) VALUES (?, ?, ?, ?, ?, ?)').run(str(p.job, 'job', 40), p.ok === true ? 1 : 0, optNum(p.started, 'started') ?? null, svc.clock(), optStr(p.log, 1000) ?? null, optStr(p.note, 1000) ?? null);
      return { ok: true };
    },
  },
};
