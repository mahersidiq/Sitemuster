import { checkBadgePayload, parseBadgePayload } from '../../../packages/shared/src/api/badge.ts';
import { decryptBadgeSecret } from './badge-crypto.ts';

/**
 * Server verification of an offline worker badge scanned at a kiosk (spec 11 § Offline worker
 * badge). Used by ingest-operations (Milestone 08). Order: format → project binding → ±1 step
 * against the kiosk's observed time → active device → MAC (constant time) → approved enrollment →
 * single-use redemption per (project, device, 30 s step).
 */
export type BadgeVerdict =
  | { status: 'accepted' | 'duplicate'; workerId: string; deviceId: string; timeStep: number }
  | {
      status: 'rejected';
      reason:
        | 'BADGE_INVALID'
        | 'BADGE_PROJECT_MISMATCH'
        | 'BADGE_EXPIRED'
        | 'DEVICE_REVOKED'
        | 'BADGE_MAC_INVALID'
        | 'NOT_APPROVED'
        | 'BADGE_REPLAY';
    };

export interface BadgeDeps {
  key: Uint8Array;
  loadDevice(
    deviceId: string,
  ): Promise<{ active: boolean; workerId: string; ciphertext: Uint8Array } | null>;
  isApproved(workerId: string, projectId: string): Promise<boolean>;
  redeem(
    projectId: string,
    deviceId: string,
    timeStep: number,
  ): Promise<'accepted' | 'duplicate' | 'replay'>;
}

export async function verifyDynamicBadge(
  input: { payload: string; projectId: string; observedAt: Date },
  deps: BadgeDeps,
): Promise<BadgeVerdict> {
  const parsed = parseBadgePayload(input.payload);
  if (!parsed) return { status: 'rejected', reason: 'BADGE_INVALID' };
  if (parsed.projectId !== input.projectId)
    return { status: 'rejected', reason: 'BADGE_PROJECT_MISMATCH' };
  const observed = Math.floor(input.observedAt.getTime() / 1000);
  if (Math.abs(parsed.timeStep - Math.floor(observed / 30)) > 1) {
    return { status: 'rejected', reason: 'BADGE_EXPIRED' };
  }
  const device = await deps.loadDevice(parsed.deviceId);
  if (!device || !device.active) return { status: 'rejected', reason: 'DEVICE_REVOKED' };
  let secret: Uint8Array;
  try {
    secret = await decryptBadgeSecret(deps.key, device.ciphertext, parsed.deviceId);
  } catch {
    return { status: 'rejected', reason: 'BADGE_MAC_INVALID' };
  }
  const check = checkBadgePayload(input.payload, input.projectId, observed, secret);
  if (!check.ok) return { status: 'rejected', reason: check.reason };
  if (!(await deps.isApproved(device.workerId, input.projectId))) {
    return { status: 'rejected', reason: 'NOT_APPROVED' };
  }
  const redemption = await deps.redeem(input.projectId, parsed.deviceId, parsed.timeStep);
  if (redemption === 'replay') return { status: 'rejected', reason: 'BADGE_REPLAY' };
  return {
    status: redemption,
    workerId: device.workerId,
    deviceId: parsed.deviceId,
    timeStep: parsed.timeStep,
  };
}
