import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { z } from 'zod';

import { TRACKING_DEFAULTS } from '../config/tracking-defaults.ts';
import { base64UrlEncode } from '../crypto/encoding.ts';

/**
 * Orientation QR codes (decision #4, QR amendment A). Both kinds only ever lead to
 * ORIENTATION_COMPLETED + a PENDING enrollment — never to approval.
 *
 * - Rotating (supervisor screen, 60 s): `SMO1.<session_id>.<step>.<mac>` with
 *   step = floor(unix_seconds / 60) and mac = base64url(HMAC-SHA256(rotating_secret,
 *   "SMO1|" + session_id + "|" + step))[0..22]. Computed on the supervisor phone (works
 *   offline); the server accepts the current step ±1 while the session is open.
 * - Static (printed, valid only while the 120-minute session is open):
 *   `SMS1.<session_id>.<code>` where code is 32 random bytes (base64url, 43 chars); the server
 *   stores only SHA-256(code).
 */
export const ROTATING_ORIENTATION_REGEX = /^SMO1\.[0-9a-f-]{36}\.\d{1,12}\.[A-Za-z0-9_-]{22}$/;
export const STATIC_ORIENTATION_REGEX = /^SMS1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/;

export const OrientationCodeSchema = z
  .string()
  .refine(
    (value) => ROTATING_ORIENTATION_REGEX.test(value) || STATIC_ORIENTATION_REGEX.test(value),
  );

export const ORIENTATION_ROTATION_SECONDS =
  TRACKING_DEFAULTS.orientation_screen_qr_rotation_seconds;

export function orientationStep(unixSeconds: number): number {
  return Math.floor(unixSeconds / ORIENTATION_ROTATION_SECONDS);
}

export function rotatingOrientationMac(
  secret: Uint8Array,
  sessionId: string,
  step: number,
): string {
  const message = new TextEncoder().encode(`SMO1|${sessionId}|${step}`);
  return base64UrlEncode(hmac(sha256, secret, message)).slice(0, 22);
}

/** The code the supervisor screen shows at `unixSeconds` (no network needed). */
export function rotatingOrientationCode(
  secret: Uint8Array,
  sessionId: string,
  unixSeconds: number,
): string {
  const step = orientationStep(unixSeconds);
  return `SMO1.${sessionId}.${step}.${rotatingOrientationMac(secret, sessionId, step)}`;
}

export function staticOrientationCode(sessionId: string, code: string): string {
  return `SMS1.${sessionId}.${code}`;
}

/** Seconds until the rotating code changes (for the on-screen countdown). */
export function secondsUntilNextRotation(unixSeconds: number): number {
  return ORIENTATION_ROTATION_SECONDS - (Math.floor(unixSeconds) % ORIENTATION_ROTATION_SECONDS);
}

export type OrientationCodeKind = 'ROTATING' | 'STATIC';

export function orientationCodeKind(value: string): OrientationCodeKind | null {
  if (ROTATING_ORIENTATION_REGEX.test(value)) return 'ROTATING';
  if (STATIC_ORIENTATION_REGEX.test(value)) return 'STATIC';
  return null;
}

const Uuid = z.uuid();

/** POST /functions/v1/orientation-session (spec 11). */
export const OrientationSessionRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('START'), project_id: Uuid, idempotency_key: Uuid }),
  z.strictObject({ action: z.literal('CLOSE'), project_id: Uuid, session_id: Uuid }),
]);
export type OrientationSessionRequest = z.infer<typeof OrientationSessionRequestSchema>;

export const OrientationSessionSchema = z.strictObject({
  session_id: Uuid,
  project_id: Uuid,
  starts_at: z.string(),
  expires_at: z.string(),
  rotating_secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  static_code: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export type OrientationSession = z.infer<typeof OrientationSessionSchema>;

/** POST /functions/v1/enrollment-bulk-approve (spec 11): at most 100 per operation. */
export const EnrollmentBulkApproveRequestSchema = z.strictObject({
  project_id: Uuid,
  enrollment_ids: z.array(Uuid).min(1).max(TRACKING_DEFAULTS.orientation_bulk_approve_max),
});

export const BULK_APPROVE_RESULTS = [
  'APPROVED',
  'ALREADY_APPROVED',
  'NOT_FOUND',
  'NOT_PENDING',
  'ORIENTATION_MISSING',
] as const;
export const BulkApproveResultSchema = z.strictObject({
  enrollment_id: Uuid,
  result: z.enum(BULK_APPROVE_RESULTS),
});

/** POST /functions/v1/device-activate (spec 11): secrets are returned exactly once. */
export const DeviceActivateRequestSchema = z.strictObject({
  platform: z.enum(['IOS', 'ANDROID']),
  installation_hash: z.string().regex(/^[0-9a-f]{64}$/),
  app_version: z.string().min(1).max(32),
});
export type DeviceActivateRequest = z.infer<typeof DeviceActivateRequestSchema>;

export const DeviceActivateResponseSchema = z.strictObject({
  schema_version: z.literal(1),
  request_id: Uuid,
  device_id: Uuid,
  replaced_device_id: Uuid.nullable(),
  badge_secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  upload_token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  upload_expires_at: z.string(),
});
export type DeviceActivateResponse = z.infer<typeof DeviceActivateResponseSchema>;
