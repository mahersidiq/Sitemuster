import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { z } from 'zod';

import { base64UrlEncode, timingSafeEqual } from '../crypto/encoding.ts';

/**
 * Offline worker badge (decision #43, QR amendment B):
 * `SMB1.<device_id>.<project_id>.<time_step>.<mac>` where
 * time_step = floor(unix_seconds / 30) and mac = base64url(HMAC-SHA256(badge_secret,
 * "SMB1|" + device_id + "|" + project_id + "|" + time_step))[0..22].
 * The kiosk never verifies the MAC; the server does on sync.
 */
export const BADGE_PAYLOAD_REGEX =
  /^SMB1\.[0-9a-f-]{36}\.[0-9a-f-]{36}\.\d{8,12}\.[A-Za-z0-9_-]{22}$/;

export const BadgePayloadSchema = z.string().regex(BADGE_PAYLOAD_REGEX);

/** Printed badges are opaque identifiers that never contain PII. */
export const PrintedBadgePayloadSchema = z.string().regex(/^SMP1\.[A-Za-z0-9_-]{22,64}$/);

export interface ParsedBadgePayload {
  deviceId: string;
  projectId: string;
  timeStep: number;
  mac: string;
}

export function parseBadgePayload(payload: string): ParsedBadgePayload | null {
  if (!BADGE_PAYLOAD_REGEX.test(payload)) return null;
  const [, deviceId, projectId, step, mac] = payload.split('.');
  if (
    deviceId === undefined ||
    projectId === undefined ||
    step === undefined ||
    mac === undefined
  ) {
    return null;
  }
  const timeStep = Number(step);
  if (!Number.isSafeInteger(timeStep)) return null;
  return { deviceId, projectId, timeStep, mac };
}

export function badgeTimeStep(unixSeconds: number, stepSeconds = 30): number {
  return Math.floor(unixSeconds / stepSeconds);
}

export const BADGE_STEP_SECONDS = 30;

export function badgeMac(
  secret: Uint8Array,
  deviceId: string,
  projectId: string,
  timeStep: number,
): string {
  const message = new TextEncoder().encode(`SMB1|${deviceId}|${projectId}|${timeStep}`);
  return base64UrlEncode(hmac(sha256, secret, message)).slice(0, 22);
}

/** Offline badge for one project at `unixSeconds` (worker phone; no network needed). */
export function buildBadgePayload(
  secret: Uint8Array,
  deviceId: string,
  projectId: string,
  unixSeconds: number,
): string {
  const step = badgeTimeStep(unixSeconds, BADGE_STEP_SECONDS);
  return `SMB1.${deviceId}.${projectId}.${step}.${badgeMac(secret, deviceId, projectId, step)}`;
}

export type BadgeCheck =
  | { ok: true; deviceId: string; timeStep: number }
  | {
      ok: false;
      reason: 'BADGE_INVALID' | 'BADGE_PROJECT_MISMATCH' | 'BADGE_EXPIRED' | 'BADGE_MAC_INVALID';
    };

/**
 * Server-side MAC/time check (the kiosk never holds secrets). The time step must be within ±1
 * of the kiosk's observed time; single use is enforced separately by the database redemption.
 */
export function checkBadgePayload(
  payload: string,
  expectedProjectId: string,
  observedUnixSeconds: number,
  secret: Uint8Array,
): BadgeCheck {
  const parsed = parseBadgePayload(payload);
  if (!parsed) return { ok: false, reason: 'BADGE_INVALID' };
  if (parsed.projectId !== expectedProjectId)
    return { ok: false, reason: 'BADGE_PROJECT_MISMATCH' };
  if (Math.abs(parsed.timeStep - badgeTimeStep(observedUnixSeconds, BADGE_STEP_SECONDS)) > 1) {
    return { ok: false, reason: 'BADGE_EXPIRED' };
  }
  const expected = badgeMac(secret, parsed.deviceId, parsed.projectId, parsed.timeStep);
  if (!timingSafeEqual(expected, parsed.mac)) return { ok: false, reason: 'BADGE_MAC_INVALID' };
  return { ok: true, deviceId: parsed.deviceId, timeStep: parsed.timeStep };
}
