import { parseHhmm } from '../config/work-windows.ts';
import {
  addDays,
  HOUR,
  isoWeekday,
  type LocalDate,
  localDateOf,
  MINUTE,
  zonedToUtc,
} from './time.ts';
import type { AttendanceConfig } from './types.ts';

/**
 * Shift windows in project-local time → UTC instants (docs/spec/04 "Work shifts, grace and 24/7",
 * docs/spec/06 "Work windows and midnight behavior"). A window that starts Monday 20:00 and ends
 * Tuesday 04:00 is Monday's shift. DST: local times resolve with "compatible" disambiguation.
 */
export interface WindowInstance {
  start: number;
  end: number;
}

export function windowInstances(
  config: Pick<AttendanceConfig, 'windows'>,
  timeZone: string,
  fromDate: LocalDate,
  days: number,
): WindowInstance[] {
  const out: WindowInstance[] = [];
  for (let offset = 0; offset < days; offset += 1) {
    const date = addDays(fromDate, offset);
    const weekday = isoWeekday(date);
    for (const window of config.windows) {
      if (window.weekday !== weekday) continue;
      const startMinutes = parseHhmm(window.local_start_time);
      const endMinutes = parseHhmm(window.local_end_time);
      if (startMinutes === null || endMinutes === null || startMinutes === endMinutes) continue;
      const crosses = endMinutes < startMinutes;
      const start = zonedToUtc(date, startMinutes, timeZone);
      const end = zonedToUtc(crosses ? addDays(date, 1) : date, endMinutes, timeZone);
      if (end > start) out.push({ start, end });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

export interface ScheduleSnapshot {
  /** True when the instant is inside an authorized window ± grace (or the site runs 24/7). */
  scheduled: boolean;
  windowStart: number | null;
  windowEnd: number | null;
  /** From this instant a stale session becomes UNRESOLVED (never an invented exit). */
  closeoutAt: number;
  /** Unscheduled only: the next authorized window start minus grace. */
  authorizeAt: number | null;
  /** Unscheduled only: close-out instant that applies once the session is authorized. */
  authorizedCloseoutAt: number | null;
}

function chainEnd(instances: WindowInstance[], index: number, graceMs: number): number {
  let end = instances[index]?.end ?? 0;
  for (let i = index + 1; i < instances.length; i += 1) {
    const next = instances[i];
    if (!next || next.start - end > graceMs) break;
    end = Math.max(end, next.end);
  }
  return end;
}

/**
 * Schedule facts for a session (or arrival candidate) that starts at `start`, computed once and
 * stored on the session so the database sweep never needs calendar or DST logic.
 * - 24/7: close-out review after `always_open_24h_review_open_hours` (16 h) once stale.
 * - Inside a window ± grace: close-out at the end of that window (chained with windows that
 *   follow within the grace period, e.g. a split lunch shift) + close-out grace.
 * - Outside every window: UNSCHEDULED_PENDING; authorized automatically only if the worker is
 *   still evidenced on site when the next window (minus grace) begins; close-out after 16 h or
 *   at that moment, whichever is first.
 */
export function scheduleFor(
  start: number,
  config: AttendanceConfig,
  timeZone: string,
): ScheduleSnapshot {
  const reviewMs = config.alwaysOpenReviewHours * HOUR;
  if (config.operates24x7) {
    return {
      scheduled: true,
      windowStart: null,
      windowEnd: null,
      closeoutAt: start + reviewMs,
      authorizeAt: null,
      authorizedCloseoutAt: null,
    };
  }
  const graceMs = config.workWindowGraceMinutes * MINUTE;
  const closeoutGraceMs = config.closeoutGraceMinutes * MINUTE;
  const today = localDateOf(start, timeZone);
  const instances = windowInstances(config, timeZone, addDays(today, -1), 10);

  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  instances.forEach((window, index) => {
    if (start < window.start - graceMs || start > window.end + graceMs) return;
    const distance =
      start < window.start ? window.start - start : start > window.end ? start - window.end : 0;
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  });
  if (best >= 0) {
    const window = instances[best] as WindowInstance;
    const end = chainEnd(instances, best, graceMs);
    return {
      scheduled: true,
      windowStart: window.start,
      windowEnd: end,
      closeoutAt: end + closeoutGraceMs,
      authorizeAt: null,
      authorizedCloseoutAt: null,
    };
  }
  const nextIndex = instances.findIndex((window) => window.start - graceMs > start);
  if (nextIndex >= 0) {
    const next = instances[nextIndex] as WindowInstance;
    const authorizeAt = next.start - graceMs;
    return {
      scheduled: false,
      windowStart: null,
      windowEnd: null,
      closeoutAt: Math.min(start + reviewMs, authorizeAt),
      authorizeAt,
      authorizedCloseoutAt: chainEnd(instances, nextIndex, graceMs) + closeoutGraceMs,
    };
  }
  return {
    scheduled: false,
    windowStart: null,
    windowEnd: null,
    closeoutAt: start + reviewMs,
    authorizeAt: null,
    authorizedCloseoutAt: null,
  };
}
