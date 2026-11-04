import { describe, expect, it } from 'vitest';

import { DEFAULT_WORK_WINDOWS, normalizeWorkWindows, parseHhmm } from './work-windows.ts';

const w = (weekday: number, start: string, end: string) => ({
  weekday,
  local_start_time: start,
  local_end_time: end,
});

describe('work windows (mirror of the database rules)', () => {
  it('accepts the spec default Monday–Saturday 06:00–18:00', () => {
    const result = normalizeWorkWindows(DEFAULT_WORK_WINDOWS, false);
    expect(result.ok && result.windows).toHaveLength(6);
  });

  it('derives crosses_midnight for overnight shifts', () => {
    const result = normalizeWorkWindows([w(1, '20:00', '04:00')], false);
    expect(result).toEqual({
      ok: true,
      windows: [{ ...w(1, '20:00', '04:00'), crosses_midnight: true }],
    });
  });

  it.each([
    [[w(1, '06:00', '18:00'), w(1, '17:00', '20:00')], 'same-day overlap'],
    [[w(1, '20:00', '04:00'), w(2, '03:00', '10:00')], 'overnight into the next day'],
    [[w(7, '22:00', '06:00'), w(1, '05:00', '09:00')], 'Sunday night into Monday'],
  ])('rejects overlap: %j (%s)', (windows) => {
    expect(normalizeWorkWindows(windows, false)).toEqual({
      ok: false,
      error: 'OVERLAPPING_WORK_WINDOWS',
    });
  });

  it('allows back-to-back shifts and multiple shifts per day', () => {
    expect(
      normalizeWorkWindows(
        [w(1, '06:00', '14:00'), w(1, '14:00', '22:00'), w(1, '22:00', '06:00')],
        false,
      ).ok,
    ).toBe(true);
  });

  it('validates bounds and requires a schedule unless 24/7', () => {
    expect(normalizeWorkWindows([], false)).toEqual({ ok: false, error: 'WORK_WINDOW_REQUIRED' });
    expect(normalizeWorkWindows([], true)).toEqual({ ok: true, windows: [] });
    expect(normalizeWorkWindows([w(8, '06:00', '18:00')], false)).toEqual({
      ok: false,
      error: 'INVALID_WORK_WINDOW_WEEKDAY',
    });
    expect(normalizeWorkWindows([w(1, '24:00', '18:00')], false)).toEqual({
      ok: false,
      error: 'INVALID_WORK_WINDOW_TIME',
    });
    expect(normalizeWorkWindows([w(1, '06:00', '06:00')], false)).toEqual({
      ok: false,
      error: 'EMPTY_WORK_WINDOW',
    });
    expect(parseHhmm('7:00')).toBeNull();
  });
});
