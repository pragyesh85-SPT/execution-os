// One-scan pairing and connection failover (device side).
// The PC's QR is a link: <base>/#pair=<base64url(JSON)>. The fragment never reaches a server or a log.

export interface PairPayload {
  v: 1;
  h: string; // hub id
  n: string; // hub name
  t: string; // single-use pairing token
  u: string[]; // hub URLs, LAN first, then Tailscale
}

const toB64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s: string) => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};

export function encodePair(base: string, p: PairPayload): string {
  return `${base.replace(/\/$/, '')}/#pair=${toB64url(new TextEncoder().encode(JSON.stringify(p)))}`;
}

/** Read a pairing payload from a scanned/opened link (http(s)://…/#pair=…, executionos://pair#pair=…). */
export function parsePair(text: string): PairPayload | null {
  const m = /[#&]pair=([A-Za-z0-9_-]+)/.exec(text ?? '');
  if (!m) return null;
  try {
    const j = JSON.parse(new TextDecoder().decode(fromB64url(m[1]))) as Partial<PairPayload>;
    if (j.v !== 1 || typeof j.h !== 'string' || typeof j.t !== 'string' || !Array.isArray(j.u)) return null;
    const u = j.u.filter((x): x is string => typeof x === 'string' && /^https?:\/\//.test(x)).slice(0, 6);
    if (!u.length) return null;
    return { v: 1, h: j.h, n: typeof j.n === 'string' ? j.n : 'PC', t: j.t, u };
  } catch {
    return null;
  }
}

export type PathKind = 'wifi' | 'tailscale' | 'https';

export function urlKind(url: string): PathKind {
  try {
    const host = new URL(url).hostname;
    if (host.endsWith('.ts.net')) return 'https';
    const [a, b] = host.split('.').map(Number);
    if (a === 100 && b >= 64 && b <= 127) return 'tailscale';
  } catch {
    /* fall through */
  }
  return 'wifi';
}

export const PATH_LABEL: Record<PathKind, string> = { wifi: 'Home Wi-Fi', tailscale: 'Tailscale', https: 'Tailscale (secure)' };

/** LAN first, then Tailscale, then the private HTTPS name. Stable within each kind. */
export function orderUrls(urls: string[]): string[] {
  const rank: Record<PathKind, number> = { wifi: 0, tailscale: 1, https: 2 };
  return [...new Set(urls)].sort((a, b) => rank[urlKind(a)] - rank[urlKind(b)]);
}

export type FindResult = { ok: true; url: string } | { ok: false; reason: 'unreachable' } | { ok: false; reason: 'other_hub'; url: string };

/**
 * Try the last good address first, then the others in order. Accept only a hub whose /api/ping
 * reports the stored hubId — a different Execution OS at the same address is never used silently.
 */
export async function findHub(urls: string[], hubId: string | undefined, opts: { lastGood?: string; fetchFn?: typeof fetch; timeoutMs?: number } = {}): Promise<FindResult> {
  const f = opts.fetchFn ?? fetch;
  const list = [...new Set([...(opts.lastGood ? [opts.lastGood] : []), ...orderUrls(urls)])];
  let other: string | null = null;
  for (const url of list) {
    try {
      const res = await f(`${url.replace(/\/$/, '')}/api/ping`, { cache: 'no-store', signal: AbortSignal.timeout(opts.timeoutMs ?? 3000) });
      if (!res.ok) continue;
      const j = (await res.json()) as { app?: string; hubId?: string };
      if (j.app !== 'execution-os') continue;
      if (hubId && j.hubId && j.hubId !== hubId) {
        other = other ?? url;
        continue;
      }
      return { ok: true, url };
    } catch {
      /* try the next address */
    }
  }
  return other ? { ok: false, reason: 'other_hub', url: other } : { ok: false, reason: 'unreachable' };
}
