import type { Settings } from './types';

// Join links from imported email are untrusted. A one-tap Join is offered only for allow-listed
// meeting domains over https; anything else shows its real domain and a warning first.

export const DEFAULT_JOIN_DOMAINS = ['zoom.us', '*.zoom.us', 'meet.google.com', 'teams.microsoft.com', 'teams.live.com', 'iitj.ac.in', '*.iitj.ac.in'];

export function joinDomains(s: Pick<Settings, 'joinDomains'>): string[] {
  return [...new Set([...DEFAULT_JOIN_DOMAINS, ...(s.joinDomains ?? [])].map((d) => d.trim().toLowerCase()).filter(Boolean))];
}

export interface LinkCheck {
  ok: boolean; // https and on the allow-list → one-tap Join
  https: boolean;
  domain: string;
}

export function checkJoinLink(url: string | undefined, s: Pick<Settings, 'joinDomains'>): LinkCheck | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, https: false, domain: url.slice(0, 60) };
  }
  const host = u.hostname.toLowerCase();
  const https = u.protocol === 'https:';
  const allowed = joinDomains(s).some((d) => (d.startsWith('*.') ? host.endsWith(d.slice(1)) && host !== d.slice(2) : host === d));
  return { ok: https && allowed, https, domain: host };
}
