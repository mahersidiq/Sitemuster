/**
 * Work-window rules shared by the app (instant feedback) and mirrored by the database
 * (app_private.normalize_work_windows, the authority): ISO weekday 1–7, "HH:MM" local times,
 * crosses_midnight derived, no overlaps including across midnight and Sunday→Monday.
 */
export interface WorkWindowInput {
  weekday: number;
  local_start_time: string;
  local_end_time: string;
}

export interface WorkWindow extends WorkWindowInput {
  crosses_midnight: boolean;
}

export type WorkWindowError =
  | 'WORK_WINDOW_REQUIRED'
  | 'TOO_MANY_WORK_WINDOWS'
  | 'INVALID_WORK_WINDOW_WEEKDAY'
  | 'INVALID_WORK_WINDOW_TIME'
  | 'EMPTY_WORK_WINDOW'
  | 'OVERLAPPING_WORK_WINDOWS';

const WEEK = 7 * 1440;

export function parseHhmm(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

export const DEFAULT_WORK_WINDOWS: readonly WorkWindowInput[] = [1, 2, 3, 4, 5, 6].map(
  (weekday) => ({
    weekday,
    local_start_time: '06:00',
    local_end_time: '18:00',
  }),
);

export function normalizeWorkWindows(
  windows: readonly WorkWindowInput[],
  operates24x7: boolean,
): { ok: true; windows: WorkWindow[] } | { ok: false; error: WorkWindowError } {
  if (windows.length > 42) return { ok: false, error: 'TOO_MANY_WORK_WINDOWS' };
  if (!operates24x7 && windows.length === 0) return { ok: false, error: 'WORK_WINDOW_REQUIRED' };
  const intervals: [number, number][] = [];
  const out: WorkWindow[] = [];
  for (const window of windows) {
    if (!Number.isInteger(window.weekday) || window.weekday < 1 || window.weekday > 7) {
      return { ok: false, error: 'INVALID_WORK_WINDOW_WEEKDAY' };
    }
    const start = parseHhmm(window.local_start_time);
    const end = parseHhmm(window.local_end_time);
    if (start === null || end === null) return { ok: false, error: 'INVALID_WORK_WINDOW_TIME' };
    if (start === end) return { ok: false, error: 'EMPTY_WORK_WINDOW' };
    const s = (window.weekday - 1) * 1440 + start;
    intervals.push([s, s + (end > start ? end - start : end + 1440 - start)]);
    out.push({ ...window, crosses_midnight: end < start });
  }
  for (let i = 0; i < intervals.length; i += 1) {
    for (let j = i + 1; j < intervals.length; j += 1) {
      const [s1, e1] = intervals[i] ?? [0, 0];
      const [s2, e2] = intervals[j] ?? [0, 0];
      if (
        (s1 < e2 && s2 < e1) ||
        (s1 < e2 + WEEK && s2 + WEEK < e1) ||
        (s1 + WEEK < e2 && s2 < e1 + WEEK)
      ) {
        return { ok: false, error: 'OVERLAPPING_WORK_WINDOWS' };
      }
    }
  }
  out.sort((a, b) => a.weekday - b.weekday || a.local_start_time.localeCompare(b.local_start_time));
  return { ok: true, windows: out };
}
