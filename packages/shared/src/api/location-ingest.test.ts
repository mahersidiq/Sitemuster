import { describe, expect, it } from 'vitest';

import {
  LocationIngestResponseSchema,
  NormalizedLocationEventSchema,
  SdkBatchEnvelopeSchema,
  SdkEventWireSchema,
} from './location-ingest.ts';

const geofenceExit = {
  uuid: '22222222-2222-4222-8222-222222222222',
  timestamp: '2026-11-03T19:30:00Z',
  event: 'geofence',
  geofence: { identifier: 'pf_8c1d2e', action: 'EXIT' },
  accuracy: 12,
};

describe('SdkBatchEnvelopeSchema', () => {
  it('accepts 1–25 records with optional schema_version 1', () => {
    expect(SdkBatchEnvelopeSchema.safeParse({ locations: [geofenceExit] }).success).toBe(true);
    expect(
      SdkBatchEnvelopeSchema.safeParse({ locations: [geofenceExit], schema_version: 1 }).success,
    ).toBe(true);
  });

  it('rejects empty and oversized batches', () => {
    expect(SdkBatchEnvelopeSchema.safeParse({ locations: [] }).success).toBe(false);
    expect(
      SdkBatchEnvelopeSchema.safeParse({
        locations: Array.from({ length: 26 }, () => geofenceExit),
      }).success,
    ).toBe(false);
  });

  it('rejects client-supplied tenant authority at the envelope level (#39)', () => {
    for (const key of ['worker_id', 'project_id', 'organization_id', 'params']) {
      expect(
        SdkBatchEnvelopeSchema.safeParse({ locations: [geofenceExit], [key]: 'x' }).success,
      ).toBe(false);
    }
  });
});

describe('SdkEventWireSchema', () => {
  it('accepts a coordinate-free geofence EXIT carrying accuracy', () => {
    expect(SdkEventWireSchema.safeParse(geofenceExit).success).toBe(true);
  });

  it('requires accuracy on geofence events (EXIT corroboration, #45)', () => {
    const { accuracy: _omitted, ...withoutAccuracy } = geofenceExit;
    expect(SdkEventWireSchema.safeParse(withoutAccuracy).success).toBe(false);
  });

  it('rejects any coordinates on geofence events (no offsite coordinates, privacy)', () => {
    const variants = [
      { ...geofenceExit, coords: { latitude: 29.76, longitude: -95.36, accuracy: 10 } },
      { ...geofenceExit, latitude: 29.76 },
      { ...geofenceExit, extras: { location: { lat: 29.76, lng: -95.36 } } },
    ];
    for (const variant of variants)
      expect(SdkEventWireSchema.safeParse(variant).success).toBe(false);
  });

  it('requires geofence metadata on geofence events and forbids it elsewhere', () => {
    const { geofence: _g, ...noGeofence } = geofenceExit;
    expect(SdkEventWireSchema.safeParse(noGeofence).success).toBe(false);
    expect(
      SdkEventWireSchema.safeParse({
        uuid: '33333333-3333-4333-8333-333333333333',
        timestamp: '2026-11-03T19:31:00Z',
        event: 'location',
        geofence: { identifier: 'pf_8c1d2e', action: 'ENTER' },
        coords: { latitude: 29.76, longitude: -95.36, accuracy: 10 },
      }).success,
    ).toBe(false);
  });

  it('accepts an onsite location fix with bounded coordinates', () => {
    expect(
      SdkEventWireSchema.safeParse({
        uuid: '33333333-3333-4333-8333-333333333333',
        timestamp: '2026-11-03T19:31:00Z',
        event: 'location',
        coords: { latitude: 29.7604, longitude: -95.3698, accuracy: 14 },
        is_moving: false,
      }).success,
    ).toBe(true);
  });

  it('rejects out-of-range coordinates, negative accuracy and non-UTC timestamps', () => {
    const base = { uuid: '33333333-3333-4333-8333-333333333333', event: 'location' };
    expect(
      SdkEventWireSchema.safeParse({
        ...base,
        timestamp: '2026-11-03T19:31:00Z',
        coords: { latitude: 91, longitude: 0, accuracy: 1 },
      }).success,
    ).toBe(false);
    expect(
      SdkEventWireSchema.safeParse({
        ...base,
        timestamp: '2026-11-03T19:31:00Z',
        coords: { latitude: 1, longitude: 0, accuracy: -1 },
      }).success,
    ).toBe(false);
    expect(
      SdkEventWireSchema.safeParse({
        ...base,
        timestamp: '2026-11-03T13:31:00-06:00',
        coords: { latitude: 1, longitude: 0, accuracy: 1 },
      }).success,
    ).toBe(false);
  });

  it('rejects provider-change records that carry coordinates', () => {
    expect(
      SdkEventWireSchema.safeParse({
        uuid: '44444444-4444-4444-8444-444444444444',
        timestamp: '2026-11-03T19:31:00Z',
        event: 'providerchange',
        coords: { latitude: 29.76, longitude: -95.36, accuracy: 10 },
      }).success,
    ).toBe(false);
  });
});

