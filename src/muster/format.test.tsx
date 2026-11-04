import { describe, expect, it } from '@jest/globals';

import type { MusterMemberRow, MusterReportView } from '../api/types';
import type { OutboxEntry } from '../outbox/outbox';
import {
  filterMembers,
  latestCheckFor,
  latestSelfReport,
  musterScans,
  musterSummaryText,
  pendingChecks,
  unresolvedCount,
} from './format';

const MUSTER = '9a000000-0000-4000-8000-0000000000a1';
const OTHER = '9a000000-0000-4000-8000-0000000000a2';
const PROJECT = '0a000000-0000-4000-8000-0000000000a1';

const row = (
  name: string,
  status: MusterMemberRow['status'],
  kind: MusterMemberRow['kind'] = 'WORKER',
): MusterMemberRow => ({
  member_id: `m-${name}`,
  kind,
  worker_id: kind === 'WORKER' ? `w-${name}` : null,
  visitor_id: kind === 'VISITOR' ? `v-${name}` : null,
  name,
  company_id: null,
  company_name: kind === 'WORKER' ? 'Acme Concrete' : null,
  organization: kind === 'VISITOR' ? 'City Inspections' : null,
  source: kind === 'VISITOR' ? 'VISITOR' : 'ROSTER_NOT_DETECTED',
  last_detection_at: null,
  initial_status: 'UNACCOUNTED',
  status,
  push: null,
  last_response: null,
});

let seq = 0;
function entry(
  type: 'MUSTER_SELF_REPORT' | 'MUSTER_PHYSICAL_VERIFY' | 'KIOSK_ENTRY',
  status: OutboxEntry['status'],
  payload: Record<string, unknown>,
): OutboxEntry {
  seq += 1;
  return {
    event: {
      event_uuid: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
      project_id: PROJECT,
      operation_type: type,
      observed_at: '2026-11-04T15:00:00Z',
      payload,
    } as OutboxEntry['event'],
    actorUserId: 'u',
    createdAt: seq,
    status,
    result: null,
    attempts: 0,
    label: { title: 't' },
  };
}

describe('muster list helpers', () => {
  const members = [
    row('Zoe', 'VERIFIED_ACCOUNTED'),
    row('Ben', 'UNACCOUNTED'),
    row('Ana', 'SELF_REPORTED_SAFE'),
    row('Cal', 'STATUS_UNKNOWN'),
    row('Vera', 'UNACCOUNTED', 'VISITOR'),
  ];

  it('"not seen yet" keeps everyone without a physical check, including self-reports', () => {
    expect(filterMembers(members, 'OPEN').map((m) => m.name)).toEqual([
      'Ben',
      'Vera',
      'Cal',
      'Ana',
    ]);
    expect(filterMembers(members, 'VISITORS').map((m) => m.name)).toEqual(['Vera']);
    expect(filterMembers(members, 'ALL')).toHaveLength(5);
  });

  it('unresolved = workers not accounted for or unknown, plus visitors not seen', () => {
    expect(
      unresolvedCount({
        workers: {
          total: 4,
          verified: 1,
          self_reported: 1,
          unknown: 1,
          unaccounted: 1,
          detected_at_start: 2,
        },
        visitors: { total: 1, verified: 0, unaccounted: 1 },
      }),
    ).toBe(3);
  });
});

