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
