import { sha256 } from '@noble/hashes/sha2.js';

import { DeviceRenewRequestSchema } from '../../../packages/shared/src/api/orientation.ts';
import { base64UrlDecode, base64UrlEncode } from '../../../packages/shared/src/crypto/encoding.ts';
import { toPgHex } from './badge-crypto.ts';
import { apiError, json, newRequestId } from './http.ts';
import type { RpcResult } from './postgrest.ts';

/**
 * POST /functions/v1/device-renew (docs/spec/03 and 11, decision #44; verify_jwt=false because a
 * device secret is not a JWT). Three callers:
 * 1. the native SDK's authorization refresh — FORM POST `refresh_token=<current secret>` (and the
 *    same secret as `Authorization: Bearer`), works headless with no user session;
 * 2. the app with the current secret — JSON, `Authorization: Bearer <secret>`;
 * 3. the app with the signed-in worker session — JSON, `Authorization: Bearer <Supabase JWT>`
 *    (also after expiry: the session proves who the worker is).
 * The new secret lives 30 days; the previous one keeps working 24 h for in-flight batches.
 */
export interface RenewDeps {
  /** Auth-server confirmed user id for a Supabase JWT (never decoded locally). */
  userId(authorization: string): Promise<string | null>;
  renew(args: {
    p_token_hash: string | null;
    p_user_id: string | null;
    p_new_token_hash: string;
    p_app_version: string | null;
  }): Promise<RpcResult>;
  randomBytes(length: number): Uint8Array;
  requestId?(): string;
  log?(entry: Record<string, unknown>): void;
}

const SECRET = /^[A-Za-z0-9_-]{43}$/;
const MAX_BYTES = 4096;

function readBearer(header: string | null): { kind: 'secret' | 'jwt'; value: string } | null {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  if (!match?.[1]) return null;
  if (SECRET.test(match[1])) return { kind: 'secret', value: match[1] };
  return match[1].split('.').length === 3 ? { kind: 'jwt', value: match[1] } : null;
}

function refusal(status: string | undefined, requestId: string): Response {
  switch (status) {
    case 'EXPIRED':
      return apiError(
        401,
        'CREDENTIAL_EXPIRED',
        requestId,
        'Open SiteMuster to renew automatic attendance.',
      );
    case 'REVOKED':
      return apiError(
        401,
        'DEVICE_REVOKED',
        requestId,
        'This phone is no longer the active tracking phone.',
      );
    case 'SUPERSEDED':
      return apiError(
        401,
        'CREDENTIAL_SUPERSEDED',
        requestId,
        'A newer credential exists for this phone.',
      );
    case 'NO_DEVICE':
      return apiError(404, 'NO_DEVICE', requestId, 'Activate this phone first.');
    case 'RATE_LIMITED':
      return apiError(429, 'RATE_LIMITED', requestId, 'Too many renewals; retry later.', {
        'retry-after': '300',
      });
    default:
      return apiError(401, 'UNAUTHENTICATED', requestId, 'The device credential is not valid.');
  }
}

export async function handleDeviceRenew(req: Request, deps: RenewDeps): Promise<Response> {
  const requestId = deps.requestId?.() ?? newRequestId();
  const finish = (response: Response, outcome: string): Response => {
    deps.log?.({ fn: 'device-renew', request_id: requestId, status: response.status, outcome });
    return response;
  };
  if (req.method !== 'POST') {
    return finish(
      apiError(405, 'METHOD_NOT_ALLOWED', requestId, 'Use POST.', { allow: 'POST' }),
      'method',
    );
  }
  if (Number(req.headers.get('content-length') ?? '0') > MAX_BYTES) {
    return finish(apiError(413, 'PAYLOAD_TOO_LARGE', requestId, 'Request too large.'), 'too_large');
  }
  const type = (req.headers.get('content-type') ?? '').toLowerCase();
  const bearer = readBearer(req.headers.get('authorization'));
  let secret: string | null = bearer?.kind === 'secret' ? bearer.value : null;
  let appVersion: string | null = null;

  if (type.startsWith('application/json')) {
    const text = await req.text();
    if (text.length > MAX_BYTES) {
      return finish(
        apiError(413, 'PAYLOAD_TOO_LARGE', requestId, 'Request too large.'),
        'too_large',
      );
    }
    let body: unknown = {};
    try {
      body = text.trim() ? (JSON.parse(text) as unknown) : {};
    } catch {
      return finish(
        apiError(422, 'INVALID_REQUEST', requestId, 'Body is not valid JSON.'),
        'invalid_json',
      );
    }
    const parsed = DeviceRenewRequestSchema.safeParse(body);
    if (!parsed.success) {
      return finish(
        apiError(422, 'INVALID_REQUEST', requestId, 'Invalid renewal request.'),
        'invalid_body',
      );
    }
    appVersion = parsed.data.app_version ?? null;
  } else if (
    type.startsWith('application/x-www-form-urlencoded') ||
    type.startsWith('multipart/form-data')
  ) {
    // Typed loosely: the React Native and DOM FormData declarations differ; Deno parses both.
    const form = (await req.formData().catch(() => null)) as unknown as {
      get(name: string): unknown;
    } | null;
    if (!form) {
      return finish(
        apiError(422, 'INVALID_REQUEST', requestId, 'Invalid form body.'),
        'invalid_form',
      );
    }
    const field = form.get('refresh_token');
    if (typeof field === 'string' && field.length > 0) {
      if (!SECRET.test(field)) {
        return finish(refusal(undefined, requestId), 'invalid_refresh_token');
      }
      secret = field;
    }
  } else {
    return finish(
      apiError(415, 'UNSUPPORTED_MEDIA_TYPE', requestId, 'Send JSON or a form body.'),
      'media_type',
    );
  }

  let userId: string | null = null;
  if (!secret) {
    if (bearer?.kind !== 'jwt') {
      return finish(refusal(undefined, requestId), 'no_credential');
    }
    userId = await deps.userId(`Bearer ${bearer.value}`);
    if (!userId) return finish(refusal(undefined, requestId), 'invalid_session');
  }

  const fresh = deps.randomBytes(32);
  const result = await deps.renew({
    p_token_hash: secret ? toPgHex(sha256(base64UrlDecode(secret))) : null,
    p_user_id: userId,
    p_new_token_hash: toPgHex(sha256(fresh)),
    p_app_version: appVersion,
  });
  if (!result.ok) {
    return finish(
      apiError(503, 'TEMPORARILY_UNAVAILABLE', requestId, 'Try again shortly.'),
      'unavailable',
    );
  }
  const data = (result.data ?? {}) as {
    status?: string;
    device_id?: string;
    expires_at?: string;
    renew_after?: string;
  };
  if (data.status !== 'OK' || !data.device_id || !data.expires_at || !data.renew_after) {
    return finish(
      refusal(data.status, requestId),
      `refused_${(data.status ?? 'unknown').toLowerCase()}`,
    );
  }
  const token = base64UrlEncode(fresh);
  return finish(
    json(200, {
      schema_version: 1,
      request_id: requestId,
      device_id: data.device_id,
      upload_token: token,
      upload_expires_at: data.expires_at,
      renew_after: data.renew_after,
      // Names the SDK's authorization refresh reads (decision #92).
      access_token: token,
      refresh_token: token,
      expires: Math.floor(Date.parse(data.renew_after) / 1000),
    }),
    secret ? 'renewed_by_secret' : 'renewed_by_session',
  );
}
