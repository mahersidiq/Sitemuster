import type { ApiErrorCode } from '../../../packages/shared/src/api/common.ts';

/**
 * HTTP helpers shared by Edge Functions (spec 11 "API conventions"): JSON only, schema_version 1,
 * request_id on every response, machine error codes, never success on failure, no payload logging.
 */
export const MAX_BODY_BYTES = 262_144;

export function newRequestId(): string {
  return crypto.randomUUID();
}

export function json(
  status: number,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

export function apiError(
  status: number,
  code: ApiErrorCode,
  requestId: string,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return json(
    status,
    { schema_version: 1, request_id: requestId, error: { code, message } },
    headers,
  );
}

/** Method, media type and size checks common to every JSON POST endpoint. */
export async function readJsonBody(
  req: Request,
  requestId: string,
): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  if (req.method !== 'POST') {
    return {
      ok: false,
      response: apiError(405, 'METHOD_NOT_ALLOWED', requestId, 'Use POST.', { allow: 'POST' }),
    };
  }
  if (!(req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
    return {
      ok: false,
      response: apiError(415, 'UNSUPPORTED_MEDIA_TYPE', requestId, 'Send application/json.'),
    };
  }
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) {
    return {
      ok: false,
      response: apiError(413, 'PAYLOAD_TOO_LARGE', requestId, 'Request too large.'),
    };
  }
  const text = await req.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    return {
      ok: false,
      response: apiError(413, 'PAYLOAD_TOO_LARGE', requestId, 'Request too large.'),
    };
  }
  try {
    return { ok: true, body: JSON.parse(text) as unknown };
  } catch {
    return {
      ok: false,
      response: apiError(422, 'INVALID_REQUEST', requestId, 'Body is not valid JSON.'),
    };
  }
}

export type FunctionEnvironment = 'development' | 'staging' | 'production';

/** Anything other than an explicit development/staging marker is treated as production. */
export function functionEnvironment(value: string | undefined | null): FunctionEnvironment {
  return value === 'development' || value === 'staging' ? value : 'production';
}
