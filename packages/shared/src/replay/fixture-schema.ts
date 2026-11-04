import { z } from 'zod';

import { PRESENCE_STATES, SESSION_STATUSES } from '../enums.ts';
import { UtcIsoSchema, UuidSchema } from '../api/common.ts';

/**
 * Deterministic location-trace replay fixture contract (docs/spec/10-testing.md).
 * Files live at tests/location-traces/<slug>.json and are replayed by the
 * LocationTraceReplayHarness (tests/location-replay/harness) against the production attendance
 * engine. Milestone 06 extends the Milestone 01 contract with optional fields only; every
 * Milestone 01 fixture stays valid.
 */

const Latitude = z.number().min(-90).max(90);
const Longitude = z.number().min(-180).max(180);
const Accuracy = z.number().nonnegative();
const HHMM = z.string().regex(/^\d{2}:\d{2}$/);
/** Short key of a fixture worker ("B", "C", …); the primary worker is "A". */
const WorkerKey = z.string().regex(/^[A-Z]$/);

const at = { at_utc: UtcIsoSchema };

const WindowSchema = z.strictObject({
  weekday: z.number().int().min(1).max(7),
  local_start_time: HHMM,
  local_end_time: HHMM,
  crosses_midnight: z.boolean().optional(),
});

const EligibilityFields = {
  enrollment_status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'REVOKED']).optional(),
  employer_status: z.enum(['PENDING_CONFIRMATION', 'VERIFIED', 'REJECTED']).optional(),
  consent: z.enum(['VALID', 'EXPIRED', 'REVOKED', 'NONE']).optional(),
};

export const REPLAY_INPUT_TYPES = [
  'NETWORK_DOWN',
  'NETWORK_UP',
  'PERMISSION_GRANTED',
  'PERMISSION_REVOKED',
  'EVENT_ENTER',
  'EVENT_EXIT',
  'FIX',
  'DEVICE_REBOOT',
  'APP_FOREGROUND',
  'WORK_WINDOW_CHANGE',
  'CONFIG_VERSION_CHANGE',
  'ORIENTATION_STATUS_CHANGE',
  'DEVICE_REPLACED',
  'SERVER_RESPONSE',
  'TIME_ADVANCE',
  'FOREMAN_ENTRY',
  'KIOSK_SCAN',
  'MUSTER_RESPONSE',
  // Milestone 06 additions.
  'MANUAL_ATTENDANCE',
  'APPROVE_UNSCHEDULED',
  'VISITOR',
  'PROJECT_STATUS_CHANGE',
  'CREDENTIAL_REVOKED',
  'SILENT_PUSH',
  'APP_FORCE_STOPPED',
] as const;

