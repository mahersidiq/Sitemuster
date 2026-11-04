import { describe, expect, it } from 'vitest';

import {
  IngestOperationsRequestSchema,
  OperationEventSchema,
  sourceForOperation,
} from './operations.ts';

const ids = {
  event: '11111111-1111-4111-8111-111111111111',
  project: '00000000-0000-4000-8000-000000000001',
  kiosk: '22222222-2222-4222-8222-222222222222',
  device: '33333333-3333-4333-8333-333333333333',
  worker: '44444444-4444-4444-8444-444444444444',
  sub: '55555555-5555-4555-8555-555555555555',
  host: '66666666-6666-4666-8666-666666666666',
  muster: '77777777-7777-4777-8777-777777777777',
  member: '88888888-8888-4888-8888-888888888888',
};

const badge = `SMB1.${ids.device}.${ids.project}.59000000.AbCdEfGhIjKlMnOpQrStUv`;

const kioskEntry = {
  event_uuid: ids.event,
  project_id: ids.project,
  operation_type: 'KIOSK_ENTRY',
  observed_at: '2026-11-03T12:00:00Z',
  payload: {
    badge_payload: badge,
    badge_kind: 'DYNAMIC_APP',
    kiosk_device_id: ids.kiosk,
    direction: 'ENTRY',
  },
};

describe('OperationEventSchema', () => {
  it('accepts a kiosk dynamic-badge entry', () => {
    expect(OperationEventSchema.safeParse(kioskEntry).success).toBe(true);
  });

  it('rejects a direction that contradicts the operation type', () => {
    expect(
      OperationEventSchema.safeParse({
        ...kioskEntry,
        payload: { ...kioskEntry.payload, direction: 'EXIT' },
      }).success,
    ).toBe(false);
  });

  it('rejects a dynamic badge with a malformed payload and accepts an opaque printed badge', () => {
    expect(
      OperationEventSchema.safeParse({
        ...kioskEntry,
        payload: { ...kioskEntry.payload, badge_payload: 'not-a-badge' },
      }).success,
    ).toBe(false);
    expect(
      OperationEventSchema.safeParse({
        ...kioskEntry,
        payload: {
          ...kioskEntry.payload,
          badge_kind: 'PRINTED',
          badge_payload: 'SMP1.Zk3p9QwErTyUiOpAsDfGhJ',
        },
      }).success,
    ).toBe(true);
  });

  it('rejects client actor authority fields (server derives the actor from the JWT)', () => {
    expect(OperationEventSchema.safeParse({ ...kioskEntry, actor_id: ids.worker }).success).toBe(
      false,
    );
    expect(
      OperationEventSchema.safeParse({
        ...kioskEntry,
        payload: { ...kioskEntry.payload, actor_id: ids.worker },
      }).success,
    ).toBe(false);
  });

  it('limits foreman bulk operations to 1–100 named workers', () => {
    const foreman = (count: number) => ({
      event_uuid: ids.event,
      project_id: ids.project,
      operation_type: 'FOREMAN_BULK_ENTRY',
      observed_at: '2026-11-03T12:00:00Z',
      payload: {
        subcontractor_id: ids.sub,
        worker_ids: Array.from({ length: count }, () => ids.worker),
        direction: 'ENTRY',
        verification_method: 'PHYSICAL_CONFIRMATION',
      },
    });
    expect(OperationEventSchema.safeParse(foreman(1)).success).toBe(true);
    expect(OperationEventSchema.safeParse(foreman(100)).success).toBe(true);
    expect(OperationEventSchema.safeParse(foreman(0)).success).toBe(false);
    expect(OperationEventSchema.safeParse(foreman(101)).success).toBe(false);
  });

  it('requires a reason and a real change for manual corrections', () => {
    const manual = (payload: Record<string, unknown>) => ({
      event_uuid: ids.event,
      project_id: ids.project,
      operation_type: 'MANUAL_ATTENDANCE_CORRECTION',
      observed_at: '2026-11-03T12:00:00Z',
      payload,
    });
    expect(
      OperationEventSchema.safeParse(
        manual({
          worker_id: ids.worker,
          corrected_end_at: '2026-11-03T17:00:00Z',
          reason: 'Left at 5',
        }),
      ).success,
    ).toBe(true);
    expect(
      OperationEventSchema.safeParse(manual({ worker_id: ids.worker, reason: 'nothing changed' }))
        .success,
    ).toBe(false);
    expect(
      OperationEventSchema.safeParse(
        manual({ worker_id: ids.worker, corrected_end_at: '2026-11-03T17:00:00Z', reason: '' }),
      ).success,
    ).toBe(false);
    expect(
      OperationEventSchema.safeParse(
        manual({
          worker_id: ids.worker,
          corrected_start_at: '2026-11-03T17:00:00Z',
          corrected_end_at: '2026-11-03T16:00:00Z',
          reason: 'backwards interval',
        }),
      ).success,
    ).toBe(false);
  });

  it('requires visitor_id for visitor exits and a name or id for entries', () => {
    const visitor = (operation_type: string, payload: Record<string, unknown>) => ({
      event_uuid: ids.event,
      project_id: ids.project,
      operation_type,
      observed_at: '2026-11-03T12:00:00Z',
      payload: { host_user_id: ids.host, purpose: 'Inspection', ...payload },
    });
    expect(
      OperationEventSchema.safeParse(
        visitor('VISITOR_ENTRY', { name: 'A. Inspector', direction: 'ENTRY' }),
      ).success,
    ).toBe(true);
    expect(
      OperationEventSchema.safeParse(visitor('VISITOR_ENTRY', { direction: 'ENTRY' })).success,
    ).toBe(false);
    expect(
      OperationEventSchema.safeParse(
        visitor('VISITOR_EXIT', { name: 'A. Inspector', direction: 'EXIT' }),
      ).success,
    ).toBe(false);
  });

  it('never lets a self report masquerade as physical verification', () => {
    const muster = (operation_type: string, action: string) => ({
      event_uuid: ids.event,
      project_id: ids.project,
      operation_type,
      observed_at: '2026-11-03T12:00:00Z',
      payload: { muster_id: ids.muster, snapshot_member_id: ids.member, action },
    });
    expect(
      OperationEventSchema.safeParse(muster('MUSTER_SELF_REPORT', 'SELF_REPORT')).success,
    ).toBe(true);
    expect(
      OperationEventSchema.safeParse(muster('MUSTER_SELF_REPORT', 'PHYSICAL_VERIFICATION')).success,
    ).toBe(false);
    expect(
      OperationEventSchema.safeParse(muster('MUSTER_PHYSICAL_VERIFY', 'SELF_REPORT')).success,
    ).toBe(false);
  });
});