describe('LocationIngestResponseSchema (exact spec example)', () => {
  it('accepts the documented mixed-result body', () => {
    expect(
      LocationIngestResponseSchema.safeParse({
        schema_version: 1,
        request_id: '11111111-1111-4111-8111-111111111111',
        results: [
          { event_uuid: '22222222-2222-4222-8222-222222222222', status: 'accepted', reason: null },
          { event_uuid: '33333333-3333-4333-8333-333333333333', status: 'duplicate', reason: null },
          {
            event_uuid: '44444444-4444-4444-8444-444444444444',
            status: 'rejected',
            reason: 'PROJECT_NOT_AUTHORIZED',
          },
        ],
      }).success,
    ).toBe(true);
  });

  it('rejects unknown statuses and extra keys', () => {
    expect(
      LocationIngestResponseSchema.safeParse({
        schema_version: 1,
        request_id: '11111111-1111-4111-8111-111111111111',
        results: [
          { event_uuid: '22222222-2222-4222-8222-222222222222', status: 'queued', reason: null },
        ],
      }).success,
    ).toBe(false);
    expect(
      LocationIngestResponseSchema.safeParse({
        schema_version: 1,
        request_id: '11111111-1111-4111-8111-111111111111',
        results: [
          {
            event_uuid: '22222222-2222-4222-8222-222222222222',
            status: 'accepted',
            reason: null,
            lat: 1,
          },
        ],
      }).success,
    ).toBe(false);
  });
});

describe('NormalizedLocationEventSchema', () => {
  it('only accepts server-derived GEOFENCE-source events', () => {
    const event = {
      event_uuid: '22222222-2222-4222-8222-222222222222',
      device_id: '55555555-5555-4555-8555-555555555555',
      worker_id: '66666666-6666-4666-8666-666666666666',
      project_id: '00000000-0000-4000-8000-000000000001',
      organization_id: '77777777-7777-4777-8777-777777777777',
      enrollment_id: '88888888-8888-4888-8888-888888888888',
      config_version_id: '99999999-9999-4999-8999-999999999999',
      kind: 'GEOFENCE_EXIT',
      observed_at: '2026-11-03T19:30:00Z',
      received_at: '2026-11-03T19:30:05Z',
      accuracy_m: 12,
      sdk_geofence_identifier: 'pf_8c1d2e',
      is_mock: false,
      validity_state: 'VALID',
      source: 'GEOFENCE',
    };
    expect(NormalizedLocationEventSchema.safeParse(event).success).toBe(true);
    expect(NormalizedLocationEventSchema.safeParse({ ...event, source: 'MANUAL' }).success).toBe(
      false,
    );
  });
});