describe('outbox views of one muster', () => {
  const entries = [
    entry('KIOSK_ENTRY', 'PENDING', { badge_payload: 'x' }),
    entry('MUSTER_PHYSICAL_VERIFY', 'ACCEPTED', {
      muster_id: MUSTER,
      snapshot_member_id: 'm-Ben',
      action: 'PHYSICAL_VERIFICATION',
    }),
    entry('MUSTER_PHYSICAL_VERIFY', 'PENDING', {
      muster_id: MUSTER,
      snapshot_member_id: 'm-Ben',
      action: 'PHYSICAL_VERIFICATION',
    }),
    entry('MUSTER_PHYSICAL_VERIFY', 'PENDING', {
      muster_id: MUSTER,
      action: 'PHYSICAL_VERIFICATION',
      badge_payload: 'SMB1.code',
      badge_kind: 'DYNAMIC_APP',
      kiosk_device_id: '5d000000-0000-4000-8000-0000000000a1',
    }),
    entry('MUSTER_SELF_REPORT', 'REJECTED', {
      muster_id: MUSTER,
      action: 'SELF_REPORT',
      channel: 'APP',
    }),
    entry('MUSTER_SELF_REPORT', 'PENDING', {
      muster_id: OTHER,
      action: 'SELF_REPORT',
      channel: 'APP',
    }),
  ];

  it('counts only this muster’s unsent checks (shown apart from the server counts)', () => {
    expect(pendingChecks(entries, MUSTER)).toBe(2);
    expect(pendingChecks(entries, OTHER)).toBe(1);
  });

  it('finds the latest check for a person, the worker’s own answer and the kiosk scans', () => {
    expect(latestCheckFor(entries, MUSTER, 'm-Ben')?.status).toBe('PENDING');
    expect(latestCheckFor(entries, MUSTER, 'm-Ana')).toBeNull();
    expect(latestSelfReport(entries, MUSTER)?.status).toBe('REJECTED');
    expect(musterScans(entries, MUSTER)).toHaveLength(1);
    expect(musterScans(entries, OTHER)).toHaveLength(0);
  });
});

describe('shareable summary', () => {
  it('repeats the notice and names everyone not physically accounted for', () => {
    const view: MusterReportView = {
      report: {
        notice: 'SUPPLEMENTAL_NOT_LIFE_SAFETY',
        incident_label: 'Fire alarm',
        project_name: 'Main Street Tower',
        started_at: '2026-11-04T15:00:00Z',
        started_by: 'safety@example.test',
        ended_at: '2026-11-04T15:40:00Z',
        ended_by: null,
        closing_note: 'Two people not found',
        acknowledged_incomplete: true,
        snapshot_digest: 'e'.repeat(64),
        counts: {
          workers: {
            total: 3,
            verified: 1,
            self_reported: 1,
            unknown: 0,
            unaccounted: 1,
            detected_at_start: 1,
          },
          visitors: { total: 1, verified: 0, unaccounted: 1 },
        },
        members: [
          {
            member_id: 'm1',
            kind: 'WORKER',
            name: 'Ben Avila',
            company_name: 'Acme Concrete',
            organization: null,
            source: 'ROSTER_NOT_DETECTED',
            initial_status: 'UNACCOUNTED',
            final_status: 'UNACCOUNTED',
            push: 'NO_DEVICE',
            responses: [],
          },
          {
            member_id: 'm2',
            kind: 'WORKER',
            name: 'Ana Acosta',
            company_name: 'Acme Concrete',
            organization: null,
            source: 'ONSITE_GEOFENCE',
            initial_status: 'UNACCOUNTED',
            final_status: 'SELF_REPORTED_SAFE',
            push: 'SENT',
            responses: [],
          },
          {
            member_id: 'm3',
            kind: 'VISITOR',
            name: 'Vera Inspector',
            company_name: null,
            organization: 'City Inspections',
            source: 'VISITOR',
            initial_status: 'UNACCOUNTED',
            final_status: 'UNACCOUNTED',
            push: null,
            responses: [],
          },
        ],
        push: { sent: 1, failed: 0, no_device: 1, not_attempted: 0 },
      },
      digest: 'abcdef0123456789'.repeat(4),
      can_amend: true,
      amendments: [],
    };
    const t = (key: string, params?: Record<string, string | number>) =>
      params ? `${key} ${JSON.stringify(params)}` : key;
    const text = musterSummaryText(view, t, (iso) => iso);
    expect(text.split('\n')[1]).toBe('muster.report.notice');
    expect(text).toContain('muster.summary.unresolved {"count":2}');
    expect(text).toContain(
      'muster.summary.person {"name":"Ben Avila","group":"Acme Concrete","status":"muster.status.UNACCOUNTED"}',
    );
    expect(text).toContain(
      'muster.summary.person {"name":"Vera Inspector","group":"City Inspections","status":"muster.status.UNACCOUNTED"}',
    );
    expect(text).toContain('muster.summary.selfOnly {"count":1}');
    expect(text).toContain(
      'muster.report.ended {"time":"2026-11-04T15:40:00Z","who":"muster.report.unknownPerson"}',
    );
    expect(text).toContain('muster.report.digest {"digest":"abcdef0123456789"}');
  });
});
