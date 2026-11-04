import { z } from 'zod';

import type { Locale } from '../locale.ts';
import { SchemaVersionSchema, UuidSchema } from './common.ts';

/**
 * Active Muster Mode (docs/spec/11 `muster-start`, `muster-close`; docs/spec/12; Milestone 11).
 * SUPPLEMENTAL emergency accountability — not a certified evacuation or life-safety system.
 */
export const MusterStartRequestSchema = z.strictObject({
  schema_version: SchemaVersionSchema,
  project_id: UuidSchema,
  incident_label: z.string().trim().min(1, 'LABEL_REQUIRED').max(200),
  /** The same tap resent after a lost answer never starts a second muster. */
  idempotency_key: UuidSchema,
  /** A distinct incident while another muster is active (explicit commander choice). */
  separate: z.boolean().optional(),
});
export type MusterStartRequest = z.infer<typeof MusterStartRequestSchema>;

const Count = z.number().int().nonnegative();
export const MusterCountsSchema = z.object({
  workers: z.object({
    total: Count,
    verified: Count,
    self_reported: Count,
    unknown: Count,
    unaccounted: Count,
    detected_at_start: Count,
  }),
  visitors: z.object({ total: Count, verified: Count, unaccounted: Count }),
});
export type MusterCounts = z.infer<typeof MusterCountsSchema>;

/** Push is communication only: its result never changes anyone's muster status. */
export const MusterPushSummarySchema = z.strictObject({
  provider: z.enum(['expo', 'development-fake']),
  targets: Count,
  sent: Count,
  failed: Count,
});
export type MusterPushSummary = z.infer<typeof MusterPushSummarySchema>;

export const MusterStartResponseSchema = z.strictObject({
  schema_version: SchemaVersionSchema,
  request_id: UuidSchema,
  muster_id: UuidSchema,
  created: z.boolean(),
  duplicate: z.boolean(),
  already_active: z.boolean(),
  /** Null when this call joined an existing muster (nothing was sent again). */
  push: MusterPushSummarySchema.nullable(),
});
export type MusterStartResponse = z.infer<typeof MusterStartResponseSchema>;

export const MusterCloseRequestSchema = z.strictObject({
  schema_version: SchemaVersionSchema,
  muster_id: UuidSchema,
  closure_note: z.string().trim().min(3, 'REASON_REQUIRED').max(2000, 'REASON_TOO_LONG'),
  /** Required when anyone is still unaccounted or unknown (spec 12 "Close-out"). */
  acknowledge_incomplete: z.boolean(),
});
export type MusterCloseRequest = z.infer<typeof MusterCloseRequestSchema>;

export const MusterCloseResponseSchema = z.strictObject({
  schema_version: SchemaVersionSchema,
  request_id: UuidSchema,
  muster_id: UuidSchema,
  duplicate: z.boolean(),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  counts: MusterCountsSchema,
});
export type MusterCloseResponse = z.infer<typeof MusterCloseResponseSchema>;

/** The notification category whose I'M SAFE button answers from the lock screen. */
export const MUSTER_NOTIFICATION_CATEGORY = 'MUSTER';
export const MUSTER_SAFE_ACTION = 'IM_SAFE';
/** Android channel for emergency alerts (high importance), created by the app. */
export const MUSTER_ANDROID_CHANNEL = 'muster';

/**
 * The push text in the worker's language (spec 12: "Emergency muster — tap I'M SAFE").
 * Safety copy: human review before production (docs/legal/TRANSLATION_REVIEW.md).
 */
export function musterNotificationText(locale: Locale): { title: string; body: string } {
  return locale === 'es-US'
    ? {
        title: 'Reunión de emergencia — toque ESTOY A SALVO',
        body: 'Si está a salvo, toque ESTOY A SALVO. Luego vaya al punto de reunión para que lo cuenten.',
      }
    : {
        title: "Emergency muster — tap I'M SAFE",
        body: "If you are safe, tap I'M SAFE. Then go to the assembly point to be counted.",
      };
}
