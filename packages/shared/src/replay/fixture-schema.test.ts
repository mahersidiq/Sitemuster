import { describe, expect, it } from 'vitest';

import { LocationTraceFixtureSchema } from './fixture-schema.ts';

const specExample = {
  fixture_version: 1,
  id: 'already-inside-after-restart',
  project: {
    id: '00000000-0000-4000-8000-000000000001',
    timezone: 'America/Chicago',
    config_version: 1,
    radius_m: 150,
    lat: 29.7604,
    lng: -95.3698,
  },
  clock_start_utc: '2026-11-03T12:00:00Z',
  initial_state: 'ARMED_OFFSITE',
  inputs: [
    { at_utc: '2026-11-03T12:01:00Z', type: 'APP_FOREGROUND' },
    { at_utc: '2026-11-03T12:01:10Z', type: 'FIX', lat: 29.7604, lng: -95.3698, accuracy_m: 15 },
    { at_utc: '2026-11-03T12:11:10Z', type: 'FIX', lat: 29.7604, lng: -95.3698, accuracy_m: 16 },
  ],
  expected: {
    presence: 'ONSITE_ESTIMATED',
    session_count: 1,
    arrival_at: '2026-11-03T12:01:10Z',
    counted_worker_count: 1,
    unresolved_count: 0,
  },
};

describe('LocationTraceFixtureSchema (docs/spec/10-testing.md file contract)', () => {
  it('accepts the exact example from the spec', () => {
    expect(LocationTraceFixtureSchema.safeParse(specExample).success).toBe(true);
  });

  it('rejects unknown input types and unknown keys', () => {
    expect(
      LocationTraceFixtureSchema.safeParse({
        ...specExample,
        inputs: [{ at_utc: '2026-11-03T12:01:00Z', type: 'TELEPORT' }],
      }).success,
    ).toBe(false);
    expect(LocationTraceFixtureSchema.safeParse({ ...specExample, extra: true }).success).toBe(
      false,
    );
  });

  it('rejects radius outside the 150–2000 m bounds and inputs that go back in time', () => {
    expect(
      LocationTraceFixtureSchema.safeParse({
        ...specExample,
        project: { ...specExample.project, radius_m: 100 },
      }).success,
    ).toBe(false);
    expect(
      LocationTraceFixtureSchema.safeParse({
        ...specExample,
        inputs: [specExample.inputs[1], specExample.inputs[0]],
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown expected presence state', () => {
    expect(
      LocationTraceFixtureSchema.safeParse({
        ...specExample,
        expected: { ...specExample.expected, presence: 'ON_SITE' },
      }).success,
    ).toBe(false);
  });
});
