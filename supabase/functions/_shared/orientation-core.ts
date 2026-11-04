import {
  BulkApproveResultSchema,
  EnrollmentBulkApproveRequestSchema,
  OrientationSessionRequestSchema,
  OrientationSessionSchema,
} from '../../../packages/shared/src/api/orientation.ts';
import type { ApiErrorCode } from '../../../packages/shared/src/api/common.ts';
import { apiError, json, newRequestId, readJsonBody } from './http.ts';
import type { RpcResult } from './postgrest.ts';

/**
 * orientation-session and enrollment-bulk-approve (spec 11). Thin, validated front doors: the
 * database functions they call (with the caller's own JWT) enforce identity, MFA, project role and
 * the business rules; these handlers only validate input and translate results.
 */
export interface StaffRpcDeps {
  rpc(fn: string, args: Record<string, unknown>, authorization: string): Promise<RpcResult>;
}

const PASS_THROUGH: readonly ApiErrorCode[] = [
  'IDEMPOTENCY_KEY_REQUIRED',
  'PROJECT_NOT_ACTIVE',
  'ORIENTATION_SESSION_CLOSED',
  'NO_ENROLLMENTS',
  'TOO_MANY_ENROLLMENTS',
];

export function rpcFailure(result: Extract<RpcResult, { ok: false }>, requestId: string): Response {
  if (result.code === 'FORBIDDEN' || result.status === 401 || result.status === 403) {
    return apiError(403, 'FORBIDDEN', requestId, 'Not allowed.');
  }
  if (result.code && (PASS_THROUGH as readonly string[]).includes(result.code)) {
    return apiError(422, result.code as ApiErrorCode, requestId, 'Request refused.');
  }
  if (result.status >= 500 || result.status === 503) {
    return apiError(503, 'TEMPORARILY_UNAVAILABLE', requestId, 'Try again shortly.');
  }
  return apiError(422, 'INVALID_REQUEST', requestId, 'Request refused.');
}

function bearer(req: Request): string | null {
  const value = req.headers.get('authorization') ?? '';
  return /^Bearer\s+\S+$/i.test(value) ? value : null;
}

export async function handleOrientationSession(
  req: Request,
  deps: StaffRpcDeps,
): Promise<Response> {
  const requestId = newRequestId();
  const authorization = bearer(req);
  if (!authorization) return apiError(401, 'UNAUTHENTICATED', requestId, 'Sign in first.');
  const body = await readJsonBody(req, requestId);
  if (!body.ok) return body.response;
  const parsed = OrientationSessionRequestSchema.safeParse(body.body);
  if (!parsed.success)
    return apiError(422, 'INVALID_REQUEST', requestId, 'Invalid orientation request.');
  if (parsed.data.action === 'START') {
    const result = await deps.rpc(
      'start_orientation_session',
      { p_project_id: parsed.data.project_id, p_idempotency_key: parsed.data.idempotency_key },
      authorization,
    );
    if (!result.ok) return rpcFailure(result, requestId);
    const session = OrientationSessionSchema.safeParse(result.data);
    if (!session.success) return apiError(503, 'INTERNAL_ERROR', requestId, 'Unexpected response.');
    return json(200, { schema_version: 1, request_id: requestId, session: session.data });
  }
  const result = await deps.rpc(
    'close_orientation_session',
    { p_session_id: parsed.data.session_id },
    authorization,
  );
  if (!result.ok) return rpcFailure(result, requestId);
  return json(200, { schema_version: 1, request_id: requestId, closed: true });
}

export async function handleEnrollmentBulkApprove(
  req: Request,
  deps: StaffRpcDeps,
): Promise<Response> {
  const requestId = newRequestId();
  const authorization = bearer(req);
  if (!authorization) return apiError(401, 'UNAUTHENTICATED', requestId, 'Sign in first.');
  const body = await readJsonBody(req, requestId);
  if (!body.ok) return body.response;
  const parsed = EnrollmentBulkApproveRequestSchema.safeParse(body.body);
  if (!parsed.success) {
    const tooMany =
      Array.isArray((body.body as { enrollment_ids?: unknown } | null)?.enrollment_ids) &&
      (body.body as { enrollment_ids: unknown[] }).enrollment_ids.length > 100;
    return tooMany
      ? apiError(422, 'TOO_MANY_ENROLLMENTS', requestId, 'At most 100 per operation.')
      : apiError(422, 'INVALID_REQUEST', requestId, 'Invalid approval request.');
  }
  const result = await deps.rpc(
    'bulk_approve_enrollments',
    { p_project_id: parsed.data.project_id, p_enrollment_ids: parsed.data.enrollment_ids },
    authorization,
  );
  if (!result.ok) return rpcFailure(result, requestId);
  const results = BulkApproveResultSchema.array().safeParse(result.data);
  if (!results.success) return apiError(503, 'INTERNAL_ERROR', requestId, 'Unexpected response.');
  return json(200, { schema_version: 1, request_id: requestId, results: results.data });
}
