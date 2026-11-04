import { z } from 'zod';

import { PRESENCE_STATES } from '../enums.ts';
import { UtcIsoSchema, UuidSchema } from '../api/common.ts';

/**
 * Deterministic location-trace replay fixture contract (docs/spec/10-testing.md).
 * Files live at tests/location-traces/<slug>.json. The same schema is used by the replay
 * harness (Milestone 06) and by the production normalizer for shared field definitions.
 */

const Latitude = z.number().min(-90).max(90);
const Longitude = z.number().min(-180).max(180);
const Accuracy = z.number().nonnegative();

const at = { at_utc: UtcIsoSchema };

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
] as const;

export const ReplayInputSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...at, type: z.literal('NETWORK_DOWN') }),
  z.strictObject({ ...at, type: z.literal('NETWORK_UP') }),
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
  }),
  z.strictObject({ ...at, type: z.literal('DEVICE_REBOOT') }),
  z.strictObject({ ...at, type: z.literal('APP_FOREGROUND') }),
  z.strictObject({
    ...at,
    type: z.literal('WORK_WINDOW_CHANGE'),
    operates_24_7: z.boolean().optional(),
    windows: z
      .array(
        z.strictObject({
          weekday: z.number().int().min(1).max(7),
          local_start_time: z.string().regex(/^\d{2}:\d{2}$/),
          local_end_time: z.string().regex(/^\d{2}:\d{2}$/),
          crosses_midnight: z.boolean(),
        }),
      )
      .optional(),
  }),
  z.strictObject({
    ...at,
    type: z.literal('CONFIG_VERSION_CHANGE'),
    config_version: z.number().int().positive(),
    radius_m: z.number().positive().optional(),
  }),
  z.strictObject({
    ...at,
    type: z.literal('ORIENTATION_STATUS_CHANGE'),
    enrollment_status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'REVOKED']).optional(),
    employer_status: z.enum(['PENDING_CONFIRMATION', 'VERIFIED', 'REJECTED']).optional(),
    consent: z.enum(['VALID', 'EXPIRED', 'REVOKED', 'NONE']).optional(),
  }),
  z.strictObject({ ...at, type: z.literal('DEVICE_REPLACED') }),
  z.strictObject({
    ...at,
    type: z.literal('SERVER_RESPONSE'),
    http_status: z.number().int().min(100).max(599),
  }),
  z.strictObject({ ...at, type: z.literal('TIME_ADVANCE') }),
  z.strictObject({
    ...at,
    type: z.literal('FOREMAN_ENTRY'),
    direction: z.enum(['ENTRY', 'EXIT']),
    event_uuid: UuidSchema.optional(),
  }),
  z.strictObject({
    ...at,
    type: z.literal('KIOSK_SCAN'),
    direction: z.enum(['ENTRY', 'EXIT']),
    badge_kind: z.enum(['DYNAMIC_APP', 'PRINTED']),
    event_uuid: UuidSchema.optional(),
  }),
  z.strictObject({
    ...at,
    type: z.literal('MUSTER_RESPONSE'),
    action: z.enum(['SELF_REPORT', 'PHYSICAL_VERIFICATION']),
    event_uuid: UuidSchema.optional(),
  }),
]);
export type ReplayInput = z.infer<typeof ReplayInputSchema>;

export const ReplayExpectedSchema = z.looseObject({
  presence: z.enum(PRESENCE_STATES),
  session_count: z.number().int().nonnegative(),
  arrival_at: UtcIsoSchema.nullable().optional(),
  departure_at: UtcIsoSchema.nullable().optional(),
  counted_worker_count: z.number().int().nonnegative(),
  unresolved_count: z.number().int().nonnegative(),
});

export const LocationTraceFixtureSchema = z
  .strictObject({
    fixture_version: z.literal(1),
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    description: z.string().max(500).optional(),
    project: z.strictObject({
      id: UuidSchema,
      timezone: z.string().min(1),
      config_version: z.number().int().positive(),
      radius_m: z.number().min(150).max(2000),
      lat: Latitude,
      lng: Longitude,
      operates_24_7: z.boolean().optional(),
    }),
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
