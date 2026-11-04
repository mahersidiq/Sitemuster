import { z } from 'zod';

import { TRACKING_DEFAULTS } from '../config/tracking-defaults.ts';
import { BadgePayloadSchema, PrintedBadgePayloadSchema } from './badge.ts';
import { SchemaVersionSchema, TerminalStatusSchema, UtcIsoSchema, UuidSchema } from './common.ts';

/**
 * Operational offline outbox contract (docs/spec/11-api-contracts.md, decision #23).
 * POST /functions/v1/ingest-operations with a Supabase user JWT (verify_jwt=true).
 * The expo-sqlite outbox owns ONLY these operation types; the native SDK owns location events.
 * Client actor fields are never authority: the server derives the actor from the JWT.
 */

export const OPERATION_TYPES = [
  'KIOSK_ENTRY',
  'KIOSK_EXIT',
  'FOREMAN_BULK_ENTRY',
  'FOREMAN_BULK_EXIT',
  'MANUAL_ATTENDANCE_CORRECTION',
  'VISITOR_ENTRY',
  'VISITOR_EXIT',
  'MUSTER_SELF_REPORT',
  'MUSTER_PHYSICAL_VERIFY',
] as const;
export type OperationType = (typeof OPERATION_TYPES)[number];

const KioskPayloadSchema = z
  .strictObject({
    badge_payload: z.string().min(1).max(256),
    badge_kind: z.enum(['DYNAMIC_APP', 'PRINTED']),
    kiosk_device_id: UuidSchema,
    direction: z.enum(['ENTRY', 'EXIT']),
  })
  .superRefine((payload, ctx) => {
    const valid =
      payload.badge_kind === 'DYNAMIC_APP'
        ? BadgePayloadSchema.safeParse(payload.badge_payload).success
        : PrintedBadgePayloadSchema.safeParse(payload.badge_payload).success;
    if (!valid) ctx.addIssue({ code: 'custom', message: 'badge payload format invalid' });
  });

const ForemanPayloadSchema = z.strictObject({
  subcontractor_id: UuidSchema,
  worker_ids: z.array(UuidSchema).min(1).max(TRACKING_DEFAULTS.foreman_bulk_max_workers),
  direction: z.enum(['ENTRY', 'EXIT']),
  verification_method: z.enum(['PHYSICAL_CONFIRMATION', 'FOREMAN_REPORT']),
});

const ManualPayloadSchema = z
  .strictObject({
    worker_id: UuidSchema,
    session_id: UuidSchema.optional(),
    corrected_start_at: UtcIsoSchema.optional(),
    corrected_end_at: UtcIsoSchema.optional(),
    reason: z.string().trim().min(3).max(1000),
  })
  .superRefine((payload, ctx) => {
    if (!payload.corrected_start_at && !payload.corrected_end_at) {
      ctx.addIssue({ code: 'custom', message: 'a correction must change start or end' });
    }
    if (
      payload.corrected_start_at &&
      payload.corrected_end_at &&
      Date.parse(payload.corrected_end_at) <= Date.parse(payload.corrected_start_at)
    ) {
      ctx.addIssue({ code: 'custom', message: 'corrected end must be after corrected start' });
    }
  });

const VisitorPayloadSchema = z
  .strictObject({
    visitor_id: UuidSchema.optional(),
    name: z.string().trim().min(1).max(200).optional(),
    organization: z.string().trim().max(200).optional(),
    host_user_id: UuidSchema,
    purpose: z.string().trim().min(1).max(500),
    direction: z.enum(['ENTRY', 'EXIT']),
  })
  .superRefine((payload, ctx) => {
    if (!payload.visitor_id && !payload.name) {
      ctx.addIssue({ code: 'custom', message: 'visitor_id or name required' });
    }
    if (payload.direction === 'EXIT' && !payload.visitor_id) {
      ctx.addIssue({ code: 'custom', message: 'visitor exit requires visitor_id' });
    }
  });

const MusterPayloadSchema = z.strictObject({
  muster_id: UuidSchema,
  snapshot_member_id: UuidSchema,
  action: z.enum(['SELF_REPORT', 'PHYSICAL_VERIFICATION']),
  witness_actor_id: UuidSchema.optional(),
});

const base = {
  event_uuid: UuidSchema,
  project_id: UuidSchema,
  observed_at: UtcIsoSchema,
};

function directionMustBe<T extends { direction: 'ENTRY' | 'EXIT' }>(expected: 'ENTRY' | 'EXIT') {
  return (payload: T, ctx: z.RefinementCtx) => {
    if (payload.direction !== expected) {
      ctx.addIssue({ code: 'custom', message: `direction must be ${expected}` });
    }
  };
}

function musterActionMustBe(expected: 'SELF_REPORT' | 'PHYSICAL_VERIFICATION') {
  return (payload: z.infer<typeof MusterPayloadSchema>, ctx: z.RefinementCtx) => {
    if (payload.action !== expected) {
      ctx.addIssue({ code: 'custom', message: `action must be ${expected}` });
    }
  };
}

