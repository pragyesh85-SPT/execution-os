// Time helpers. A "logical day" starts at settings.dayStart (default 04:00, the end of sleep)
// and runs 24h, so the 21:00 -> 04:00 sleep block is the last block of its day.

export const MIN = 60_000;
export const DAY_MIN = 1440;

export const pad = (n: number) => String(n).padStart(2, '0');

export function dateKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parseKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(key: string, n: number): string {
  const d = parseKey(key);
  d.setDate(d.getDate() + n);
  return dateKey(d);
}

export function logicalDate(nowMs: number, dayStart: number): string {
  const d = new Date(nowMs);
  const minutes = d.getHours() * 60 + d.getMinutes();
  if (minutes < dayStart) d.setDate(d.getDate() - 1);
  return dateKey(d);
}

export function dayStartMs(key: string, dayStart: number): number {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d, Math.floor(dayStart / 60), dayStart % 60, 0, 0).getTime();
}

/** Minutes (fractional) since the logical day began. */
export function offsetOf(nowMs: number, key: string, dayStart: number): number {
  return (nowMs - dayStartMs(key, dayStart)) / MIN;
}

export function offsetToMs(offset: number, key: string, dayStart: number): number {
  return dayStartMs(key, dayStart) + offset * MIN;
}

/** Day offset -> clock minute (0..1439). */
export function clockOf(offset: number, dayStart: number): number {
  return (((dayStart + offset) % DAY_MIN) + DAY_MIN) % DAY_MIN;
}

/** Clock minute -> offset inside a day that starts at dayStart. */
export function offsetFromClock(clock: number, dayStart: number): number {
  return (((clock - dayStart) % DAY_MIN) + DAY_MIN) % DAY_MIN;
}

export function fmtClock(clock: number, h24 = false): string {
  const c = ((Math.round(clock) % DAY_MIN) + DAY_MIN) % DAY_MIN;
  const h = Math.floor(c / 60);
  const m = c % 60;
  if (h24) return `${pad(h)}:${pad(m)}`;
  const ap = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${pad(m)} ${ap}`;
}

export function fmtDur(min: number): string {
  const m = Math.max(0, Math.round(min));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return `${r}m`;
  if (r === 0) return `${h}h`;
  return `${h}h ${pad(r)}m`;
}

export function fmtCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

export function parseClock(text: string): number | null {
  const m = /^\s*(\d{1,2}):(\d{2})\s*(am|pm)?\s*$/i.exec(text);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  const ap = m[3]?.toLowerCase();
  if (min > 59 || h > 23) return null;
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  return h * 60 + min;
}

/** Monday of the week containing the given date key. */
export function weekKey(key: string): string {
  const d = parseKey(key);
  const wd = (d.getDay() + 6) % 7; // Monday = 0
  d.setDate(d.getDate() - wd);
  return dateKey(d);
}

export function weekDays(weekStart: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function longDate(key: string): string {
  const d = parseKey(key);
  return `${WEEKDAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

export function shortDate(key: string): string {
  const d = parseKey(key);
  return `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}`;
}
