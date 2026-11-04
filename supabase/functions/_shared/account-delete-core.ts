import {
  ACCOUNT_DELETE_REAUTH_SECONDS,
  AccountDeleteRequestSchema,
} from '../../../packages/shared/src/api/account.ts';
import type { ApiErrorCode } from '../../../packages/shared/src/api/common.ts';
import { apiError, json, newRequestId, readJsonBody } from './http.ts';

/**
 * `account-delete` (docs/spec/11, spec 09; Milestone 12). The person must have signed in within
 * the last 15 minutes (the newest `amr` time of a token Auth has verified), and with their
 * authenticator when they have one (checked in SQL from the token's `aal`). The database records
 * the request and revokes everything at once; then every session is signed out. Identity removal
 * follows in the hourly maintenance (≤ 30 days, normally a day).
 */
export class DeleteAuthError extends Error {}

export class DeleteRpcError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
  ) {
    super(`RPC_FAILED:${status}:${code ?? ''}`);
  }
}

export interface VerifiedSession {
  userId: string;
  aal: 'aal1' | 'aal2';
  /** Unix seconds of the newest authentication in this session, or null when unknown. */
  authenticatedAt: number | null;
}

export interface DeletionRow {
  status: 'REQUESTED' | 'PROCESSED';
  process_after: string;
  duplicate: boolean;
}

export interface AccountDeleteDeps {
  now(): number;
  requestId?: string;
  /** Verifies the access token with Auth and returns who it belongs to. */
  verify(token: string): Promise<VerifiedSession>;
  request(userId: string, aal: 'aal1' | 'aal2'): Promise<DeletionRow>;
  signOutEverywhere(token: string): Promise<void>;
  log?(entry: Record<string, unknown>): void;
}

/** The payload of a JWT (only after Auth verified its signature), or null when malformed. */
export function decodeJwtClaims(token: string): Record<string, unknown> | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const base64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const text = new TextDecoder().decode(Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)));
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function sessionFromClaims(
  userId: string,
  claims: Record<string, unknown>,
): VerifiedSession {
  const amr = Array.isArray(claims.amr) ? (claims.amr as unknown[]) : [];
  const times = amr.flatMap((entry) => {
    const timestamp = (entry as { timestamp?: unknown } | null)?.timestamp;
    return typeof timestamp === 'number' && Number.isFinite(timestamp) ? [timestamp] : [];
  });
  return {
    userId,
    aal: claims.aal === 'aal2' ? 'aal2' : 'aal1',
    authenticatedAt: times.length > 0 ? Math.max(...times) : null,
  };
}

const STATUS: Record<string, [number, ApiErrorCode]> = {
  FORBIDDEN: [403, 'FORBIDDEN'],
  MFA_REQUIRED: [401, 'MFA_REQUIRED'],
  ORG_OWNER_TRANSFER_REQUIRED: [409, 'ORG_OWNER_TRANSFER_REQUIRED'],
  RATE_LIMITED: [429, 'RATE_LIMITED'],
};

export async function handleAccountDelete(
  req: Request,
  deps: AccountDeleteDeps,
): Promise<Response> {
  const requestId = deps.requestId ?? newRequestId();
  const log = (entry: Record<string, unknown>) => deps.log?.({ request_id: requestId, ...entry });
  if (req.method !== 'POST') {
    return apiError(405, 'METHOD_NOT_ALLOWED', requestId, 'Use POST.');
  }
  const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '');
  const token = bearer?.[1];
  if (!token) {
    return apiError(401, 'UNAUTHENTICATED', requestId, 'Sign in first.');
  }
  const read = await readJsonBody(req, requestId);
  if (!read.ok) return read.response;
  if (!AccountDeleteRequestSchema.safeParse(read.body).success) {
    return apiError(422, 'CONFIRMATION_REQUIRED', requestId, 'CONFIRMATION_REQUIRED');
  }
  let session: VerifiedSession;
  try {
    session = await deps.verify(token);
  } catch {
    log({ outcome: 'refused', status: 401 });
    return apiError(401, 'UNAUTHENTICATED', requestId, 'Sign in again.');
  }
  const age =
    session.authenticatedAt === null
      ? Number.POSITIVE_INFINITY
      : deps.now() / 1000 - session.authenticatedAt;
  if (!(age <= ACCOUNT_DELETE_REAUTH_SECONDS)) {
    log({ outcome: 'refused', status: 401, code: 'REAUTHENTICATION_REQUIRED' });
    return apiError(401, 'REAUTHENTICATION_REQUIRED', requestId, 'Sign in again to confirm.');
  }
  let row: DeletionRow;
  try {
    row = await deps.request(session.userId, session.aal);
  } catch (error) {
    if (error instanceof DeleteRpcError && error.code && STATUS[error.code]) {
      const [status, code] = STATUS[error.code] as [number, ApiErrorCode];
      log({ outcome: 'refused', status, code });
      return apiError(status, code, requestId, code);
    }
    log({
      outcome: 'fail',
      error: error instanceof Error ? error.message.slice(0, 120) : 'unknown',
    });
    return apiError(503, 'TEMPORARILY_UNAVAILABLE', requestId, 'Nothing was changed. Try again.');
  }
  try {
    await deps.signOutEverywhere(token);
  } catch (error) {
    // The database already refuses this person everywhere; sessions also end at token expiry.
    log({
      outcome: 'sign_out_failed',
      error: error instanceof Error ? error.message.slice(0, 120) : 'unknown',
    });
  }
  log({ outcome: 'ok', duplicate: row.duplicate });
  return json(200, {
    schema_version: 1,
    request_id: requestId,
    status: row.status,
    process_after: row.process_after,
    duplicate: row.duplicate,
  });
}
