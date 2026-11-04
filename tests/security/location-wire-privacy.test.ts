import { describe, expect, it } from 'vitest';

import {
  SdkBatchEnvelopeSchema,
  SdkEventWireSchema,
  stripCoordinateKeys,
} from '@sitemuster/shared';

/**
 * Wire-level privacy gates for the native ingestion contract. These are necessary but NOT
 * sufficient: real-device network captures (Milestone 07/13) are required before release.
 */
describe('offsite coordinate privacy at the API boundary', () => {
  const exit = {
    uuid: '22222222-2222-4222-8222-222222222222',
    timestamp: '2026-11-03T19:30:00Z',
    event: 'geofence',
    geofence: { identifier: 'pf_1', action: 'EXIT' },
    accuracy: 20,
  };

  it('accepts only coordinate-free geofence records', () => {
    expect(SdkEventWireSchema.safeParse(exit).success).toBe(true);
    for (const leak of [
      { coords: { latitude: 1, longitude: 2, accuracy: 3 } },
      { location: { latitude: 1, longitude: 2 } },
      { lat: 1, lng: 2 },
      { extras: { geo: [1, 2] } },
    ]) {
      expect(SdkEventWireSchema.safeParse({ ...exit, ...leak }).success).toBe(false);
    }
  });

  it('never accepts tenant identity from the client envelope', () => {
    expect(
      SdkBatchEnvelopeSchema.safeParse({
        locations: [exit],
        project_id: '00000000-0000-4000-8000-000000000002',
      }).success,
    ).toBe(false);
  });

  it('strips coordinates before a rejected record could be quarantined', () => {
    const quarantined = stripCoordinateKeys({
      ...exit,
      coords: { latitude: 1, longitude: 2 },
      extras: { lat: 3 },
    });
    expect(JSON.stringify(quarantined)).not.toMatch(/latitude|longitude|"lat"/);
  });
});