export const ReplayInputSchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...at,
    type: z.literal('NETWORK_DOWN'),
    target: z.enum(['PHONE', 'KIOSK']).optional(),
  }),
  z.strictObject({
    ...at,
    type: z.literal('NETWORK_UP'),
    target: z.enum(['PHONE', 'KIOSK']).optional(),
  }),
  z.strictObject({
    ...at,
    type: z.literal('PERMISSION_GRANTED'),
    level: z.enum(['WHEN_IN_USE', 'ALWAYS']).optional(),
    precise: z.boolean().optional(),
  }),
  z.strictObject({ ...at, type: z.literal('PERMISSION_REVOKED') }),
  z.strictObject({
    ...at,
    type: z.literal('EVENT_ENTER'),
    event_uuid: UuidSchema.optional(),
    accuracy_m: Accuracy.optional(),
    project_id: UuidSchema.optional(),
  }),
  z.strictObject({
    ...at,
    type: z.literal('EVENT_EXIT'),
    event_uuid: UuidSchema.optional(),
    accuracy_m: Accuracy.optional(),
    project_id: UuidSchema.optional(),
    /** Simulated defect: a misconfigured template leaks the exit coordinates (must be rejected). */
    leak_coordinates: z.boolean().optional(),
  }),
  z.strictObject({
    ...at,
    type: z.literal('FIX'),
    lat: Latitude,
    lng: Longitude,
    accuracy_m: Accuracy,
    event_uuid: UuidSchema.optional(),
    mock: z.boolean().optional(),
    device_clock_utc: UtcIsoSchema.optional(),
    /** Simulated defect: the phone transmits this fix even outside its privacy gate. */
    force_transmit: z.boolean().optional(),
  }),
  z.strictObject({ ...at, type: z.literal('DEVICE_REBOOT') }),
  z.strictObject({ ...at, type: z.literal('APP_FOREGROUND') }),
  z.strictObject({
    ...at,
    type: z.literal('WORK_WINDOW_CHANGE'),
    operates_24_7: z.boolean().optional(),
    windows: z.array(WindowSchema).optional(),
  }),
  z.strictObject({
    ...at,
    type: z.literal('CONFIG_VERSION_CHANGE'),
    config_version: z.number().int().positive(),
    radius_m: z.number().positive().optional(),
    dwell_seconds: z.number().int().positive().optional(),
    lat: Latitude.optional(),
    lng: Longitude.optional(),
  }),
  z.strictObject({
    ...at,
    type: z.literal('ORIENTATION_STATUS_CHANGE'),
    worker: WorkerKey.optional(),
    ...EligibilityFields,
  }),
  z.strictObject({ ...at, type: z.literal('DEVICE_REPLACED') }),
  z.strictObject({
    ...at,
    type: z.literal('SERVER_RESPONSE'),
    http_status: z.number().int().min(100).max(599),
    /** How many following upload attempts receive this status (default 1). */
    count: z.number().int().positive().optional(),
  }),
  z.strictObject({ ...at, type: z.literal('TIME_ADVANCE') }),
  z.strictObject({
    ...at,
    type: z.literal('FOREMAN_ENTRY'),
    direction: z.enum(['ENTRY', 'EXIT']),
    event_uuid: UuidSchema.optional(),
    workers: z.array(WorkerKey).min(1).optional(),
    method: z.enum(['PHYSICAL_CONFIRMATION', 'FOREMAN_REPORT']).optional(),
  }),
  z.strictObject({
    ...at,
    type: z.literal('KIOSK_SCAN'),
    direction: z.enum(['ENTRY', 'EXIT']),
    badge_kind: z.enum(['DYNAMIC_APP', 'PRINTED']),
    event_uuid: UuidSchema.optional(),
    worker: WorkerKey.optional(),
    kiosk: z.enum(['K1', 'K2']).optional(),
    /** Re-scan the exact badge payload of an earlier scan (screenshot / replay attempt). */
    replay_of: UuidSchema.optional(),
    kiosk_clock_offset_s: z.number().int().optional(),
  }),
  z.strictObject({
    ...at,
    type: z.literal('MUSTER_RESPONSE'),
    action: z.enum(['SELF_REPORT', 'PHYSICAL_VERIFICATION']),
    event_uuid: UuidSchema.optional(),
  }),
  z.strictObject({
    ...at,
    type: z.literal('MANUAL_ATTENDANCE'),
    event_uuid: UuidSchema.optional(),
    worker: WorkerKey.optional(),
    session: z.enum(['CURRENT', 'LAST']).optional(),
    corrected_start_utc: UtcIsoSchema.optional(),
    corrected_end_utc: UtcIsoSchema.optional(),
    reason: z.string().min(3).max(200),
  }),
  z.strictObject({
    ...at,
    type: z.literal('APPROVE_UNSCHEDULED'),
    event_uuid: UuidSchema.optional(),
    session: z.enum(['CURRENT', 'LAST']),
  }),
  z.strictObject({
    ...at,
    type: z.literal('VISITOR'),
    event_uuid: UuidSchema.optional(),
    direction: z.enum(['ENTRY', 'EXIT']),
    visitor: z.string().min(1).max(40),
  }),
  z.strictObject({
    ...at,
    type: z.literal('PROJECT_STATUS_CHANGE'),
    status: z.enum(['ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED']),
  }),
  z.strictObject({ ...at, type: z.literal('CREDENTIAL_REVOKED') }),
  z.strictObject({ ...at, type: z.literal('SILENT_PUSH'), delivered: z.boolean() }),
  /** Android Settings → Force stop (or iOS swipe-away): nothing runs until the app is opened. */
  z.strictObject({ ...at, type: z.literal('APP_FORCE_STOPPED') }),
]);
export type ReplayInput = z.infer<typeof ReplayInputSchema>;

