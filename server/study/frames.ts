// Can a resource page be shown inside the Study tab? A site decides that with two headers:
//   X-Frame-Options: DENY | SAMEORIGIN            → not inside our app
//   Content-Security-Policy: frame-ancestors …    → only the listed origins may frame it
// The hub checks once (cached for a day) and the tab shows the page in place, or opens it in the browser.
// Only links that appear in the vault's resource paths are checked (no arbitrary fetches through the hub).

export interface FrameVerdict {
  url: string;
  embeddable: boolean;
  pdf: boolean;
  reason: string;
}

/** Pure: the verdict from response headers (keys lower-case). */
export function embeddable(headers: Record<string, string>): { embeddable: boolean; pdf: boolean; reason: string } {
  const pdf = /application\/pdf/i.test(headers['content-type'] ?? '');
  const xfo = (headers['x-frame-options'] ?? '').trim().toUpperCase();
  if (xfo === 'DENY' || xfo === 'SAMEORIGIN' || xfo.startsWith('ALLOW-FROM')) return { embeddable: false, pdf, reason: `the site sends X-Frame-Options: ${xfo}` };
  const csp = headers['content-security-policy'] ?? '';
  const fa = /(?:^|;)\s*frame-ancestors\s+([^;]*)/i.exec(csp)?.[1]?.trim();
  if (fa !== undefined && !/(^|\s)\*(\s|$)/.test(fa) && !/(^|\s)https?:(\s|$)/.test(fa)) return { embeddable: false, pdf, reason: `the site only allows framing by: ${fa || "'none'"}` };
  return { embeddable: true, pdf, reason: pdf ? 'a PDF the site lets us show' : 'the site allows showing it inside the app' };
}

export type HeadFetcher = (url: string) => Promise<{ ok: boolean; status: number; headers: Record<string, string> }>;

const defaultFetcher: HeadFetcher = async (url) => {
  const r = await fetch(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'Mozilla/5.0 (Study OS link check)' } });
  const headers: Record<string, string> = {};
  r.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
  void r.body?.cancel();
  return { ok: r.ok, status: r.status, headers };
};

const cache = new Map<string, { at: number; v: FrameVerdict }>();

export async function checkFrame(url: string, fetcher: HeadFetcher = defaultFetcher, now = Date.now()): Promise<FrameVerdict> {
  const hit = cache.get(url);
  if (hit && now - hit.at < 86_400_000) return hit.v;
  let v: FrameVerdict;
  try {
    const r = await fetcher(url);
    v = r.ok ? { url, ...embeddable(r.headers) } : { url, embeddable: false, pdf: false, reason: `the site answered ${r.status}` };
  } catch (e) {
    v = { url, embeddable: false, pdf: false, reason: `could not reach the site (${(e as Error).message})` };
  }
  cache.set(url, { at: now, v });
  return v;
}

export const clearFrameCache = () => cache.clear();
