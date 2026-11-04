import { z } from 'zod';

import { SchemaVersionSchema, UuidSchema } from './common.ts';

/**
 * In-app account deletion (docs/spec/11 `POST /functions/v1/account-delete`, spec 09; Milestone 12).
 * The app sends the confirmation phrase only after the person confirmed on two screens and signed
 * in again: the server requires a sign-in from the last 15 minutes ("reauthenticated").
 */
export const ACCOUNT_DELETE_CONFIRMATION = 'DELETE_MY_ACCOUNT' as const;
export const ACCOUNT_DELETE_REAUTH_SECONDS = 15 * 60;

export const AccountDeleteRequestSchema = z.strictObject({
  schema_version: SchemaVersionSchema,
  confirmation: z
    .string()
    .refine((value) => value === ACCOUNT_DELETE_CONFIRMATION, 'CONFIRMATION_REQUIRED'),
});
export type AccountDeleteRequest = z.infer<typeof AccountDeleteRequestSchema>;

export const AccountDeleteResponseSchema = z.strictObject({
  schema_version: SchemaVersionSchema,
  request_id: UuidSchema,
  status: z.enum(['REQUESTED', 'PROCESSED']),
  process_after: z.string(),
  duplicate: z.boolean(),
});
export type AccountDeleteResponse = z.infer<typeof AccountDeleteResponseSchema>;
