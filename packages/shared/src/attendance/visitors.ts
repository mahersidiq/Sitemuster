import { scheduleFor } from './schedule.ts';
import { iso, ms } from './time.ts';
import type { AttendanceConfig, ItemResult } from './types.ts';

/**
 * Visitor visits are separate from the workforce (docs/spec/04): never counted in worker totals,
 * shown in the visitor subtotal and in emergency rosters. An unclosed visit becomes UNRESOLVED at
 * close-out time (the same rule as worker sessions), never an invented check-out.
 */
export interface VisitRecord {
  id: string;
  projectId: string;
  visitorKey: string;
  status: 'OPEN' | 'CLOSED' | 'UNRESOLVED';
  checkedInAt: string;
  checkedOutAt: string | null;
  closeoutAt: string;
  idempotencyKey: string;
  /** The operation id of the exit that closed the visit, stored with the close (resends). */
  exitIdempotencyKey: string | null;
}

export interface VisitorEvent {
  eventUuid: string;
  projectId: string;
  visitorKey: string;
  direction: 'ENTRY' | 'EXIT';
  observedAt: string;
}

export function applyVisitorEvent(
  visits: readonly VisitRecord[],
  event: VisitorEvent,
  config: AttendanceConfig,
  timeZone: string,
): { changed: VisitRecord | null; result: ItemResult } {
  const ok = (reason: string | null = null): ItemResult => ({
    eventUuid: event.eventUuid,
    status: 'accepted',
    reason,
    review: false,
  });
  if (
    visits.some(
      (visit) =>
        visit.idempotencyKey === event.eventUuid || visit.exitIdempotencyKey === event.eventUuid,
    )
  ) {
    return {
      changed: null,
      result: { eventUuid: event.eventUuid, status: 'duplicate', reason: null, review: false },
    };
  }
  const open = visits.find(
    (visit) =>
      visit.visitorKey === event.visitorKey &&
      visit.projectId === event.projectId &&
      visit.status === 'OPEN',
  );
  if (event.direction === 'ENTRY') {
    if (open) return { changed: null, result: ok('ALREADY_CHECKED_IN') };
    const start = ms(event.observedAt);
    return {
      changed: {
        id: event.eventUuid,
        projectId: event.projectId,
        visitorKey: event.visitorKey,
        status: 'OPEN',
        checkedInAt: event.observedAt,
        checkedOutAt: null,
        closeoutAt: iso(scheduleFor(start, config, timeZone).closeoutAt),
        idempotencyKey: event.eventUuid,
        exitIdempotencyKey: null,
      },
      result: ok(),
    };
  }
  const target =
    open ??
    visits.find(
      (visit) =>
        visit.visitorKey === event.visitorKey &&
        visit.projectId === event.projectId &&
        visit.status === 'UNRESOLVED' &&
        ms(visit.checkedInAt) <= ms(event.observedAt),
    );
  if (!target || ms(event.observedAt) < ms(target.checkedInAt)) {
    return {
      changed: null,
      result: {
        eventUuid: event.eventUuid,
        status: 'rejected',
        reason: 'VISIT_NOT_FOUND',
        review: false,
      },
    };
  }
  return {
    changed: {
      ...target,
      status: 'CLOSED',
      checkedOutAt: event.observedAt,
      exitIdempotencyKey: event.eventUuid,
    },
    result: ok(),
  };
}

/** Close-out sweep for visits: OPEN past `closeoutAt` → UNRESOLVED. */
export function advanceVisits(visits: readonly VisitRecord[], now: string): VisitRecord[] {
  const t = ms(now);
  return visits
    .filter((visit) => visit.status === 'OPEN' && ms(visit.closeoutAt) <= t)
    .map((visit) => ({ ...visit, status: 'UNRESOLVED' as const }));
}
