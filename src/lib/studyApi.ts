import { hubRequest } from '../state/sync';

// The Study tab talks only to the hub on the PC (/api/study/<method>). Offline, the phone keeps today's
// pack (next 3 items, their check packs, due reviews) and queues answers; they are sent, in order,
// the next time the PC is reachable. The Quick Tutor itself needs the PC (and its provider).

export class StudyApiError extends Error {
  constructor(
    message: string,
    readonly status: number, // 0 = the PC could not be reached
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export async function studyCall<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  let res: Response;
  try {
    res = await hubRequest(`study/${method}`, { method: 'POST', body: JSON.stringify(params), signal: AbortSignal.timeout(method.startsWith('test') || method === 'labRun' ? 120_000 : 30_000) });
  } catch {
    throw new StudyApiError('Your PC is not reachable right now (or this device is not paired yet).', 0);
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new StudyApiError(String(body.error ?? `The PC answered ${res.status}`), res.status, body);
  return body as T;
}

// ---------- offline cache ----------

const CACHE = 'eos.study.cache.v1';
const QUEUE = 'eos.study.queue.v1';

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or blocked: the cache is a convenience */
  }
}

export const cacheGet = <T>(name: string): T | null => read<Record<string, T>>(CACHE, {})[name] ?? null;
export function cacheSet(name: string, value: unknown) {
  write(CACHE, { ...read<Record<string, unknown>>(CACHE, {}), [name]: value });
}

export interface Queued {
  method: string;
  params: Record<string, unknown>;
  at: number;
}

export const queued = (): Queued[] => read<Queued[]>(QUEUE, []);
export function enqueue(method: string, params: Record<string, unknown>) {
  write(QUEUE, [...queued(), { method, params, at: Date.now() }]);
}

/** Send queued answers in order; stops at the first one the PC cannot take yet. */
export async function flushQueue(): Promise<number> {
  let sent = 0;
  for (const q of queued()) {
    try {
      await studyCall(q.method, q.params);
    } catch (e) {
      if (e instanceof StudyApiError && e.status === 0) break; // still offline
      // refused (e.g. the pack changed): drop it rather than block the queue forever
    }
    write(QUEUE, queued().slice(1));
    sent++;
  }
  return sent;
}

export { youtubeId } from '../core/study/ids';
