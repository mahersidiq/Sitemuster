import type { AttendanceConfig, Zone } from './types.ts';

/** Mean Earth radius (IUGG), metres. */
const EARTH_RADIUS_M = 6_371_008.8;

export function distanceMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * INNER: inside the configured site circle (arrival may qualify). BAND: inside the native fence
 * (radius + exit hysteresis) but outside the site circle — near the boundary, keeps an existing
 * presence alive but never qualifies an arrival. OUTSIDE: beyond the native fence; such a
 * coordinate must never have been transmitted and is discarded (privacy gate, docs/spec/03).
 */
export function classifyZone(
  point: { lat: number; lng: number },
  config: Pick<AttendanceConfig, 'center' | 'radiusM' | 'exitHysteresisM'>,
): Zone {
  const distance = distanceMeters(point, config.center);
  if (distance <= config.radiusM) return 'INNER';
  if (distance <= config.radiusM + config.exitHysteresisM) return 'BAND';
  return 'OUTSIDE';
}

/** Speed above which two consecutive fixes are physically implausible on foot or by car. */
export const IMPLAUSIBLE_SPEED_MPS = 50;

/**
 * Impossible-jump check between two fixes. The accuracy circles are subtracted first so ordinary
 * GPS noise never counts as a jump. Returns true when the movement is implausible.
 */
export function isImplausibleJump(
  previous: { lat: number; lng: number; accuracyM: number; at: number },
  next: { lat: number; lng: number; accuracyM: number; at: number },
): boolean {
  const separation = Math.max(
    0,
    distanceMeters(previous, next) - previous.accuracyM - next.accuracyM,
  );
  const seconds = Math.abs(next.at - previous.at) / 1000;
  if (seconds === 0) return separation > 100;
  return separation / seconds > IMPLAUSIBLE_SPEED_MPS;
}