const ExpectedSessionSchema = z.strictObject({
  start_at: UtcIsoSchema,
  end_at: UtcIsoSchema.nullable().optional(),
  status: z.enum(SESSION_STATUSES),
  start_source: z.string().optional(),
  end_source: z.string().nullable().optional(),
  config_version: z.number().int().positive().optional(),
  end_earliest_at: UtcIsoSchema.nullable().optional(),
  end_latest_at: UtcIsoSchema.nullable().optional(),
  unscheduled: z.boolean().optional(),
  gap_count: z.number().int().nonnegative().optional(),
});

const CountsSchema = z
  .strictObject({
    approved_roster: z.number().int().nonnegative(),
    estimated_onsite: z.number().int().nonnegative(),
    manually_verified: z.number().int().nonnegative(),
    presence_unknown: z.number().int().nonnegative(),
    arriving: z.number().int().nonnegative(),
    unscheduled_pending: z.number().int().nonnegative(),
    departure_pending: z.number().int().nonnegative(),
    unresolved_sessions: z.number().int().nonnegative(),
    visitors_onsite: z.number().int().nonnegative(),
    visitors_unresolved: z.number().int().nonnegative(),
  })
  .partial();

const DaySchema = z.strictObject({
  local_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  daily_unique_count: z.number().int().nonnegative().optional(),
  estimated_worker_seconds: z.number().int().nonnegative().optional(),
  pending_approval_seconds: z.number().int().nonnegative().optional(),
  unresolved_segment_count: z.number().int().nonnegative().optional(),
  peak_estimated_count: z.number().int().nonnegative().optional(),
});

export const ReplayExpectedSchema = z.strictObject({
  presence: z.enum(PRESENCE_STATES),
  session_count: z.number().int().nonnegative(),
  arrival_at: UtcIsoSchema.nullable().optional(),
  departure_at: UtcIsoSchema.nullable().optional(),
  counted_worker_count: z.number().int().nonnegative(),
  unresolved_count: z.number().int().nonnegative(),
  departure_earliest_at: UtcIsoSchema.nullable().optional(),
  departure_latest_at: UtcIsoSchema.nullable().optional(),
  sessions: z.array(ExpectedSessionSchema).optional(),
  counts: CountsSchema.optional(),
  days: z.array(DaySchema).optional(),
  /** Track flags that must be present (e.g. MOCK_LOCATION, AMBIGUOUS_PROJECT). */
  flags: z.array(z.string()).optional(),
  /** Server outcome per event uuid given in the inputs. */
  results: z
    .record(
      UuidSchema,
      z.strictObject({
        status: z.enum(['accepted', 'duplicate', 'rejected']),
        reason: z.string().nullable().optional(),
        review: z.boolean().optional(),
      }),
    )
    .optional(),
  /** Every rejection reason the server returned, sorted (multiset). */
  rejected_reasons: z.array(z.string()).optional(),
  egress: z
    .strictObject({
      coordinate_records_sent: z.number().int().nonnegative().optional(),
      offsite_coordinate_records_sent: z.number().int().nonnegative().optional(),
      geofence_records_sent: z.number().int().nonnegative().optional(),
    })
    .optional(),
  monitoring: z.enum(['ACTIVE', 'UNAVAILABLE']).optional(),
  device_status: z
    .enum([
      'ACTIVE',
      'CREDENTIAL_EXPIRING',
      'CREDENTIAL_EXPIRED',
      'CREDENTIAL_REVOKED',
      'NOT_ARMED',
    ])
    .optional(),
  queue_remaining: z.number().int().nonnegative().optional(),
  stored_positions: z.number().int().nonnegative().optional(),
  workers: z
    .record(
      WorkerKey,
      z.strictObject({
        presence: z.enum(PRESENCE_STATES).optional(),
        session_count: z.number().int().nonnegative().optional(),
        sessions: z.array(ExpectedSessionSchema).optional(),
      }),
    )
    .optional(),
  /** State of another project that the worker's credential must never touch. */
  other_project: z
    .strictObject({
      session_count: z.number().int().nonnegative(),
      receipts: z.number().int().nonnegative(),
    })
    .optional(),
  visitors: z
    .strictObject({
      open: z.number().int().nonnegative().optional(),
      closed: z.number().int().nonnegative().optional(),
      unresolved: z.number().int().nonnegative().optional(),
    })
    .optional(),
  muster_responses_recorded: z.number().int().nonnegative().optional(),
  /** How many times the server answered "duplicate" (retries after lost replies, resubmits). */
  duplicate_responses: z.number().int().nonnegative().optional(),
});

