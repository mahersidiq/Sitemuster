import { describe, expect, it } from 'vitest';

import {
  addDays,
  HOUR,
  iso,
  isoWeekday,
  localDayRange,
  maxIso,
  ms,
  parseLocalDate,
  zonedParts,
  zonedToUtc,
} from './time.ts';

const CHICAGO = 'America/Chicago';

describe('project-local time (DST-aware)', () => {
  it('converts local wall-clock times to UTC instants', () => {
    expect(iso(zonedToUtc(parseLocalDate('2026-11-03'), 6 * 60, CHICAGO))).toBe(
      '2026-11-03T12:00:00Z',
    );
    expect(iso(zonedToUtc(parseLocalDate('2026-07-01'), 6 * 60, CHICAGO))).toBe(
      '2026-07-01T11:00:00Z',
    );
  });

  it('resolves a repeated fall-back time to the earlier instant', () => {
    expect(iso(zonedToUtc(parseLocalDate('2026-11-01'), 90, CHICAGO))).toBe('2026-11-01T06:30:00Z');
  });

  it('moves a non-existent spring-forward time forward by the gap', () => {
    const instant = zonedToUtc(parseLocalDate('2026-03-08'), 150, CHICAGO);
    expect(iso(instant)).toBe('2026-03-08T08:30:00Z');
    expect(zonedParts(instant, CHICAGO).hour).toBe(3);
  });

  it('gives 23, 24 and 25 hour local days around DST changes', () => {
    const length = (date: string) => {
      const [start, end] = localDayRange(parseLocalDate(date), CHICAGO);
      return (end - start) / HOUR;
    };
    expect(length('2026-03-08')).toBe(23);
    expect(length('2026-11-03')).toBe(24);
    expect(length('2026-11-01')).toBe(25);
  });

  it('does calendar arithmetic on local dates', () => {
    expect(isoWeekday(parseLocalDate('2026-11-03'))).toBe(2);
    expect(isoWeekday(parseLocalDate('2026-11-08'))).toBe(7);
    expect(addDays(parseLocalDate('2026-10-31'), 1)).toEqual({ year: 2026, month: 11, day: 1 });
  });

  it('formats instants canonically and compares them as instants', () => {
    expect(iso(ms('2026-11-03T12:00:00.000Z'))).toBe('2026-11-03T12:00:00Z');
    expect(iso(ms('2026-11-03T12:00:00.250Z'))).toBe('2026-11-03T12:00:00.250Z');
    expect(maxIso('2026-11-03T12:00:00Z', '2026-11-03T06:30:00-06:00')).toBe(
      '2026-11-03T06:30:00-06:00',
    );
    expect(maxIso(null, '2026-11-03T12:00:00Z')).toBe('2026-11-03T12:00:00Z');
    expect(() => ms('not a time')).toThrow();
  });
});
