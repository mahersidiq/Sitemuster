import { describe, expect, it } from 'vitest';

import {
  formatInstant,
  formatLocalTime,
  formatNowInZone,
  isValidTimeZone,
  metersToFeet,
} from './format';

describe('project display formatting', () => {
  it('shows readable AM/PM times in English and Spanish', () => {
    expect(formatLocalTime('06:00', 'en-US')).toBe('6:00 AM');
    expect(formatLocalTime('18:30', 'en-US')).toBe('6:30 PM');
    expect(formatLocalTime('06:00', 'es-US')).toMatch(/^6:00\s?a/);
    expect(formatLocalTime('bad', 'en-US')).toBe('bad');
  });

  it('formats instants in the project zone, not the phone zone', () => {
    const iso = '2026-11-04T12:00:00Z';
    expect(formatInstant(iso, 'America/Chicago', 'en-US')).toMatch(/6:00\s?AM/);
    expect(formatInstant(iso, 'America/Los_Angeles', 'en-US')).toMatch(/4:00\s?AM/);
    expect(formatNowInZone('America/Chicago', 'en-US', new Date(iso))).toMatch(/6:00\s?AM CST/);
  });

  it('validates IANA zones and converts meters to feet', () => {
    expect(isValidTimeZone('America/Chicago')).toBe(true);
    expect(isValidTimeZone('Mars/Base')).toBe(false);
    expect(metersToFeet(150)).toBe(492);
  });
});