describe('IngestOperationsRequestSchema', () => {
  it('accepts 1–100 operations and rejects 0 or 101', () => {
    expect(
      IngestOperationsRequestSchema.safeParse({ schema_version: 1, events: [kioskEntry] }).success,
    ).toBe(true);
    expect(IngestOperationsRequestSchema.safeParse({ schema_version: 1, events: [] }).success).toBe(
      false,
    );
    expect(
      IngestOperationsRequestSchema.safeParse({
        schema_version: 1,
        events: Array.from({ length: 101 }, () => kioskEntry),
      }).success,
    ).toBe(false);
  });
});

describe('sourceForOperation', () => {
  it('derives the attendance source server-side from the operation type', () => {
    expect(sourceForOperation('KIOSK_ENTRY', 'DYNAMIC_APP')).toBe('KIOSK_DYNAMIC_BADGE');
    expect(sourceForOperation('KIOSK_EXIT', 'PRINTED')).toBe('KIOSK_PRINTED_BADGE');
    expect(sourceForOperation('FOREMAN_BULK_EXIT')).toBe('FOREMAN');
    expect(sourceForOperation('MANUAL_ATTENDANCE_CORRECTION')).toBe('MANUAL');
    expect(sourceForOperation('VISITOR_ENTRY')).toBe('VISITOR_KIOSK');
    expect(sourceForOperation('MUSTER_PHYSICAL_VERIFY')).toBe('MUSTER');
  });
});
