import { describe, expect, it } from 'vitest';

import { DEFAULT_WORK_WINDOWS } from '@sitemuster/shared';

import { blocksFromWindows, crossesMidnight, validateSchedule, windowsFromBlocks } from './shifts';

describe('schedule shift blocks', () => {
  it('groups the default Mon–Sat 06:00–18:00 schedule into one shift and back', () => {
    const blocks = blocksFromWindows(DEFAULT_WORK_WINDOWS);
    expect(blocks).toEqual([{ days: [1, 2, 3, 4, 5, 6], start: '06:00', end: '18:00' }]);
    expect(windowsFromBlocks(blocks)).toEqual([...DEFAULT_WORK_WINDOWS]);
  });

  it('keeps day and night shifts as separate blocks (multiple windows per weekday)', () => {
    const blocks = blocksFromWindows([
      { weekday: 1, local_start_time: '06:00', local_end_time: '14:00' },
      { weekday: 1, local_start_time: '20:00', local_end_time: '04:00' },
      { weekday: 2, local_start_time: '06:00', local_end_time: '14:00' },
    ]);
    expect(blocks).toEqual([
      { days: [1, 2], start: '06:00', end: '14:00' },
      { days: [1], start: '20:00', end: '04:00' },
    ]);
    expect(crossesMidnight(blocks[1]!)).toBe(true);
    expect(validateSchedule(blocks, false).ok).toBe(true);
  });

  it('reports the same errors as the server', () => {
    expect(validateSchedule([], false)).toEqual({ ok: false, error: 'WORK_WINDOW_REQUIRED' });
    expect(validateSchedule([{ days: [], start: '06:00', end: '18:00' }], false)).toEqual({
      ok: false,
      error: 'SHIFT_NEEDS_DAYS',
    });
    expect(validateSchedule([{ days: [1], start: '6am', end: '18:00' }], false)).toEqual({
      ok: false,
      error: 'INVALID_WORK_WINDOW_TIME',
    });
    expect(
      validateSchedule(
        [
          { days: [1], start: '20:00', end: '04:00' },
          { days: [2], start: '03:00', end: '10:00' },
        ],
        false,
      ),
    ).toEqual({ ok: false, error: 'OVERLAPPING_WORK_WINDOWS' });
    expect(validateSchedule([{ days: [1], start: '07:00', end: '07:00' }], false)).toEqual({
      ok: false,
      error: 'EMPTY_WORK_WINDOW',
    });
  });

  it('needs no windows when the site operates 24/7', () => {
    expect(validateSchedule([], true)).toEqual({ ok: true, windows: [] });
  });
});
