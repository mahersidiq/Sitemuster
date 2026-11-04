import { describe, expect, it } from 'vitest';

import type { SessionRecord } from '../attendance/types.ts';
import { buildHoursCsv, csvField } from './csv.ts';
import {
  buildCompanyDayReports,
  isoWeekStart,
  localDatesOf,
  reportDueAt,
  workerHoursByDay,
} from './daily-report.ts';

const TZ = 'America/Chicago';
const ACME = 'c0000000-0000-4000-8000-0000000000a1';
const BOLT = 'c0000000-0000-4000-8000-0000000000b1';
const MON_SAT = [1, 2, 3, 4, 5, 6].map((weekday) => ({
  weekday,
  local_start_time: '06:00',
  local_end_time: '18:00',
}));

let n = 0;
function session(overrides: Partial<SessionRecord>): SessionRecord {
  n += 1;
  return {
    id: `5e000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    projectId: 'a0000000-0000-4000-8000-000000000001',
    workerId: 'b0000000-0000-4000-8000-000000000001',
    status: 'CLOSED',
    startAt: '2026-11-03T13:00:00Z',
    startSource: 'FOREMAN',
    startConfidence: 'HIGH',
    endAt: '2026-11-03T21:00:00Z',
    endSource: 'FOREMAN',
    endEarliestAt: null,
    endLatestAt: null,
    configVersionId: 'cv1',
    timezone: TZ,
    lastSeenAt: '2026-11-03T21:00:00Z',
    lastConfirmedInsideAt: '2026-11-03T21:00:00Z',
    closeoutAt: '2026-11-04T01:00:00Z',
    authorizeAt: null,
    authorizedCloseoutAt: null,
    windowStartAt: null,
    windowEndAt: null,
    unscheduled: false,
    unscheduledUntil: null,
    overtimeApprovedAt: null,
    overtimeApprovedBy: null,
    witnessed: true,
    gaps: [],
    reviewReasons: [],
    unresolvedAt: null,
    openedByEvent: 'e',
    employerSnapshotId: ACME,
    ...overrides,
  };
}

const unknown = () => 1200;
const build = (localDate: string, sessions: SessionRecord[], now = '2026-11-20T00:00:00Z') =>
  buildCompanyDayReports({
    localDate,
    timeZone: TZ,
    now,
    sessions,
    presenceUnknownSeconds: unknown,
  });

describe('daily company reports (project-local day, estimated onsite time)', () => {
  it('one report per company, workers once each, definite hours summed', () => {
    const reports = build('2026-11-03', [
      session({}),
      session({
        workerId: 'b0000000-0000-4000-8000-000000000002',
        startAt: '2026-11-03T14:00:00Z',
      }),
      session({ employerSnapshotId: BOLT, workerId: 'b0000000-0000-4000-8000-000000000003' }),
      session({ employerSnapshotId: null, workerId: 'b0000000-0000-4000-8000-000000000004' }),
    ]);
    expect(reports.map((r) => [r.company_id, r.totals.workers])).toEqual([
      [ACME, 2],
      [BOLT, 1],
    ]);
    const acme = reports[0];
    expect(acme?.totals.definite_seconds).toBe(8 * 3600 + 7 * 3600);
    expect(acme?.totals.peak_estimated_count).toBe(2);
    expect(acme?.notice).toBe('ESTIMATED_ONSITE_NOT_PAYROLL');
  });

  it('an overnight shift (22:00–04:00 local) is split between the two local days', () => {
    const night = session({ startAt: '2026-11-04T04:00:00Z', endAt: '2026-11-04T10:00:00Z' });
    const first = build('2026-11-03', [night]);
    const second = build('2026-11-04', [night]);
    expect(first[0]?.totals.definite_seconds).toBe(2 * 3600); // 22:00–24:00
    expect(second[0]?.totals.definite_seconds).toBe(4 * 3600); // 00:00–04:00
    expect(localDatesOf(night, TZ, '2026-11-20T00:00:00Z')).toEqual(['2026-11-03', '2026-11-04']);
  });

  it('DST fall-back day is 25 hours; spring-forward day is 23 hours', () => {
    // 2026-11-01: clocks fall back at 02:00 CDT → 01:00 CST.
    const fall = session({ startAt: '2026-11-01T05:00:00Z', endAt: '2026-11-02T06:00:00Z' });
    const fallReport = build('2026-11-01', [fall])[0];
    expect(fallReport?.day_start_at).toBe('2026-11-01T05:00:00Z');
    expect(fallReport?.day_end_at).toBe('2026-11-02T06:00:00Z');
    expect(fallReport?.totals.definite_seconds).toBe(25 * 3600);
    // 2026-03-08: clocks spring forward at 02:00 CST → 03:00 CDT.
    const spring = session({ startAt: '2026-03-08T06:00:00Z', endAt: '2026-03-09T05:00:00Z' });
    expect(build('2026-03-08', [spring])[0]?.totals.definite_seconds).toBe(23 * 3600);
  });

  it('an unresolved end is itemized as uncertain and flagged for review, never counted', () => {
    const open = session({
      status: 'UNRESOLVED',
      endAt: null,
      endSource: null,
      endEarliestAt: '2026-11-03T18:00:00Z',
      endLatestAt: '2026-11-03T23:00:00Z',
      lastSeenAt: '2026-11-03T18:00:00Z',
      lastConfirmedInsideAt: '2026-11-03T18:00:00Z',
      witnessed: false,
      startSource: 'GEOFENCE',
    });
    const line = build('2026-11-03', [open])[0]?.workers[0];
    expect(line?.definite_seconds).toBe(5 * 3600);
    expect(line?.uncertain_seconds).toBe(5 * 3600);
    expect(line?.needs_review).toBe(true);
  });

  it('a corrected session is marked; a void one is left out', () => {
    const corrected = session({});
    const reports = buildCompanyDayReports({
      localDate: '2026-11-03',
      timeZone: TZ,
      now: '2026-11-20T00:00:00Z',
      sessions: [
        corrected,
        session({ status: 'VOID', workerId: 'b0000000-0000-4000-8000-000000000009' }),
      ],
      correctedSessionIds: new Set([corrected.id]),
      presenceUnknownSeconds: unknown,
    });
    expect(reports[0]?.workers).toHaveLength(1);
    expect(reports[0]?.workers[0]?.sessions[0]?.corrected).toBe(true);
  });
});

describe('report due time: 12:00 on the next project workday', () => {
  const config = { operates24x7: false, windows: MON_SAT };
  it('Friday → Saturday noon; Saturday → Monday noon (Sunday is not a workday)', () => {
    expect(reportDueAt('2026-11-06', config, TZ)).toBe('2026-11-07T18:00:00Z');
    expect(reportDueAt('2026-11-07', config, TZ)).toBe('2026-11-09T18:00:00Z');
  });
  it('24/7 sites use the next calendar day', () => {
    expect(reportDueAt('2026-11-07', { operates24x7: true, windows: [] }, TZ)).toBe(
      '2026-11-08T18:00:00Z',
    );
  });
  it('noon after a DST change uses the new offset', () => {
    // Saturday 2026-10-31 (CDT) → Monday 2026-11-02 12:00 CST = 18:00Z.
    expect(reportDueAt('2026-10-31', config, TZ)).toBe('2026-11-02T18:00:00Z');
    // Saturday 2026-03-07 (CST) → Monday 2026-03-09 12:00 CDT = 17:00Z.
    expect(reportDueAt('2026-03-07', config, TZ)).toBe('2026-03-09T17:00:00Z');
  });
});

describe("a worker's own hours", () => {
  it('per local day across a week, weeks start on Monday', () => {
    const days = workerHoursByDay(
      [session({}), session({ startAt: '2026-11-04T04:00:00Z', endAt: '2026-11-04T10:00:00Z' })],
      '2026-11-02',
      7,
      TZ,
      '2026-11-20T00:00:00Z',
      unknown,
    );
    expect(days.map((d) => d.definite_seconds / 3600)).toEqual([0, 10, 4, 0, 0, 0, 0]);
    expect(isoWeekStart('2026-11-08')).toBe('2026-11-02');
    expect(isoWeekStart('2026-11-02')).toBe('2026-11-02');
  });
});

describe('personal hours CSV', () => {
  const labels = {
    date: 'Date',
    project: 'Project',
    arrival: 'Arrival',
    departure: 'Departure',
    estimatedHours: 'Estimated onsite hours (not payroll)',
    status: 'Status',
  };
  it('RFC 4180 quoting, CRLF, a UTF-8 BOM and the estimate label in the header', () => {
    const csv = buildHoursCsv(labels, [
      {
        date: '2026-11-03',
        project: 'Main St, "Tower"',
        arrival: '7:00 AM',
        departure: '3:00 PM',
        estimatedHours: '8.00',
        status: 'Recorded',
      },
    ]);
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv).toBe(
      '﻿Date,Project,Arrival,Departure,Estimated onsite hours (not payroll),Status\r\n' +
        '2026-11-03,"Main St, ""Tower""",7:00 AM,3:00 PM,8.00,Recorded\r\n',
    );
  });
  it('a cell that a spreadsheet would run as a formula is neutralized', () => {
    expect(csvField('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvField('+1')).toBe("'+1");
    expect(csvField('@cmd')).toBe("'@cmd");
    expect(csvField('Ana')).toBe('Ana');
  });
});
