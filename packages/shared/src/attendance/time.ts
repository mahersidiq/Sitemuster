/**
 * Instants and project-local calendar arithmetic for the attendance engine (docs/spec/04, 06).
 * Everything is stored and compared in UTC milliseconds; local dates and times are derived with
 * the IANA zone through Intl (DST-aware). No Date arithmetic in local time anywhere else.
 */

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export function ms(iso: string): number {
  const value = Date.parse(iso);
  if (Number.isNaN(value)) throw new Error(`invalid instant: ${iso}`);
  return value;
}

/** Canonical UTC ISO string: `YYYY-MM-DDTHH:mm:ssZ` (milliseconds kept only when non-zero). */
export function iso(value: number): string {
  const text = new Date(value).toISOString();
  return text.endsWith('.000Z') ? `${text.slice(0, -5)}Z` : text;
}

export function maxIso(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return ms(a) >= ms(b) ? a : b;
}

export interface LocalDate {
  year: number;
  month: number;
  day: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export interface LocalDateTime extends LocalDate {
  hour: number;
  minute: number;
  second: number;
}

export function zonedParts(instant: number, timeZone: string): LocalDateTime {
  const parts: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(instant))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year ?? 1970,
    month: parts.month ?? 1,
    day: parts.day ?? 1,
    hour: parts.hour ?? 0,
    minute: parts.minute ?? 0,
    second: parts.second ?? 0,
  };
}

/** UTC offset of the zone at an instant, in milliseconds (local = utc + offset). */
export function zoneOffset(instant: number, timeZone: string): number {
  const p = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant / SECOND) * SECOND;
}

export function addDays(date: LocalDate, days: number): LocalDate {
  const value = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate() };
}

/** ISO weekday (Monday = 1 … Sunday = 7) of a local calendar date. */
export function isoWeekday(date: LocalDate): number {
  const dow = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
  return ((dow + 6) % 7) + 1;
}

export function localDateOf(instant: number, timeZone: string): LocalDate {
  const p = zonedParts(instant, timeZone);
  return { year: p.year, month: p.month, day: p.day };
}

export function formatLocalDate(date: LocalDate): string {
  return `${String(date.year).padStart(4, '0')}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
}

export function parseLocalDate(text: string): LocalDate {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) throw new Error(`invalid local date: ${text}`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/**
 * The UTC instant of a local wall-clock time on a local date, with the same disambiguation as
 * Temporal's "compatible" mode: a time that occurs twice (DST fall-back) resolves to the earlier
 * instant; a time that does not exist (DST spring-forward gap) moves forward by the gap.
 */
export function zonedToUtc(date: LocalDate, minutesOfDay: number, timeZone: string): number {
  const naive = Date.UTC(date.year, date.month - 1, date.day, 0, minutesOfDay);
  const before = zoneOffset(naive - DAY, timeZone);
  const after = zoneOffset(naive + DAY, timeZone);
  const candidates = [...new Set([naive - before, naive - after])].sort((a, b) => a - b);
  const matches = candidates.filter((candidate) => {
    const p = zonedParts(candidate, timeZone);
    return (
      p.year === date.year &&
      p.month === date.month &&
      p.day === date.day &&
      p.hour * 60 + p.minute === minutesOfDay
    );
  });
  if (matches.length > 0) return matches[0] ?? naive - before;
  // Gap: apply the offset in force before the transition, which lands after the gap.
  return naive - before;
}

/** [start, end) of a project-local calendar day in UTC milliseconds (23, 24 or 25 hours long). */
export function localDayRange(date: LocalDate, timeZone: string): [number, number] {
  return [zonedToUtc(date, 0, timeZone), zonedToUtc(addDays(date, 1), 0, timeZone)];
}
