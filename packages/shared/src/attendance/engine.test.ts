import { describe, expect, it } from 'vitest';

import { configFromSettings, deriveUuid } from './config.ts';
import { emptyTrack, processEvidence } from './engine.ts';
import type { EngineContext, Evidence } from './types.ts';

const P = '00000000-0000-4000-8000-000000000001';
const W = '00000000-0000-4000-8000-0000000000aa';
const D = '00000000-0000-4000-8000-0000000000dd';
const config = configFromSettings({
  configVersionId: 'cv1',
  projectId: P,
  versionNumber: 1,
  effectiveAt: '2026-01-01T00:00:00Z',
  settings: {
    work_windows: [1, 2, 3, 4, 5, 6].map((weekday) => ({
      weekday,
      local_start_time: '06:00',
      local_end_time: '18:00',
    })),
  },
  center: { lat: 29.7604, lng: -95.3698 },
});
const ctx = (overrides: Partial<EngineContext> = {}): EngineContext => ({
  project: { id: P, status: 'ACTIVE', timezone: 'America/Chicago' },
  configs: new Map([[config.configVersionId, config]]),
  eligibility: { eligible: true, reason: null },
  duplicates: new Set(),
  lastPosition: null,
  extraSessions: new Map(),
  employerSnapshotId: null,
  ...overrides,
});
const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const fix = (n: number, at: string, received = at): Evidence => ({
  kind: 'FIX',
  eventUuid: u(n),
  projectId: P,
  workerId: W,
  deviceId: D,
  observedAt: at,
  receivedAt: received,
  lat: 29.7604,
  lng: -95.3698,
  accuracyM: 10,
  mock: false,
  ambiguous: false,
});

describe('attendance engine', () => {
  it('orders evidence by observed time but returns results in input order', () => {
    const out = processEvidence(
      emptyTrack(P, W, 'cv1'),
      [fix(2, '2026-11-03T12:11:00Z'), fix(1, '2026-11-03T12:01:00Z')],
      ctx(),
      '2026-11-03T12:12:00Z',
    );
    expect(out.results.map((r) => r.eventUuid)).toEqual([u(2), u(1)]);
    expect(out.state.current?.startAt).toBe('2026-11-03T12:01:00Z');
  });

  it('gives a session the same id however often it is recomputed', () => {
    const run = () =>
      processEvidence(
        emptyTrack(P, W, 'cv1'),
        [fix(1, '2026-11-03T12:01:00Z'), fix(2, '2026-11-03T12:11:00Z')],
        ctx(),
        '2026-11-03T12:12:00Z',
      );
    expect(run().state.current?.id).toBe(deriveUuid('attendance-session', u(1)));
    expect(run().state.current?.id).toBe(run().state.current?.id);
  });

  it('answers a repeated uuid inside one batch as a duplicate', () => {
    const out = processEvidence(
      emptyTrack(P, W, 'cv1'),
      [fix(1, '2026-11-03T12:01:00Z'), fix(1, '2026-11-03T12:01:00Z')],
      ctx(),
      '2026-11-03T12:02:00Z',
    );
    expect(out.results.map((r) => r.status)).toEqual(['accepted', 'duplicate']);
    expect(out.receipts).toHaveLength(1);
  });

  it('never applies evidence for an ineligible worker or an inactive project', () => {
    const ineligible = processEvidence(
      emptyTrack(P, W, 'cv1'),
      [fix(1, '2026-11-03T12:01:00Z')],
      ctx({ eligibility: { eligible: false, reason: 'CONSENT_MISSING' } }),
      '2026-11-03T12:02:00Z',
    );
    expect(ineligible.results[0]).toMatchObject({ status: 'rejected', reason: 'CONSENT_MISSING' });
    const paused = processEvidence(
      emptyTrack(P, W, 'cv1'),
      [fix(1, '2026-11-03T12:01:00Z')],
      ctx({ project: { id: P, status: 'PAUSED', timezone: 'America/Chicago' } }),
      '2026-11-03T12:02:00Z',
    );
    expect(paused.results[0]).toMatchObject({ status: 'rejected', reason: 'PROJECT_NOT_ACTIVE' });
  });

  it('refuses staff actions that do not fit the data', () => {
    const approve: Evidence = {
      kind: 'APPROVE_UNSCHEDULED',
      eventUuid: u(9),
      projectId: P,
      workerId: W,
      observedAt: '2026-11-03T12:00:00Z',
      receivedAt: '2026-11-03T12:00:00Z',
      actorId: W,
      sessionId: u(99),
    };
    expect(
      processEvidence(emptyTrack(P, W, 'cv1'), [approve], ctx(), '2026-11-03T12:00:00Z').results[0],
    ).toMatchObject({ status: 'rejected', reason: 'NOT_PENDING_APPROVAL' });
    const backwards: Evidence = {
      kind: 'MANUAL',
      eventUuid: u(8),
      projectId: P,
      workerId: W,
      observedAt: '2026-11-03T17:00:00Z',
      receivedAt: '2026-11-03T17:00:00Z',
      actorId: W,
      sessionId: null,
      correctedStartAt: '2026-11-03T16:00:00Z',
      correctedEndAt: '2026-11-03T15:00:00Z',
      reason: 'typo',
    };
    expect(
      processEvidence(emptyTrack(P, W, 'cv1'), [backwards], ctx(), '2026-11-03T17:00:00Z')
        .results[0],
    ).toMatchObject({ status: 'rejected', reason: 'INVALID_CORRECTION' });
  });

  it('writes coordinate-free receipts and keeps the position only as a separate map effect', () => {
    const out = processEvidence(
      emptyTrack(P, W, 'cv1'),
      [fix(1, '2026-11-03T12:01:00Z')],
      ctx(),
      '2026-11-03T12:02:00Z',
    );
    expect(JSON.stringify(out.receipts)).not.toMatch(/lat|lng|coords/);
    expect(out.position).toMatchObject({ op: 'set', expiryAt: '2026-11-03T12:21:00Z' });
  });
});