export const OperationEventSchema = z.discriminatedUnion('operation_type', [
  z.strictObject({
    ...base,
    operation_type: z.literal('KIOSK_ENTRY'),
    payload: KioskPayloadSchema.superRefine(directionMustBe('ENTRY')),
  }),
  z.strictObject({
    ...base,
    operation_type: z.literal('KIOSK_EXIT'),
    payload: KioskPayloadSchema.superRefine(directionMustBe('EXIT')),
  }),
  z.strictObject({
    ...base,
    operation_type: z.literal('FOREMAN_BULK_ENTRY'),
    payload: ForemanPayloadSchema.superRefine(directionMustBe('ENTRY')),
  }),
  z.strictObject({
    ...base,
    operation_type: z.literal('FOREMAN_BULK_EXIT'),
    payload: ForemanPayloadSchema.superRefine(directionMustBe('EXIT')),
  }),
  z.strictObject({
    ...base,
    operation_type: z.literal('MANUAL_ATTENDANCE_CORRECTION'),
    payload: ManualPayloadSchema,
  }),
  z.strictObject({
    ...base,
    operation_type: z.literal('VISITOR_ENTRY'),
    payload: VisitorPayloadSchema.superRefine(directionMustBe('ENTRY')),
  }),
  z.strictObject({
    ...base,
    operation_type: z.literal('VISITOR_EXIT'),
    payload: VisitorPayloadSchema.superRefine(directionMustBe('EXIT')),
  }),
  z.strictObject({
    ...base,
    operation_type: z.literal('MUSTER_SELF_REPORT'),
    payload: MusterPayloadSchema.superRefine(musterActionMustBe('SELF_REPORT')),
  }),
  z.strictObject({
    ...base,
    operation_type: z.literal('MUSTER_PHYSICAL_VERIFY'),
    payload: MusterPayloadSchema.superRefine(musterActionMustBe('PHYSICAL_VERIFICATION')),
  }),
]);
export type OperationEvent = z.infer<typeof OperationEventSchema>;

export const IngestOperationsRequestSchema = z.strictObject({
  schema_version: SchemaVersionSchema,
  /**
   * The phone's clock when it sent this request. Compared with the server's receipt time it
   * measures a wrong kiosk clock in either direction (decision #84).
   */
  client_sent_at: UtcIsoSchema,
  events: z.array(OperationEventSchema).min(1).max(TRACKING_DEFAULTS.operations_ingest_max_events),
});
export type IngestOperationsRequest = z.infer<typeof IngestOperationsRequestSchema>;

export const OperationChildResultSchema = z.strictObject({
  worker_id: UuidSchema,
  child_event_uuid: UuidSchema,
  status: TerminalStatusSchema,
  reason: z.string().nullable(),
});

export const OperationResultSchema = z.strictObject({
  event_uuid: UuidSchema,
  status: TerminalStatusSchema,
  reason: z.string().nullable(),
  children: z.array(OperationChildResultSchema).max(100).optional(),
  /** Kiosk scans: the worker the badge belongs to, only when the scan was authorized (#98). */
  worker_id: UuidSchema.nullable().optional(),
  /** Stored but held for human review (e.g. a wrong kiosk clock) instead of verified (#84). */
  review: z.boolean().optional(),
  /** A re-sent operation: the outcome it got the first time (#98). */
  original_status: z.enum(['accepted', 'rejected']).optional(),
});
export type OperationResult = z.infer<typeof OperationResultSchema>;
export type OperationChildResult = z.infer<typeof OperationChildResultSchema>;

/**
 * Durable rejection reasons the app explains (EN/ES). Anything else is shown with a generic text.
 * Attendance-engine reasons (ENROLLMENT_NOT_APPROVED, EMPLOYER_NOT_VERIFIED, CONSENT_MISSING,
 * PROJECT_NOT_ACTIVE, ...) may also appear.
 */
export const OPERATION_REASONS = [
  'FORBIDDEN',
  'PROJECT_NOT_AUTHORIZED',
  'KIOSK_NOT_REGISTERED',
  'BADGE_INVALID',
  'BADGE_PROJECT_MISMATCH',
  'BADGE_EXPIRED',
  'BADGE_REVOKED',
  'BADGE_MAC_INVALID',
  'BADGE_REPLAY',
  'DEVICE_REVOKED',
  'NOT_APPROVED',
  'NOT_OWN_CREW',
  'COMPANY_NOT_AUTHORIZED',
  'WORKER_NOT_IN_COMPANY',
  'WORKER_NOT_ENROLLED',
  'SOME_WORKERS_REJECTED',
  'VISITOR_ID_CONFLICT',
  'VISITOR_DETAILS_REQUIRED',
  'HOST_NOT_FOUND',
  'VISIT_NOT_FOUND',
  'ALREADY_CHECKED_IN',
  'OPERATION_NOT_SUPPORTED',
  'EVENT_UUID_CONFLICT',
] as const;
export type OperationReason = (typeof OPERATION_REASONS)[number];

export const IngestOperationsResponseSchema = z.strictObject({
  schema_version: SchemaVersionSchema,
  request_id: UuidSchema,
  results: z.array(OperationResultSchema).min(1).max(100),
});
export type IngestOperationsResponse = z.infer<typeof IngestOperationsResponseSchema>;

/** Source is derived server-side from the operation type; clients never choose it. */
export function sourceForOperation(type: OperationType, badgeKind?: 'DYNAMIC_APP' | 'PRINTED') {
  switch (type) {
    case 'KIOSK_ENTRY':
    case 'KIOSK_EXIT':
      return badgeKind === 'PRINTED' ? 'KIOSK_PRINTED_BADGE' : 'KIOSK_DYNAMIC_BADGE';
    case 'FOREMAN_BULK_ENTRY':
    case 'FOREMAN_BULK_EXIT':
      return 'FOREMAN';
    case 'MANUAL_ATTENDANCE_CORRECTION':
      return 'MANUAL';
    case 'VISITOR_ENTRY':
    case 'VISITOR_EXIT':
      return 'VISITOR_KIOSK';
    case 'MUSTER_SELF_REPORT':
    case 'MUSTER_PHYSICAL_VERIFY':
      return 'MUSTER';
  }
}
