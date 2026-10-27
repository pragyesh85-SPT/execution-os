// Small helpers shared by the Study OS engine: ids, timestamps and date arithmetic on YYYY-MM-DD keys.

import { addDays, parseKey } from '../time';

export const DAY_MS = 86_400_000;

/** "Eigenvalues & eigenvectors" → "eigenvalues-and-eigenvectors" (max 48 characters). */
export function slug(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
}

export const ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
export const isId = (s: unknown): s is string => typeof s === 'string' && ID_RE.test(s);

/** Seconds from 90, "90", "1:30", "01:02:03" (undefined when empty or unreadable). */
export function parseTime(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return Math.round(v);
  if (typeof v !== 'string' || !v.trim()) return undefined;
  const t = v.trim();
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(Number(t));
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(t);
  if (!m) return undefined;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

export const fmtTime = (sec: number) => {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
};

/** Whole days from date key `a` to date key `b` (negative when b is earlier). */
export const daysBetween = (a: string, b: string) => Math.round((parseKey(b).getTime() - parseKey(a).getTime()) / DAY_MS);

export { addDays };

export const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
export const round2 = (n: number) => Math.round(n * 100) / 100;
