import type { AttendanceSourceCode, MapMarker, ProjectMap, WorkforceMember } from '../api/types';

/** The five attendance sources, in the order screens list them (docs/spec/04). */
export const SOURCES: readonly AttendanceSourceCode[] = [
  'GEOFENCE',
  'KIOSK_DYNAMIC_BADGE',
  'KIOSK_PRINTED_BADGE',
  'FOREMAN',
  'MANUAL',
];

/**
 * The server's clock now, from its answer: `evaluated_at` plus the time since the answer arrived.
 * Freshness is judged on server time so a wrong phone clock never makes a stale marker look live.
 */
export function serverNow(evaluatedAt: string, fetchedAt: number, now: number): number {
  return Date.parse(evaluatedAt) + Math.max(0, now - fetchedAt);
}

export interface MarkerAge {
  /** Milliseconds since the position was observed (server time). */
  ageMs: number;
  /** Within `location_fresh_seconds`: may be shown as recent; otherwise labelled stale. */
  fresh: boolean;
  /** Past its expiry: the server would no longer return it, so it is not shown at all. */
  expired: boolean;
}

export function markerAge(
  marker: MapMarker,
  map: Pick<ProjectMap, 'evaluated_at' | 'fresh_seconds'>,
  fetchedAt: number,
  now: number,
): MarkerAge {
  const at = serverNow(map.evaluated_at, fetchedAt, now);
  const ageMs = Math.max(0, at - Date.parse(marker.observed_at));
  return {
    ageMs,
    fresh: marker.fresh && ageMs < map.fresh_seconds * 1000,
    expired: at >= Date.parse(marker.expires_at),
  };
}

/** Whole minutes for "n min ago" labels (never negative). */
export function wholeMinutes(ms: number): number {
  return Math.max(0, Math.floor(ms / 60_000));
}

export type RosterGroup = 'ONSITE' | 'UNKNOWN' | 'REVIEW' | 'PENDING' | 'NOT_ONSITE';

/**
 * Which list a worker appears in. Counted people are "on site (estimated)"; silence is "presence
 * unknown", never "gone"; review items stay visible until a person resolves them.
 */
export function rosterGroup(member: WorkforceMember): RosterGroup {
  if (member.counted) return 'ONSITE';
  if (member.needs_review) return 'REVIEW';
  if (member.presence === 'PRESENCE_UNKNOWN') return 'UNKNOWN';
  if (
    member.presence === 'ARRIVING' ||
    member.presence === 'UNSCHEDULED_PENDING' ||
    member.presence === 'DEPARTURE_PENDING'
  ) {
    return 'PENDING';
  }
  return 'NOT_ONSITE';
}

export const ROSTER_GROUPS: readonly RosterGroup[] = [
  'ONSITE',
  'UNKNOWN',
  'REVIEW',
  'PENDING',
  'NOT_ONSITE',
];
