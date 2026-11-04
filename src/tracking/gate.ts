import { containsCoordinateKeys, distanceMeters } from '@sitemuster/shared';

/**
 * On-device egress gate (docs/spec/03 "WARNING"; decisions #85, #90, #91). The native SDK uploads
 * whatever it has queued, so before any onsite sync the app removes every queued record that may
 * not leave the phone. Backend discarding is a second line, never a substitute.
 */
export interface GateFence {
  projectId: string;
  identifier: string;
  center: { lat: number; lng: number };
  /** Inner site radius (local dwell qualification). */
  radiusM: number;
  /** Native fence radius = site radius + exit hysteresis. */
  nativeRadiusM: number;
}

/** A record as the native queue stores it (SDK Location object or rendered wire record). */
export interface QueuedRecord {
  uuid: string;
  timestamp?: string;
  event?: string;
  coords?: { latitude: number; longitude: number; accuracy: number };
  geofence?: { identifier: string; action: string };
  [key: string]: unknown;
}

export type EgressDecision = 'KEEP' | 'DESTROY';

export function fencesContaining(
  point: { lat: number; lng: number },
  fences: readonly GateFence[],
): GateFence[] {
  return fences.filter((fence) => distanceMeters(point, fence.center) <= fence.nativeRadiusM);
}

export function egressDecision(
  record: QueuedRecord,
  fences: readonly GateFence[],
  coordinatesAllowed: boolean,
): EgressDecision {
  if (record.event === 'geofence' || record.geofence !== undefined) {
    // The SDK stores a geofence event together with its triggering location, but uploads it
    // through the coordinate-free geofence template (templates.ts): kept, never destroyed —
    // destroying it would silently lose the ENTER/EXIT itself.
    return 'KEEP';
  }
  if (!record.coords) return containsCoordinateKeys(record) ? 'DESTROY' : 'KEEP';
  if (!coordinatesAllowed) return 'DESTROY';
  const inside = fencesContaining(
    { lat: record.coords.latitude, lng: record.coords.longitude },
    fences,
  );
  // Offsite (no fence) or ambiguous (overlapping sites): the position never leaves the phone.
  return inside.length === 1 ? 'KEEP' : 'DESTROY';
}

/** Splits the queue: uuids to destroy before the next upload. */
export function recordsToDestroy(
  records: readonly QueuedRecord[],
  fences: readonly GateFence[],
  coordinatesAllowed: boolean,
): string[] {
  return records
    .filter((record) => egressDecision(record, fences, coordinatesAllowed) === 'DESTROY')
    .map((record) => record.uuid);
}
