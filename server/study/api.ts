import type { EventKind, EventSource } from '../../src/core/study/types';
import { StudyError, type StudyService } from './service';

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
};
