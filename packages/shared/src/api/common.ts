import { z } from 'zod';

/** Every API response carries schema_version=1, a request_id and (on error) a machine code. */
export const SchemaVersionSchema = z.literal(1);

export const UuidSchema = z.uuid();

/** UTC ISO-8601 timestamp with a trailing `Z` (offsets are rejected; server stores UTC). */
export const UtcIsoSchema = z.iso.datetime({ offset: false });

export const ApiErrorCodeSchema = z.enum([
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'METHOD_NOT_ALLOWED',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'INVALID_REQUEST',
  'RATE_LIMITED',
  'TEMPORARILY_UNAVAILABLE',
  'CONFIGURATION_ERROR',
  'CONSENT_NOTICE_NOT_APPROVED',
  'INTERNAL_ERROR',
  // Domain refusals passed through from database functions (Milestone 05).
  'IDEMPOTENCY_KEY_REQUIRED',
  'PROJECT_NOT_ACTIVE',
  'ORIENTATION_SESSION_CLOSED',
  'NO_ENROLLMENTS',
  'TOO_MANY_ENROLLMENTS',
  'WORKER_PROFILE_REQUIRED',
  // Device upload credential (Milestone 07, decision #44).
  'DEVICE_REVOKED',
  'CREDENTIAL_EXPIRED',
  'CREDENTIAL_SUPERSEDED',
  'NO_DEVICE',
  // Daily reports and foreman answers (Milestone 10).
  'DAY_OPEN',
  'REPORT_VERSION_STALE',
  'REPORT_ALREADY_ANSWERED',
  'REPORT_DEADLINE_PASSED',
  'REASON_REQUIRED',
  'REASON_TOO_LONG',
  'PROPOSAL_REQUIRED',
  'WORKER_NOT_IN_REPORT',
  'SESSION_NOT_IN_REPORT',
  'EVENT_ID_CONFLICT',
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

export const ApiErrorResponseSchema = z.strictObject({
  schema_version: SchemaVersionSchema,
  request_id: UuidSchema,
  error: z.strictObject({
    code: ApiErrorCodeSchema,
    message: z.string().max(500),
  }),
});
export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;

export const TerminalStatusSchema = z.enum(['accepted', 'duplicate', 'rejected']);
