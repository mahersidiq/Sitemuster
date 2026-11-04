import { z } from 'zod';

import { TRACKING_DEFAULTS } from '../config/tracking-defaults.ts';
import { containsCoordinateKeys } from '../privacy/coordinates.ts';
import { SchemaVersionSchema, TerminalStatusSchema, UtcIsoSchema, UuidSchema } from './common.ts';

/**
 * Native location ingestion contract (docs/spec/11-api-contracts.md, decisions #24, #39, #45).
 * POST /functions/v1/ingest-location-batch, custom device bearer credential, verify_jwt=false.
 */

export const SDK_EVENT_TYPES = [
  'geofence',
  'motionchange',
  'heartbeat',
  'location',
  'providerchange',
] as const;

export const SdkGeofenceWireSchema = z.strictObject({
  identifier: z.string().min(1).max(128),
  action: z.enum(['ENTER', 'EXIT']),
});

export const SdkCoordsSchema = z.strictObject({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracy: z.number().nonnegative(),
});

/**
 * One record as sent by the native SDK. Unknown vendor-only fields are preserved for the
 * sanitizer (never inserted into the database); tenant identity is NEVER read from a record.
 */
export const SdkEventWireSchema = z
  .looseObject({
    uuid: UuidSchema,
    timestamp: UtcIsoSchema,
    event: z.enum(SDK_EVENT_TYPES),
    geofence: SdkGeofenceWireSchema.optional(),
    coords: SdkCoordsSchema.optional(),
    /** Horizontal accuracy (metres). REQUIRED on geofence events (corroborates EXIT, #45). */
    accuracy: z.number().nonnegative().optional(),
    is_moving: z.boolean().optional(),
    mock: z.boolean().optional(),
    extras: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((record, ctx) => {
    if (record.event === 'geofence') {
      if (!record.geofence) {
        ctx.addIssue({ code: 'custom', message: 'geofence events require geofence metadata' });
      }
      if (record.accuracy === undefined) {
        ctx.addIssue({ code: 'custom', message: 'geofence events require accuracy' });
      }
      if (containsCoordinateKeys(record)) {
        ctx.addIssue({ code: 'custom', message: 'geofence events must be coordinate-free' });
      }
    } else if (record.geofence) {
      ctx.addIssue({
        code: 'custom',
        message: 'geofence metadata only allowed on geofence events',
      });
    }
    if (record.event === 'providerchange' && record.coords) {
      ctx.addIssue({ code: 'custom', message: 'provider-change records must not carry coords' });
    }
  });
export type SdkEventWire = z.infer<typeof SdkEventWireSchema>;

/** Strict envelope: no worker/project/organization authority can be supplied by the client. */
export const SdkBatchEnvelopeSchema = z.strictObject({
  locations: z.array(z.unknown()).min(1).max(TRACKING_DEFAULTS.location_ingest_max_batch_events),
  schema_version: SchemaVersionSchema.optional(),
});
export type SdkBatchEnvelope = z.infer<typeof SdkBatchEnvelopeSchema>;

export const LocationIngestResultSchema = z.strictObject({
  event_uuid: UuidSchema,
  status: TerminalStatusSchema,
  reason: z.string().nullable(),
});

/** HTTP 200 body: returned ONLY when every record reached a durable terminal outcome. */
export const LocationIngestResponseSchema = z.strictObject({
  schema_version: SchemaVersionSchema,
  request_id: UuidSchema,
  results: z.array(LocationIngestResultSchema).min(1).max(25),
});
export type LocationIngestResponse = z.infer<typeof LocationIngestResponseSchema>;

export const LOCATION_REJECTION_REASONS = [
  'INVALID_RECORD',
  'PROJECT_NOT_AUTHORIZED',
  'UNKNOWN_GEOFENCE_IDENTIFIER',
  'DEVICE_REVOKED',
  'ENROLLMENT_NOT_APPROVED',
  'CONSENT_MISSING',
  'CONFIG_VERSION_MISSING',
  'COORDINATES_NOT_PERMITTED',
  'PROVIDER_CHANGE_DISCARDED',
  'CLOCK_SKEW_REVIEW',
  'LATE_EVENT_REVIEW',
] as const;
export type LocationRejectionReason = (typeof LOCATION_REJECTION_REASONS)[number];

/** Internal, server-derived event. Auth-derived keys can never be overwritten by the payload. */
export const NormalizedLocationEventSchema = z.strictObject({
  event_uuid: UuidSchema,
  device_id: UuidSchema,
  worker_id: UuidSchema,
  project_id: UuidSchema,
  organization_id: UuidSchema,
  enrollment_id: UuidSchema,
  config_version_id: UuidSchema,
  kind: z.enum(['GEOFENCE_ENTER', 'GEOFENCE_EXIT', 'ONSITE_FIX']),
  observed_at: UtcIsoSchema,
  received_at: UtcIsoSchema,
  accuracy_m: z.number().nonnegative().optional(),
  onsite_point: z
    .strictObject({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) })
    .optional(),
  sdk_geofence_identifier: z.string().min(1).max(128).optional(),
  is_mock: z.boolean(),
  validity_state: z.enum(['VALID', 'FLAGGED_CLOCK_SKEW', 'FLAGGED_LATE', 'FLAGGED_MOCK']),
  source: z.literal('GEOFENCE'),
});
export type NormalizedLocationEvent = z.infer<typeof NormalizedLocationEventSchema>;
