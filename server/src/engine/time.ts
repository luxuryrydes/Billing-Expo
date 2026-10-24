/**
 * Duty times are recorded as local wall-clock date-times (no timezone) on duty
 * slips. We treat them as naive timestamps and do minute arithmetic in UTC so
 * that no host timezone or DST rule can shift a duty.
 */
const RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/;

/** Minutes since epoch for a naive 'YYYY-MM-DD HH:MM[:SS]' string, or null if invalid. */
export function toMinutes(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = RE.exec(s.trim());
  if (!m) return null;
  const [y, mo, d, h, mi] = [m[1], m[2], m[3], m[4], m[5]].map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const ms = Date.UTC(y, mo - 1, d, h, mi);
  const back = new Date(ms);
  if (back.getUTCDate() !== d) return null; // e.g. 31 Feb
  return Math.floor(ms / 60000);
}

export function dateOnlyToMinutes(date: string): number | null {
  return toMinutes(`${date} 00:00`);
}

export function hhmmToMinutes(s: string): number {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}

export function weekday(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

export function daysBetweenInclusive(from: string, to: string): number {
  const a = dateOnlyToMinutes(from)!;
  const b = dateOnlyToMinutes(to)!;
  return Math.round((b - a) / 1440) + 1;
}

/**
 * Counts night windows a duty overlaps by at least `minOverlap` minutes.
 * Windows are generated for every calendar day touched by the duty (and the
 * day before, to catch a window that started the previous evening).
 */
export function nightOverlap(
  startMin: number,
  endMin: number,
  windowStart: string,
  windowEnd: string,
  minOverlap: number,
): { nights: number; minutes: number } {
  const ws = hhmmToMinutes(windowStart);
  const we = hhmmToMinutes(windowEnd);
  const len = we > ws ? we - ws : 1440 - ws + we;
  const firstDay = Math.floor(startMin / 1440) - 1;
  const lastDay = Math.floor(endMin / 1440);
  let nights = 0;
  let minutes = 0;
  for (let day = firstDay; day <= lastDay; day++) {
    const s = day * 1440 + ws;
    const e = s + len;
    const ov = Math.max(0, Math.min(e, endMin) - Math.max(s, startMin));
    if (ov > 0 && ov >= Math.max(1, minOverlap)) {
      nights++;
      minutes += ov;
    }
  }
  return { nights, minutes };
}
