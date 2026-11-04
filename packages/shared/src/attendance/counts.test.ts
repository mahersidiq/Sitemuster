import { describe, expect, it } from 'vitest';

import { configAt, configFromSettings, deriveUuid } from './config.ts';
import { daySummary, projectCounts, sessionIntervals } from './counts.ts';
import { emptyTrack } from './engine.ts';
import { ms } from './time.ts';
import type { SessionRecord } from './types.ts';

function session(fields: Partial<SessionRecord>): SessionRecord {
  return {
    id: fields.id ?? 's',
    projectId: 'p',
    workerId: fields.workerId ?? 'w',
    status: 'CLOSED',
    startAt: '2026-11-03T12:00:00Z',
    startSource: 'GEOFENCE',
    startConfidence: 'MEDIUM',
    endAt: '2026-11-03T16:00:00Z',
    endSource: 'GEOFENCE',
    endEarliestAt: null,
    endLatestAt: null,
    configVersionId: 'cv',
    timezone: 'America/Chicago',
    lastSeenAt: '2026-11-03T16:00:00Z',
    lastConfirmedInsideAt: '2026-11-03T16:00:00Z',
    closeoutAt: '2026-11-04T01:00:00Z',
    authorizeAt: null,
    authorizedCloseoutAt: null,
    windowStartAt: null,
    windowEndAt: null,
    unscheduled: false,
    unscheduledUntil: null,
    overtimeApprovedAt: null,
    overtimeApprovedBy: null,
    witnessed: false,
    gaps: [],
    reviewReasons: [],
    unresolvedAt: null,
    openedByEvent: 'e',
    employerSnapshotId: null,
    ...fields,
  };
}

const NOW = ms('2026-11-03T20:00:00Z');

describe('estimated hours', () => {
  it('counts a closed session minus evidence gaps (gaps itemized as uncertain)', () => {
    const out = sessionIntervals(
      session({ gaps: [{ from: '2026-11-03T13:00:00Z', to: '2026-11-03T13:30:00Z' }] }),
      NOW,
      1200,
    );
    expect(out.definite.reduce((sum, [a, b]) => sum + (b - a), 0)).toBe(3.5 * 3600_000);
    expect(out.uncertain).toHaveLength(1);
  });

  it('counts an unresolved session only up to the last confirmed inside time', () => {
    const out = sessionIntervals(
      session({
        status: 'UNRESOLVED',
        endAt: null,
        endSource: null,
        endEarliestAt: '2026-11-03T15:00:00Z',
        endLatestAt: '2026-11-03T15:30:00Z',
      }),
      NOW,
      1200,
    );
    expect(out.definite).toEqual([[ms('2026-11-03T12:00:00Z'), ms('2026-11-03T15:00:00Z')]]);
    expect(out.uncertain).toEqual([[ms('2026-11-03T15:00:00Z'), ms('2026-11-03T15:30:00Z')]]);
  });

  it('unites a gap that lies inside the unresolved tail (no double counting; review finding on PR #6)', () => {
    // Qualified fixes 08:00 and 08:10 local, a band fix at 08:40 (gap 08:10–08:40), close-out
    // at 19:00: the uncertain time is 08:10–19:00 once, as one segment.
    const unresolved = session({
      status: 'UNRESOLVED',
      startAt: '2026-11-03T14:00:00Z',
      endAt: null,
      endSource: null,
      endEarliestAt: '2026-11-03T14:10:00Z',
      lastConfirmedInsideAt: '2026-11-03T14:10:00Z',
      lastSeenAt: '2026-11-03T14:40:00Z',
      unresolvedAt: '2026-11-04T01:00:00Z',
      gaps: [{ from: '2026-11-03T14:10:00Z', to: '2026-11-03T14:40:00Z' }],
      reviewReasons: ['CLOSEOUT_STALE'],
    });
    const at = ms('2026-11-04T01:00:00Z');
    const out = sessionIntervals(unresolved, at, 1200);
    expect(out.uncertain).toEqual([[ms('2026-11-03T14:10:00Z'), at]]);
    const day = daySummary(
      [unresolved],
      '2026-11-03',
      'America/Chicago',
      '2026-11-04T01:00:00Z',
      1200,
    );
    expect(day.estimated_worker_seconds).toBe(600);
    expect(day.unresolved_segment_count).toBe(1);
    expect(day.unresolved_segment_seconds).toBe((at - ms('2026-11-03T14:10:00Z')) / 1000);
  });

  it('keeps the unapproved unscheduled part out of the estimated hours', () => {
    const out = sessionIntervals(
      session({ unscheduled: true, unscheduledUntil: '2026-11-03T13:00:00Z' }),
      NOW,
      1200,
    );
    expect(out.pendingApproval).toEqual([[ms('2026-11-03T12:00:00Z'), ms('2026-11-03T13:00:00Z')]]);
    expect(out.definite).toEqual([[ms('2026-11-03T13:00:00Z'), ms('2026-11-03T16:00:00Z')]]);
  });

  it('splits a night session across two local days and measures the peak', () => {
    const sessions = [
      session({
        id: 'a',
        workerId: 'a',
        startAt: '2026-11-04T04:00:00Z',
        endAt: '2026-11-04T08:00:00Z',
      }),
      session({
        id: 'b',
        workerId: 'b',
        startAt: '2026-11-04T05:00:00Z',
        endAt: '2026-11-04T06:30:00Z',
      }),
    ];
    const tue = daySummary(sessions, '2026-11-03', 'America/Chicago', '2026-11-04T12:00:00Z', 1200);
    const wed = daySummary(sessions, '2026-11-04', 'America/Chicago', '2026-11-04T12:00:00Z', 1200);
    expect(tue.estimated_worker_seconds).toBe(2 * 3600 + 3600);
    expect(wed.estimated_worker_seconds).toBe(2 * 3600 + 1800);
    expect(tue.peak_estimated_count).toBe(2);
    expect(wed.daily_unique_count).toBe(2);
  });
});

