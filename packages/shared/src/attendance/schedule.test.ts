import { describe, expect, it } from 'vitest';

import { configFromSettings } from './config.ts';
import { scheduleFor } from './schedule.ts';
import { iso, ms } from './time.ts';

const TZ = 'America/Chicago';
const WEEK = [1, 2, 3, 4, 5, 6].map((weekday) => ({
  weekday,
  local_start_time: '06:00',
  local_end_time: '18:00',
}));

function config(settings: Record<string, unknown>) {
  return configFromSettings({
    configVersionId: 'cv',
    projectId: 'p',
    versionNumber: 1,
    effectiveAt: '2026-01-01T00:00:00Z',
    settings,
    center: { lat: 29.76, lng: -95.37 },
  });
}

const at = (value: string) => scheduleFor(ms(value), config({ work_windows: WEEK }), TZ);

describe('shift schedule snapshot', () => {
  it('closes out an in-window session at window end + 60 min', () => {
    const s = at('2026-11-03T12:01:00Z');
    expect(s.scheduled).toBe(true);
    expect(iso(s.closeoutAt)).toBe('2026-11-04T01:00:00Z');
  });

  it('treats the 60 minutes before a window as authorized (grace)', () => {
    expect(at('2026-11-03T11:00:00Z').scheduled).toBe(true);
    expect(at('2026-11-03T10:59:00Z').scheduled).toBe(false);
  });

  it('marks an off-hours arrival unscheduled and prepares automatic authorization', () => {
    const s = at('2026-11-03T09:00:00Z');
    expect(s.scheduled).toBe(false);
    expect(iso(s.authorizeAt ?? 0)).toBe('2026-11-03T11:00:00Z');
    expect(iso(s.closeoutAt)).toBe('2026-11-03T11:00:00Z');
    expect(iso(s.authorizedCloseoutAt ?? 0)).toBe('2026-11-04T01:00:00Z');
  });

  it('caps the close-out of an unscheduled Sunday session at 16 hours', () => {
    const s = at('2026-11-08T15:00:00Z');
    expect(s.scheduled).toBe(false);
    expect(iso(s.closeoutAt)).toBe('2026-11-09T07:00:00Z');
  });

  it('attributes an overnight window to the day it starts', () => {
    const s = scheduleFor(
      ms('2026-11-04T05:00:00Z'),
      config({
        work_windows: [{ weekday: 2, local_start_time: '20:00', local_end_time: '04:00' }],
      }),
      TZ,
    );
    expect(s.scheduled).toBe(true);
    expect(iso(s.windowStart ?? 0)).toBe('2026-11-04T02:00:00Z');
    expect(iso(s.closeoutAt)).toBe('2026-11-04T11:00:00Z');
  });

  it('chains a split shift (lunch break within the grace period)', () => {
    const s = scheduleFor(
      ms('2026-11-03T12:30:00Z'),
      config({
        work_windows: [
          { weekday: 2, local_start_time: '06:00', local_end_time: '12:00' },
          { weekday: 2, local_start_time: '12:30', local_end_time: '18:00' },
        ],
      }),
      TZ,
    );
    expect(iso(s.closeoutAt)).toBe('2026-11-04T01:00:00Z');
  });

  it('ends an overnight window across the DST fall-back at the real instant', () => {
    const s = scheduleFor(
      ms('2026-11-01T03:01:00Z'),
      config({
        work_windows: [{ weekday: 6, local_start_time: '22:00', local_end_time: '06:00' }],
      }),
      TZ,
    );
    expect(iso(s.windowEnd ?? 0)).toBe('2026-11-01T12:00:00Z');
  });

  it('never restricts a 24/7 site but still reviews after 16 hours', () => {
    const s = scheduleFor(ms('2026-11-08T09:00:00Z'), config({ operates_24_7: true }), TZ);
    expect(s.scheduled).toBe(true);
    expect(iso(s.closeoutAt)).toBe('2026-11-09T01:00:00Z');
  });
});
