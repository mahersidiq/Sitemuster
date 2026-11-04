import type { LocationTraceFixture, SessionRecord } from '@sitemuster/shared';
import { ms } from '@sitemuster/shared';

import type { ReplayHarness, ReplayObservation } from './harness';

/**
 * Compares a fixture's `expected` block with what the replay produced. Returns human-readable
 * mismatches (empty = pass). Only keys present in the fixture are checked; instants are compared
 * as instants so `…:00Z` and `…:00.000Z` are equal.
 */
type ExpectedSession = NonNullable<LocationTraceFixture['expected']['sessions']>[number];

function sameInstant(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a === null || a === undefined || b === null || b === undefined)
    return (a ?? null) === (b ?? null);
  return ms(a) === ms(b);
}

function compareSessions(
  label: string,
  expected: readonly ExpectedSession[],
  actual: readonly SessionRecord[],
  versions: ReadonlyMap<string, number>,
  out: string[],
): void {
  if (expected.length !== actual.length) {
    out.push(
      `${label}: expected ${expected.length} sessions, got ${actual.length} (${actual.map((s) => `${s.status} ${s.startAt}→${s.endAt ?? '…'}`).join('; ')})`,
    );
    return;
  }
  expected.forEach((want, index) => {
    const got = actual[index] as SessionRecord;
    const where = `${label}[${index}]`;
    if (!sameInstant(want.start_at, got.startAt))
      out.push(`${where}.start_at: expected ${want.start_at}, got ${got.startAt}`);
    if (want.status !== got.status)
      out.push(`${where}.status: expected ${want.status}, got ${got.status}`);
    if (want.end_at !== undefined && !sameInstant(want.end_at, got.endAt))
      out.push(`${where}.end_at: expected ${want.end_at}, got ${got.endAt}`);
    if (want.start_source !== undefined && want.start_source !== got.startSource)
      out.push(`${where}.start_source: expected ${want.start_source}, got ${got.startSource}`);
    if (want.end_source !== undefined && want.end_source !== got.endSource)
      out.push(`${where}.end_source: expected ${want.end_source}, got ${got.endSource}`);
    if (want.end_earliest_at !== undefined && !sameInstant(want.end_earliest_at, got.endEarliestAt))
      out.push(
        `${where}.end_earliest_at: expected ${want.end_earliest_at}, got ${got.endEarliestAt}`,
      );
    if (want.end_latest_at !== undefined && !sameInstant(want.end_latest_at, got.endLatestAt))
      out.push(`${where}.end_latest_at: expected ${want.end_latest_at}, got ${got.endLatestAt}`);
    if (want.unscheduled !== undefined && want.unscheduled !== got.unscheduled)
      out.push(`${where}.unscheduled: expected ${want.unscheduled}, got ${got.unscheduled}`);
    if (want.gap_count !== undefined && want.gap_count !== got.gaps.length)
      out.push(`${where}.gap_count: expected ${want.gap_count}, got ${got.gaps.length}`);
    if (
      want.config_version !== undefined &&
      want.config_version !== versions.get(got.configVersionId)
    ) {
      out.push(
        `${where}.config_version: expected ${want.config_version}, got ${versions.get(got.configVersionId)}`,
      );
    }
  });
}

