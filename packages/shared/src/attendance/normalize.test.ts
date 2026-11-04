import { describe, expect, it } from 'vitest';

import { combineResults, type DeviceContext, normalizeSdkRecord } from './normalize.ts';

const P = '00000000-0000-4000-8000-000000000001';
const Q = '00000000-0000-4000-8000-000000000002';
const UUID = '11111111-1111-4111-8111-111111111111';
const NOW = '2026-11-03T12:00:05Z';
const device: DeviceContext = {
  deviceId: '22222222-2222-4222-8222-222222222222',
  workerId: '33333333-3333-4333-8333-333333333333',
  fences: [
    {
      projectId: P,
      configVersionId: 'cv-p',
      identifier: 'sm_p',
      center: { lat: 29.7604, lng: -95.3698 },
      nativeRadiusM: 200,
    },
    {
      projectId: Q,
      configVersionId: 'cv-q',
      identifier: 'sm_q',
      center: { lat: 29.7604, lng: -95.3682 },
      nativeRadiusM: 200,
    },
  ],
};
const base = { uuid: UUID, timestamp: '2026-11-03T12:00:00Z' };

describe('SDK record normalization', () => {
  it('resolves a geofence record only through the device bindings', () => {
    const out = normalizeSdkRecord(
      device,
      {
        ...base,
        event: 'geofence',
        geofence: { identifier: 'sm_p', action: 'ENTER' },
        accuracy: 12,
      },
      NOW,
    );
    expect(out.kind).toBe('evidence');
    if (out.kind === 'evidence') {
      expect(out.evidence).toEqual([
        expect.objectContaining({
          kind: 'GEOFENCE',
          projectId: P,
          configVersionId: 'cv-p',
          action: 'ENTER',
          accuracyM: 12,
          workerId: device.workerId,
        }),
      ]);
    }
  });

  it('rejects an unbound fence identifier without looking anywhere else', () => {
    const out = normalizeSdkRecord(
      device,
      {
        ...base,
        event: 'geofence',
        geofence: { identifier: 'sm_other_tenant', action: 'ENTER' },
        accuracy: 12,
      },
      NOW,
    );
    expect(out).toMatchObject({
      kind: 'terminal',
      result: { status: 'rejected', reason: 'PROJECT_NOT_AUTHORIZED' },
      receipt: { project_id: null },
    });
  });

  it('refuses coordinates on geofence and provider-change records and quarantines them without coordinates', () => {
    const exit = normalizeSdkRecord(
      device,
      {
        ...base,
        event: 'geofence',
        geofence: { identifier: 'sm_p', action: 'EXIT' },
        accuracy: 9,
        coords: { latitude: 29.9, longitude: -95.3, accuracy: 9 },
      },
      NOW,
    );
    expect(exit).toMatchObject({
      kind: 'terminal',
      result: { reason: 'COORDINATES_NOT_PERMITTED' },
    });
    expect(exit.kind === 'terminal' && JSON.stringify(exit.quarantine)).not.toMatch(
      /latitude|longitude|coords/,
    );
    const provider = normalizeSdkRecord(
      device,
      {
        ...base,
        event: 'providerchange',
        coords: { latitude: 29.9, longitude: -95.3, accuracy: 9 },
      },
      NOW,
    );
    expect(provider).toMatchObject({
      kind: 'terminal',
      result: { reason: 'PROVIDER_CHANGE_DISCARDED' },
    });
  });

  it('accepts a fix only inside a bound native fence', () => {
    const inside = normalizeSdkRecord(
      device,
      {
        ...base,
        event: 'location',
        coords: { latitude: 29.7605, longitude: -95.371, accuracy: 10 },
      },
      NOW,
    );
    expect(inside.kind === 'evidence' && inside.evidence.map((e) => e.projectId)).toEqual([P]);
    const outside = normalizeSdkRecord(
      device,
      { ...base, event: 'location', coords: { latitude: 29.8, longitude: -95.3698, accuracy: 10 } },
      NOW,
    );
    expect(outside).toMatchObject({
      kind: 'terminal',
      result: { status: 'rejected', reason: 'COORDINATES_NOT_PERMITTED' },
      receipt: { event_type: 'ONSITE_FIX' },
    });
  });

  it('refuses every coordinate while continuous coordinates are not released (decision #90)', () => {
    const gated: DeviceContext = { ...device, coordinatesAllowed: false };
    const fix = {
      ...base,
      event: 'location',
      coords: { latitude: 29.7604, longitude: -95.3698, accuracy: 10 },
    };
    const out = normalizeSdkRecord(gated, fix, NOW);
    expect(out).toMatchObject({
      kind: 'terminal',
      result: { status: 'rejected', reason: 'COORDINATES_NOT_PERMITTED' },
      receipt: { event_type: 'ONSITE_FIX', terminal_result: 'rejected' },
    });
    if (out.kind === 'terminal')
      expect(JSON.stringify(out.quarantine)).not.toMatch(/29\.76|-95\.36/);
    // Coordinate-free geofence metadata still works in limited mode.
    const enter = normalizeSdkRecord(
      gated,
      {
        ...base,
        event: 'geofence',
        geofence: { identifier: 'sm_p', action: 'ENTER' },
        accuracy: 12,
      },
      NOW,
    );
    expect(enter.kind).toBe('evidence');
  });

  it('marks a fix inside two overlapping projects as ambiguous for both (derived uuids)', () => {
    const out = normalizeSdkRecord(
      device,
      {
        ...base,
        event: 'location',
        coords: { latitude: 29.7604, longitude: -95.369, accuracy: 10 },
      },
      NOW,
    );
    expect(out.kind).toBe('evidence');
    if (out.kind === 'evidence') {
      expect(out.evidence).toHaveLength(2);
      expect(out.evidence.every((e) => e.kind === 'FIX' && e.ambiguous)).toBe(true);
      expect(new Set(out.evidence.map((e) => e.eventUuid)).size).toBe(2);
      expect(out.evidence.some((e) => e.eventUuid === UUID)).toBe(false);
    }
  });

  it('turns permission and provider changes into monitoring evidence for every bound project', () => {
    const denied = normalizeSdkRecord(
      device,
      { ...base, event: 'providerchange', provider: { enabled: true, status: 2 } },
      NOW,
    );
    expect(
      denied.kind === 'evidence' && denied.evidence.map((e) => e.kind === 'MONITORING' && e.change),
    ).toEqual(['UNAVAILABLE', 'UNAVAILABLE']);
    const reduced = normalizeSdkRecord(
      device,
      {
        ...base,
        event: 'providerchange',
        provider: { enabled: true, status: 3, accuracyAuthorization: 1 },
      },
      NOW,
    );
    expect(
      reduced.kind === 'evidence' &&
        reduced.evidence[0]?.kind === 'MONITORING' &&
        reduced.evidence[0].change,
    ).toBe('UNAVAILABLE');
    const restored = normalizeSdkRecord(
      device,
      {
        ...base,
        event: 'providerchange',
        provider: { enabled: true, status: 3, accuracyAuthorization: 0 },
      },
      NOW,
    );
    expect(
      restored.kind === 'evidence' &&
        restored.evidence[0]?.kind === 'MONITORING' &&
        restored.evidence[0].change,
    ).toBe('RESTARTED');
  });

  it('treats a position-less heartbeat as proof of life, and a restart marker as monitoring evidence', () => {
    expect(normalizeSdkRecord(device, { ...base, event: 'heartbeat' }, NOW)).toMatchObject({
      kind: 'terminal',
      result: { status: 'accepted' },
    });
    const restart = normalizeSdkRecord(
      device,
      { ...base, event: 'heartbeat', extras: { sitemuster_monitoring: 'RESTARTED' } },
      NOW,
    );
    expect(restart.kind === 'evidence' && restart.evidence[0]?.kind).toBe('MONITORING');
  });

  it('rejects malformed records', () => {
    expect(normalizeSdkRecord(device, { uuid: 'nope', event: 'location' }, NOW)).toMatchObject({
      kind: 'terminal',
      result: null,
    });
    expect(normalizeSdkRecord(device, { ...base, event: 'location' }, NOW)).toMatchObject({
      result: { reason: 'INVALID_RECORD' },
    });
  });

  it('combines fan-out results into the one result the SDK receives', () => {
    const accepted = {
      eventUuid: 'a',
      status: 'accepted' as const,
      reason: 'AMBIGUOUS_PROJECT',
      review: true,
    };
    const dup = { eventUuid: 'b', status: 'duplicate' as const, reason: null, review: false };
    expect(combineResults(UUID, [accepted, dup])).toMatchObject({
      eventUuid: UUID,
      status: 'accepted',
      review: true,
    });
    expect(combineResults(UUID, [dup, dup])).toMatchObject({ status: 'duplicate' });
    expect(
      combineResults(UUID, [{ eventUuid: 'c', status: 'rejected', reason: 'X', review: false }]),
    ).toMatchObject({ status: 'rejected', reason: 'X' });
  });
});
