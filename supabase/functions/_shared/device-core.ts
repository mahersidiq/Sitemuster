import { sha256 } from '@noble/hashes/sha2.js';

import { DeviceActivateRequestSchema } from '../../../packages/shared/src/api/orientation.ts';
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
    return apiError(503, 'TEMPORARILY_UNAVAILABLE', requestId, 'Try again shortly.');
  }
  const data = result.data as { replaced_device_id?: string | null; upload_expires_at?: string };
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
