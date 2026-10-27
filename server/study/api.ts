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

export const METHODS: Record<string, Method> = {
  status: { run: (svc) => svc.status() },
  next: { run: (svc) => svc.next() },
};

export const str = (v: unknown, name: string, max = 2000): string => {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`"${name}" is required`);
  return v.trim().slice(0, max);
};
export const optStr = (v: unknown, max = 2000): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
export const num = (v: unknown, name: string, min = -Infinity, max = Infinity): number => {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) throw new Error(`"${name}" must be a number between ${min} and ${max}`);
  return n;
};