export function compareExpected(
  fixture: LocationTraceFixture,
  observation: ReplayObservation,
  harness: ReplayHarness,
  allSessions: SessionRecord[],
): string[] {
  const e = fixture.expected;
  const out: string[] = [];
  const check = (name: string, want: unknown, got: unknown) => {
    if (want !== undefined && want !== got)
      out.push(`${name}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  };
  check('presence', e.presence, observation.presence);
  check('session_count', e.session_count, observation.session_count);
  check('counted_worker_count', e.counted_worker_count, observation.counted_worker_count);
  check('unresolved_count', e.unresolved_count, observation.unresolved_count);
  for (const [name, got] of [
    ['arrival_at', observation.arrival_at],
    ['departure_at', observation.departure_at],
    ['departure_earliest_at', observation.departure_earliest_at],
    ['departure_latest_at', observation.departure_latest_at],
  ] as const) {
    const want = e[name];
    if (want !== undefined && !sameInstant(want, got))
      out.push(`${name}: expected ${want}, got ${got}`);
  }
  if (e.sessions)
    compareSessions(
      'sessions',
      e.sessions,
      observation.sessions,
      observation.configVersionNumbers,
      out,
    );
  if (e.counts) {
    for (const [name, want] of Object.entries(e.counts)) {
      check(`counts.${name}`, want, observation.counts[name as keyof typeof observation.counts]);
    }
  }
  if (e.days) {
    const summaries = harness.daySummaries(
      observation,
      allSessions,
      e.days.map((d) => d.local_date),
    );
    e.days.forEach((want, index) => {
      const got = summaries[index];
      if (!got) return;
      for (const [name, value] of Object.entries(want)) {
        if (name === 'local_date') continue;
        check(`days[${want.local_date}].${name}`, value, got[name as keyof typeof got]);
      }
    });
  }
  if (e.reports) {
    check('reports.length', e.reports.length, observation.reports.length);
    e.reports.forEach((want, index) => {
      const got = observation.reports[index];
      if (!got) return;
      for (const [name, value] of Object.entries(want)) {
        check(`reports[${index}].${name}`, value, got[name as keyof typeof got]);
      }
    });
  }
  for (const flag of e.flags ?? []) {
    if (!observation.flags.includes(flag))
      out.push(`flags: expected ${flag} in ${JSON.stringify(observation.flags)}`);
  }
  for (const [uuid, want] of Object.entries(e.results ?? {})) {
    const got = observation.results.get(uuid);
    if (!got) {
      out.push(`results[${uuid}]: no server result`);
      continue;
    }
    check(`results[${uuid}].status`, want.status, got.status);
    if (want.reason !== undefined) check(`results[${uuid}].reason`, want.reason, got.reason);
    if (want.review !== undefined) check(`results[${uuid}].review`, want.review, got.review);
  }
  if (e.rejected_reasons) {
    const want = [...e.rejected_reasons].sort();
    if (JSON.stringify(want) !== JSON.stringify(observation.rejected_reasons)) {
      out.push(
        `rejected_reasons: expected ${JSON.stringify(want)}, got ${JSON.stringify(observation.rejected_reasons)}`,
      );
    }
  }
  for (const [name, want] of Object.entries(e.egress ?? {})) {
    check(`egress.${name}`, want, observation.egress[name as keyof typeof observation.egress]);
  }
  check('monitoring', e.monitoring, observation.monitoring);
  check('device_status', e.device_status, observation.device_status);
  check('queue_remaining', e.queue_remaining, observation.queue_remaining);
  check('stored_positions', e.stored_positions, observation.stored_positions);
  for (const [key, want] of Object.entries(e.workers ?? {})) {
    const got = observation.workers.get(key);
    if (!got) {
      out.push(`workers.${key}: unknown worker`);
      continue;
    }
    check(`workers.${key}.presence`, want.presence, got.presence);
    check(`workers.${key}.session_count`, want.session_count, got.sessions.length);
    if (want.sessions)
      compareSessions(
        `workers.${key}.sessions`,
        want.sessions,
        got.sessions,
        observation.configVersionNumbers,
        out,
      );
  }
  if (e.other_project) {
    check(
      'other_project.session_count',
      e.other_project.session_count,
      observation.other_project?.session_count,
    );
    check('other_project.receipts', e.other_project.receipts, observation.other_project?.receipts);
  }
  for (const [name, want] of Object.entries(e.visitors ?? {})) {
    check(
      `visitors.${name}`,
      want,
      observation.visitors[name as keyof typeof observation.visitors],
    );
  }
  check(
    'muster_responses_recorded',
    e.muster_responses_recorded,
    observation.muster_responses_recorded,
  );
  check('duplicate_responses', e.duplicate_responses, observation.duplicate_responses);
  return out;
}

/** Invariants that must hold for every fixture, whatever it expects. */
export function checkInvariants(
  fixture: LocationTraceFixture,
  observation: ReplayObservation,
): string[] {
  const out: string[] = [];
  const defect = fixture.inputs.some(
    (input) =>
      (input.type === 'FIX' && input.force_transmit) ||
      (input.type === 'EVENT_EXIT' && input.leak_coordinates),
  );
  if (!defect && observation.egress.offsite_coordinate_records_sent > 0) {
    out.push(
      `privacy: ${observation.egress.offsite_coordinate_records_sent} offsite coordinate record(s) left the phone`,
    );
  }
  const counted = observation.tracks.filter(
    (t) => t.presence === 'ONSITE_ESTIMATED' && t.current?.status === 'OPEN',
  );
  if (new Set(counted.map((t) => t.workerId)).size !== counted.length)
    out.push('a worker is counted twice');
  for (const session of observation.sessions) {
    if (session.endAt && ms(session.endAt) < ms(session.startAt))
      out.push(`session ${session.id} departs before it arrives`);
  }
  for (const [uuid, result] of observation.results) {
    if (result.status === 'rejected' && !result.reason)
      out.push(`result ${uuid} rejected without a reason`);
  }
  return out;
}
