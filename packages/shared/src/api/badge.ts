import { z } from 'zod';

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
