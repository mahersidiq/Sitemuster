import { sha256 } from '@noble/hashes/sha2.js';

import { DeviceActivateRequestSchema } from '../../../packages/shared/src/api/orientation.ts';
import { deriveUuid } from '../../../packages/shared/src/attendance/config.ts';
import { iso } from '../../../packages/shared/src/attendance/time.ts';
import type { Evidence } from '../../../packages/shared/src/attendance/types.ts';
import { base64UrlEncode } from '../../../packages/shared/src/crypto/encoding.ts';
import { BADGE_KEY_VERSION, encryptBadgeSecret, resolveBadgeKey, toPgHex } from './badge-crypto.ts';
import { apiError, json, newRequestId, readJsonBody } from './http.ts';
import type { RpcResult } from './postgrest.ts';

/**
 * device-activate (spec 11, decision #27/#43): registers the worker's ONE active personal device,
 * revoking the previous one, and returns the 32-byte badge secret and the background upload token
 * exactly once over TLS. Only ciphertext / hashes are stored server-side.
 */
export interface DeviceDeps {
  environment: 'development' | 'staging' | 'production';
  badgeKey: string | null;
  userId(authorization: string): Promise<string | null>;
  activate(args: Record<string, unknown>): Promise<RpcResult>;
  randomBytes(length: number): Uint8Array;
  newDeviceId(): string;
  /**
   * Decision #27: a replacement flags the worker's active sessions for review — projects with an
   * active session (service role) and the reconciler that applies MONITORING REPLACED evidence.
   */
  openSessionProjects?(workerId: string): Promise<string[]>;
  flagReplacement?(evidence: Evidence[]): Promise<void>;
  now?(): number;
  log?(entry: Record<string, unknown>): void;
}

/** Best effort after a committed activation: never turns a successful activation into a failure. */
async function flagActiveSessions(
  deps: DeviceDeps,
  workerId: string,
  deviceId: string,
): Promise<void> {
  if (!deps.openSessionProjects || !deps.flagReplacement) return;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const projects = await deps.openSessionProjects(workerId);
      if (projects.length === 0) return;
      const at = iso(deps.now?.() ?? Date.now());
      await deps.flagReplacement(
        projects.map((projectId) => ({
          kind: 'MONITORING' as const,
          eventUuid: deriveUuid('device-replaced', `${deviceId}|${projectId}`),
          projectId,
          workerId,
          deviceId,
          observedAt: at,
          receivedAt: at,
          change: 'REPLACED' as const,
          reason: 'DEVICE_REPLACED',
        })),
      );
      return;
    } catch {
      deps.log?.({ fn: 'device-activate', outcome: 'replacement_review_retry', attempt });
    }
  }
  deps.log?.({ fn: 'device-activate', outcome: 'replacement_review_failed' });
}

export async function handleDeviceActivate(req: Request, deps: DeviceDeps): Promise<Response> {
  const requestId = newRequestId();
  const authorization = req.headers.get('authorization') ?? '';
  if (!/^Bearer\s+\S+$/i.test(authorization))
    return apiError(401, 'UNAUTHENTICATED', requestId, 'Sign in first.');
  const key = resolveBadgeKey(deps.environment, deps.badgeKey);
  if (!key.ok) {
    return apiError(503, 'CONFIGURATION_ERROR', requestId, 'Device activation is not configured.');
  }
  const body = await readJsonBody(req, requestId);
  if (!body.ok) return body.response;
  const parsed = DeviceActivateRequestSchema.safeParse(body.body);
  if (!parsed.success)
    return apiError(422, 'INVALID_REQUEST', requestId, 'Invalid activation request.');
  const userId = await deps.userId(authorization);
  if (!userId) return apiError(401, 'UNAUTHENTICATED', requestId, 'Sign in first.');

  const deviceId = deps.newDeviceId();
  const badgeSecret = deps.randomBytes(32);
  const uploadToken = deps.randomBytes(32);
  const ciphertext = await encryptBadgeSecret(key.key, badgeSecret, deviceId);
  const result = await deps.activate({
    p_user_id: userId,
    p_device_id: deviceId,
    p_platform: parsed.data.platform,
    p_hardware_hash: parsed.data.installation_hash,
    p_app_version: parsed.data.app_version,
    p_secret_ciphertext: toPgHex(ciphertext),
    p_key_version: BADGE_KEY_VERSION,
    p_upload_token_hash: toPgHex(sha256(uploadToken)),
  });
  if (!result.ok) {
    if (result.code === 'WORKER_PROFILE_REQUIRED') {
      return apiError(422, 'WORKER_PROFILE_REQUIRED', requestId, 'Join a project first.');
    }
    if (result.code === 'FORBIDDEN') return apiError(403, 'FORBIDDEN', requestId, 'Not allowed.');
    if (result.code === 'RATE_LIMITED') {
      return apiError(429, 'RATE_LIMITED', requestId, 'Too many activations. Try again later.');
    }
    return apiError(503, 'TEMPORARILY_UNAVAILABLE', requestId, 'Try again shortly.');
  }
  const data = result.data as {
    replaced_device_id?: string | null;
    upload_expires_at?: string;
    worker_id?: string;
  };
  if (data.replaced_device_id && data.worker_id) {
    await flagActiveSessions(deps, data.worker_id, deviceId);
  }
  return json(200, {
    schema_version: 1,
    request_id: requestId,
    device_id: deviceId,
    replaced_device_id: data.replaced_device_id ?? null,
    badge_secret: base64UrlEncode(badgeSecret),
    upload_token: base64UrlEncode(uploadToken),
    upload_expires_at: data.upload_expires_at ?? '',
  });
}