describe('project counts', () => {
  it('counts only open sessions with current evidence, once per worker', () => {
    const onsite = {
      ...emptyTrack('p', 'w1', 'cv'),
      presence: 'ONSITE_ESTIMATED' as const,
      current: session({ status: 'OPEN', endAt: null, endSource: null, witnessed: true }),
    };
    const unknown = { ...emptyTrack('p', 'w2', 'cv'), presence: 'PRESENCE_UNKNOWN' as const };
    const counts = projectCounts({
      tracks: [onsite, unknown],
      sessions: [],
      visits: [],
      approvedRoster: 5,
    });
    expect(counts).toMatchObject({
      estimated_onsite: 1,
      manually_verified: 1,
      presence_unknown: 1,
      approved_roster: 5,
    });
    expect(counts.onsite_by_source.GEOFENCE).toBe(1);
  });
});

describe('configuration versions', () => {
  const version = (n: number, effectiveAt: string) =>
    configFromSettings({
      configVersionId: `v${n}`,
      projectId: 'p',
      versionNumber: n,
      effectiveAt,
      settings: { geofence_radius_m: '250' },
      center: { lat: 0, lng: 0 },
    });

  it('reads stored settings with locked defaults for anything missing', () => {
    const config = version(1, '2026-01-01T00:00:00Z');
    expect(config).toMatchObject({
      radiusM: 250,
      exitHysteresisM: 50,
      entryDwellSeconds: 600,
      maxHorizontalAccuracyM: 75,
      presenceUnknownSeconds: 1200,
    });
  });

  it('selects the version in force at an instant', () => {
    const versions = [version(1, '2026-01-01T00:00:00Z'), version(2, '2026-11-03T13:00:00Z')];
    expect(configAt(versions, '2026-11-03T12:59:59Z')?.versionNumber).toBe(1);
    expect(configAt(versions, '2026-11-03T13:00:00Z')?.versionNumber).toBe(2);
  });

  it('derives stable, well-formed ids', () => {
    expect(deriveUuid('x', 'y')).toBe(deriveUuid('x', 'y'));
    expect(deriveUuid('x', 'y')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
