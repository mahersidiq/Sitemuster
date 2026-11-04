import {
  addDays,
  formatLocalDate,
  isoWeekStart,
  localDateOf,
  parseLocalDate,
  type HoursCsvRow,
  type WorkerDayHours,
} from '@sitemuster/shared';

import { localDateTime } from '../fallbacks/fallbacks';

/**
 * Display helpers for daily reports and the worker's hours (Milestone 10). Every number shown is an
 * ESTIMATE of onsite time (never payroll); dates are project-local calendar days.
 */

/** Today and the previous `days - 1` project-local dates, newest first. */
export function recentLocalDates(timeZone: string, now: number, days: number): string[] {
  const today = localDateOf(now, timeZone);
  return Array.from({ length: days }, (_, i) => formatLocalDate(addDays(today, -i)));
}

/** Monday of this week and of last week (project-local), for the hours screen. */
export function weekStarts(timeZone: string, now: number): { current: string; previous: string } {
  const current = isoWeekStart(formatLocalDate(localDateOf(now, timeZone)));
  return { current, previous: formatLocalDate(addDays(parseLocalDate(current), -7)) };
}

/** "Tue, Nov 3" / "mar, 3 nov" for a project-local date (no time zone shift). */
export function formatLocalDateLabel(localDate: string, locale: string): string {
  const [y, m, d] = localDate.split('-').map(Number);
  return new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)));
}

/** Hours with two decimals in the reader's language ("8.50"). */
export function formatHours(seconds: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(seconds / 3600);
}

/** Machine-friendly hours for the CSV (always a dot, two decimals). */
export function csvHours(seconds: number): string {
  return (seconds / 3600).toFixed(2);
}

/** One CSV row per visit of the worker's own days (dates and times in the project time zone). */
export function hoursCsvRows(
  days: readonly WorkerDayHours[],
  projectName: string,
  timeZone: string,
  statusLabel: (status: string, needsReview: boolean) => string,
  onSiteLabel: string,
): HoursCsvRow[] {
  return days.flatMap((day) =>
    day.sessions.map((session) => ({
      date: day.local_date,
      project: projectName,
      arrival: localDateTime(session.start_at, timeZone).time,
      departure: session.end_at ? localDateTime(session.end_at, timeZone).time : onSiteLabel,
      estimatedHours: csvHours(session.definite_seconds),
      status: statusLabel(session.status, session.needs_review),
    })),
  );
}
