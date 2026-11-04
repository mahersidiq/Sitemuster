import { ATTENDANCE_SOURCES, type AttendanceSource } from '../enums.ts';
import { localDayRange, ms, parseLocalDate, SECOND } from './time.ts';
import type { SessionRecord, TrackState } from './types.ts';
import type { VisitRecord } from './visitors.ts';

/**
 * Basic counts (docs/spec/04 "Aggregations"). Inputs are tracks already evaluated at `now`.
 * Every number is an estimate; none of them is a guaranteed headcount.
 */
export interface ProjectCounts {
  approved_roster: number;
  estimated_onsite: number;
  onsite_by_source: Record<AttendanceSource, number>;
  manually_verified: number;
  presence_unknown: number;
  arriving: number;
  unscheduled_pending: number;
  departure_pending: number;
  unresolved_sessions: number;
  visitors_onsite: number;
  visitors_unresolved: number;
}

export function projectCounts(input: {
  tracks: readonly TrackState[];
  sessions: readonly SessionRecord[];
  visits: readonly VisitRecord[];
  approvedRoster: number;
}): ProjectCounts {
  const bySource = Object.fromEntries(ATTENDANCE_SOURCES.map((source) => [source, 0])) as Record<
    AttendanceSource,
    number
  >;
  let onsite = 0;
  let verified = 0;
  const seen = new Set<string>();
  for (const track of input.tracks) {
    if (track.presence !== 'ONSITE_ESTIMATED' || track.current?.status !== 'OPEN') continue;
    if (seen.has(track.workerId)) continue; // one person is never counted twice
    seen.add(track.workerId);
    onsite += 1;
    bySource[track.current.startSource] += 1;
    if (track.current.witnessed) verified += 1;
  }
  const presence = (state: TrackState['presence']) =>
    input.tracks.filter((track) => track.presence === state).length;
  return {
    approved_roster: input.approvedRoster,
    estimated_onsite: onsite,
    onsite_by_source: bySource,
    manually_verified: verified,
    presence_unknown: presence('PRESENCE_UNKNOWN'),
    arriving: presence('ARRIVING'),
    unscheduled_pending: presence('UNSCHEDULED_PENDING'),
    departure_pending: presence('DEPARTURE_PENDING'),
    unresolved_sessions: input.sessions.filter(
      (session) => session.status === 'UNRESOLVED' || session.status === 'ENDED_UNVERIFIED',
    ).length,
    visitors_onsite: input.visits.filter((visit) => visit.status === 'OPEN').length,
    visitors_unresolved: input.visits.filter((visit) => visit.status === 'UNRESOLVED').length,
  };
}

type Interval = [number, number];

function subtract(interval: Interval, holes: readonly Interval[]): Interval[] {
  let pieces: Interval[] = [interval];
  for (const [holeStart, holeEnd] of holes) {
    pieces = pieces.flatMap(([start, end]): Interval[] => {
      if (holeEnd <= start || holeStart >= end) return [[start, end]];
      const out: Interval[] = [];
      if (holeStart > start) out.push([start, holeStart]);
      if (holeEnd < end) out.push([holeEnd, end]);
      return out;
    });
  }
  return pieces.filter(([start, end]) => end > start);
}

/**
 * Definite (countable) intervals of a session up to `now`, the uncertain ones (unresolved ends
 * and evidence gaps, itemized separately) and the unscheduled part still awaiting approval.
 */