const ProjectSchema = z.strictObject({
  id: UuidSchema,
  timezone: z.string().min(1),
  config_version: z.number().int().positive(),
  radius_m: z.number().min(150).max(2000),
  lat: Latitude,
  lng: Longitude,
  operates_24_7: z.boolean().optional(),
  work_windows: z.array(WindowSchema).optional(),
  dwell_seconds: z.number().int().positive().optional(),
  status: z.enum(['ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED']).optional(),
});

export const LocationTraceFixtureSchema = z
  .strictObject({
    fixture_version: z.literal(1),
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    description: z.string().max(500).optional(),
    /** Number of the scenario in docs/spec/10-testing.md "Minimum deterministic suite". */
    spec_case: z.number().int().min(1).max(60).optional(),
    project: ProjectSchema,
    /** Other projects the worker is enrolled in (overlap, region budget, cross-tenant). */
    other_projects: z
      .array(
        z.strictObject({
          id: UuidSchema,
          lat: Latitude,
          lng: Longitude,
          radius_m: z.number().min(150).max(2000),
          /** Bound to this worker's device (default true). false = another tenant's project. */
          bound: z.boolean().optional(),
        }),
      )
      .optional(),
    worker: z
      .strictObject({
        ...EligibilityFields,
        has_phone: z.boolean().optional(),
        printed_badge: z.boolean().optional(),
      })
      .optional(),
    other_workers: z
      .array(
        z.strictObject({
          key: WorkerKey,
          ...EligibilityFields,
          has_phone: z.boolean().optional(),
          printed_badge: z.boolean().optional(),
        }),
      )
      .optional(),
    device: z
      .strictObject({
        /** Native region budget (iOS 15 / Android 75) and the number of enrolled projects. */
        region_budget: z.number().int().positive().optional(),
        extra_enrolled_projects: z.number().int().nonnegative().optional(),
        /** Credential age at clock start (days), to exercise renewal and expiry. */
        credential_age_days: z.number().nonnegative().optional(),
      })
      .optional(),
    clock_start_utc: UtcIsoSchema,
    initial_state: z.enum(['ARMED_OFFSITE', 'NOT_ARMED', ...PRESENCE_STATES]),
    inputs: z.array(ReplayInputSchema).min(1),
    expected: ReplayExpectedSchema,
  })
  .superRefine((fixture, ctx) => {
    let previous = Date.parse(fixture.clock_start_utc);
    fixture.inputs.forEach((input, index) => {
      const current = Date.parse(input.at_utc);
      if (current < previous) {
        ctx.addIssue({
          code: 'custom',
          path: ['inputs', index, 'at_utc'],
          message: 'inputs must be in non-decreasing wall-clock order (simulated arrival order)',
        });
      }
      previous = current;
    });
  });
export type LocationTraceFixture = z.infer<typeof LocationTraceFixtureSchema>;
