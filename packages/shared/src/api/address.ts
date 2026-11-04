import { z } from 'zod';

import { SUPPORTED_LOCALES } from '../locale.ts';
import { SchemaVersionSchema, UuidSchema } from './common.ts';

/** POST /functions/v1/address-search and /address-resolve (spec 11 "Other Edge endpoints"). */
export const AddressSearchRequestSchema = z.strictObject({
  query: z.string().trim().min(3).max(200),
  session_token: z.string().min(8).max(64),
  locale: z.enum(SUPPORTED_LOCALES),
});
export type AddressSearchRequest = z.infer<typeof AddressSearchRequestSchema>;

export const AddressCandidateSchema = z.strictObject({
  place_id: z.string().min(1).max(300),
  primary_text: z.string().max(300),
  secondary_text: z.string().max(300),
});

export const AddressSearchResponseSchema = z.strictObject({
  schema_version: SchemaVersionSchema,
  request_id: UuidSchema,
  candidates: z.array(AddressCandidateSchema).max(10),
  provider: z.enum(['google', 'development_fake']),
});
export type AddressSearchResponse = z.infer<typeof AddressSearchResponseSchema>;

export const AddressResolveRequestSchema = z.strictObject({
  place_id: z.string().min(3).max(300),
  session_token: z.string().min(8).max(64),
  locale: z.enum(SUPPORTED_LOCALES),
});
export type AddressResolveRequest = z.infer<typeof AddressResolveRequestSchema>;

export const AddressResolveResponseSchema = z.strictObject({
  schema_version: SchemaVersionSchema,
  request_id: UuidSchema,
  place_id: z.string(),
  formatted_address: z.string().max(500),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  attribution: z.string().max(200),
  provider: z.enum(['google', 'development_fake']),
});
export type AddressResolveResponse = z.infer<typeof AddressResolveResponseSchema>;