export function sessionIntervals(
  session: SessionRecord,
  now: number,
  presenceUnknownSeconds: number,
): { definite: Interval[]; uncertain: Interval[]; pendingApproval: Interval[] } {
  if (session.status === 'VOID') return { definite: [], uncertain: [], pendingApproval: [] };
  const start = ms(session.startAt);
  let definiteEnd: number;
  const uncertain: Interval[] = [];
  if (session.status === 'CLOSED' && session.endAt) {
    definiteEnd = ms(session.endAt);
  } else if (session.status === 'OPEN' || session.status === 'PENDING_APPROVAL') {
    const lastSeen = ms(session.lastSeenAt);
    const fresh = now - lastSeen < presenceUnknownSeconds * SECOND;
    definiteEnd = session.witnessed || fresh ? now : lastSeen;
    if (definiteEnd < now) uncertain.push([definiteEnd, now]);
  } else {
    definiteEnd = ms(session.endEarliestAt ?? session.lastConfirmedInsideAt ?? session.startAt);
    const latest = session.endLatestAt ? ms(session.endLatestAt) : now;
    if (latest > definiteEnd) uncertain.push([definiteEnd, latest]);
  }
  const gaps: Interval[] = session.gaps.map((gap) => [ms(gap.from), ms(gap.to)]);
  uncertain.push(...gaps);
  const counted = subtract([start, Math.max(start, definiteEnd)], gaps);
  let pendingUntil: number | null = null;
  if (session.unscheduled && !session.overtimeApprovedAt) {
    pendingUntil = session.unscheduledUntil
      ? ms(session.unscheduledUntil)
      : Number.POSITIVE_INFINITY;
  }
  if (pendingUntil === null) return { definite: counted, uncertain, pendingApproval: [] };
  const pending = counted.flatMap(([a, b]): Interval[] =>
    a < pendingUntil ? [[a, Math.min(b, pendingUntil)]] : [],
  );
  const definite = counted.flatMap(([a, b]): Interval[] =>
    b > pendingUntil ? [[Math.max(a, pendingUntil), b]] : [],
  );
  return { definite, uncertain, pendingApproval: pending };
}

export interface DaySummary {
  local_date: string;
  daily_unique_count: number;
  estimated_worker_seconds: number;
  pending_approval_seconds: number;
  unresolved_segment_count: number;
  unresolved_segment_seconds: number;
  peak_estimated_count: number;
}

function clip([a, b]: Interval, [from, to]: Interval): Interval | null {
  const start = Math.max(a, from);
  const end = Math.min(b, to);
  return end > start ? [start, end] : null;
}

/** Per project-local calendar day (DST-aware: 23, 24 or 25 hours). */
export function daySummary(
  sessions: readonly SessionRecord[],
  localDate: string,
  timeZone: string,
  now: string,
  presenceUnknownSeconds: number,
): DaySummary {
  const day = localDayRange(parseLocalDate(localDate), timeZone);
  const t = ms(now);
  const workers = new Set<string>();
  let seconds = 0;
  let pendingSeconds = 0;
  let segments = 0;
  let segmentSeconds = 0;
  const edges: [number, number][] = [];
  for (const session of sessions) {
    if (session.status === 'VOID') continue;
    const intervals = sessionIntervals(session, t, presenceUnknownSeconds);
    const span: Interval = [
      ms(session.startAt),
      Math.max(
        ms(session.startAt),
        session.endAt ? ms(session.endAt) : session.endLatestAt ? ms(session.endLatestAt) : t,
      ),
    ];
    if (clip(span, day) || (span[0] === span[1] && span[0] >= day[0] && span[0] < day[1])) {
      workers.add(session.workerId);
    }
    for (const interval of intervals.definite) {
      const part = clip(interval, day);
      if (!part) continue;
      seconds += (part[1] - part[0]) / SECOND;
      edges.push([part[0], 1], [part[1], -1]);
    }
    for (const interval of intervals.pendingApproval) {
      const part = clip(interval, day);
      if (part) pendingSeconds += (part[1] - part[0]) / SECOND;
    }
    for (const interval of intervals.uncertain) {
      const part = clip(interval, day);
      if (!part) continue;
      segments += 1;
      segmentSeconds += (part[1] - part[0]) / SECOND;
    }
  }
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let current = 0;
  let peak = 0;
  for (const [, delta] of edges) {
    current += delta;
    peak = Math.max(peak, current);
  }
  return {
    local_date: localDate,
    daily_unique_count: workers.size,
    estimated_worker_seconds: Math.round(seconds),
    pending_approval_seconds: Math.round(pendingSeconds),
    unresolved_segment_count: segments,
    unresolved_segment_seconds: Math.round(segmentSeconds),
    peak_estimated_count: peak,
  };
}
