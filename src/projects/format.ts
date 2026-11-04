import type { WorkWindowInput } from '@sitemuster/shared';

/** Locale-aware display helpers. Server values (UTC instants, HH:MM local) are never altered. */

const FEET_PER_METER = 3.28084;

export function metersToFeet(meters: number): number {
  return Math.round(meters * FEET_PER_METER);
}

/** "06:00" → "6:00 AM" (en-US) / "6:00 a.m." (es-US); returns the raw value when invalid. */
export function formatLocalTime(hhmm: string, locale: string): string {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!match) return hhmm;
  const date = new Date(Date.UTC(1970, 0, 1, Number(match[1]), Number(match[2])));
  return new Intl.DateTimeFormat(locale, {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(date);
}

/** Current wall-clock time in the project's IANA zone (shown when choosing the zone). */
export function formatNowInZone(timeZone: string, locale: string, now: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
      timeZone,
    }).format(now);
  } catch {
    return timeZone;
  }
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date(0));
    return timeZone.includes('/') || timeZone === 'UTC';
  } catch {
    return false;
  }
}

/** Date + time of a server UTC instant in the project's zone (phone zone when none applies). */
export function formatInstant(iso: string, timeZone: string | undefined, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export function sortWindows(windows: readonly WorkWindowInput[]): WorkWindowInput[] {
  return [...windows].sort(
    (a, b) => a.weekday - b.weekday || a.local_start_time.localeCompare(b.local_start_time),
  );
}
