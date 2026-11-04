import type { ApiErrorCode } from '../../../packages/shared/src/api/common.ts';
import {
  MUSTER_ANDROID_CHANNEL,
  MUSTER_NOTIFICATION_CATEGORY,
  MusterCloseRequestSchema,
  type MusterCounts,
  type MusterPushSummary,
  MusterStartRequestSchema,
  musterNotificationText,
} from '../../../packages/shared/src/api/muster.ts';
import { isLocale, type Locale } from '../../../packages/shared/src/locale.ts';
import type { PushProvider } from '../../../packages/shared/src/providers/types.ts';
import { apiError, json, newRequestId, readJsonBody } from './http.ts';

/**
 * `muster-start` and `muster-close` (docs/spec/11, docs/spec/12; Milestone 11). The database
 * decides who may act (`start_muster` / `close_muster` called with the caller's OWN JWT: the
 * designated safety role with MFA) and freezes the snapshot in one transaction. The service role
 * only reads push targets and records delivery. Push never blocks or changes a muster: the in-app
 * roster, kiosk and foreman checks work without it (spec 07 "Push provider fails").
 */
export class MusterAuthError extends Error {}

export class MusterRpcError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
  ) {
    super(`RPC_FAILED:${status}:${code ?? ''}`);
  }
}

export interface StartRow {
  muster_id: string;
  created: boolean;
  duplicate: boolean;
  already_active: boolean;
}

export interface CloseRow {
  muster_id: string;
  duplicate: boolean;
  digest: string;
  counts: MusterCounts;
}

export interface PushTarget {
  memberId: string;
  token: string;
  locale: Locale;
}

export interface MusterDeps {
  now(): number;
  requestId?: string;
  start(input: {
    projectId: string;
    label: string;
    idempotencyKey: string;
    separate: boolean;
  }): Promise<StartRow>;
  close(input: { musterId: string; note: string; acknowledge: boolean }): Promise<CloseRow>;
  pushTargets(musterId: string): Promise<PushTarget[]>;
  recordPush(
    musterId: string,
    results: { member_id: string; status: 'ok' | 'error'; error: string | null }[],
  ): Promise<void>;
  push: PushProvider;
  log?(entry: Record<string, unknown>): void;
}

export function pushTargetsFromJson(value: unknown): PushTarget[] {
  return ((value as Record<string, unknown>[] | null) ?? []).flatMap((row) =>
    typeof row.member_id === 'string' && typeof row.token === 'string'
      ? [
          {
            memberId: row.member_id,
            token: row.token,
            locale: isLocale(row.locale) ? row.locale : 'en-US',
          },
        ]
      : [],
  );
}

const STATUS: Record<string, [number, ApiErrorCode]> = {
  FORBIDDEN: [403, 'FORBIDDEN'],
  LABEL_REQUIRED: [422, 'LABEL_REQUIRED'],
  IDEMPOTENCY_KEY_REQUIRED: [422, 'IDEMPOTENCY_KEY_REQUIRED'],
  REASON_REQUIRED: [422, 'REASON_REQUIRED'],
  REASON_TOO_LONG: [422, 'REASON_TOO_LONG'],
  ACKNOWLEDGE_INCOMPLETE_REQUIRED: [422, 'ACKNOWLEDGE_INCOMPLETE_REQUIRED'],
  PROJECT_NOT_ACTIVE: [409, 'PROJECT_NOT_ACTIVE'],
};

function failure(
  error: unknown,
  requestId: string,
  log: (entry: Record<string, unknown>) => void,
): Response {
  if (error instanceof MusterAuthError) {
    log({ outcome: 'refused', status: 401 });
    return apiError(401, 'UNAUTHENTICATED', requestId, 'Sign in again.');
  }
  if (error instanceof MusterRpcError) {
    const known =
      (error.code && STATUS[error.code]) || (error.status === 403 ? STATUS.FORBIDDEN : null);
    if (known) {
      log({ outcome: 'refused', status: known[0], code: known[1] });
      return apiError(known[0], known[1], requestId, known[1]);
    }
  }
  log({ outcome: 'fail', error: error instanceof Error ? error.message.slice(0, 120) : 'unknown' });
  return apiError(503, 'TEMPORARILY_UNAVAILABLE', requestId, 'Nothing was changed. Try again.');
}

function firstIssue(issues: { message: string }[]): ApiErrorCode {
  const known = issues.map((issue) => issue.message).find((message) => message in STATUS);
  return (known as ApiErrorCode | undefined) ?? 'INVALID_REQUEST';
}

/** Sends the alert once, records each member's outcome, and never throws. */
async function notify(
  deps: MusterDeps,
  musterId: string,
  log: (entry: Record<string, unknown>) => void,
): Promise<MusterPushSummary> {
  const provider = deps.push.kind === 'fake' ? 'development-fake' : 'expo';
  let targets: PushTarget[] = [];
  try {
    targets = await deps.pushTargets(musterId);
    const tickets =
      targets.length === 0
        ? []
        : await deps.push.send(
            targets.map((target) => ({
              to: target.token,
              ...musterNotificationText(target.locale),
              data: { type: 'MUSTER', muster_id: musterId, member_id: target.memberId },
              categoryId: MUSTER_NOTIFICATION_CATEGORY,
              channelId: MUSTER_ANDROID_CHANNEL,
              priority: 'high' as const,
              sound: 'default' as const,
            })),
          );
    const results = targets.map((target, index) => ({
      member_id: target.memberId,
      status: tickets[index]?.status === 'ok' ? ('ok' as const) : ('error' as const),
      error: tickets[index]?.status === 'ok' ? null : (tickets[index]?.error ?? 'NO_TICKET'),
    }));
    await deps.recordPush(musterId, results);
    const sent = results.filter((r) => r.status === 'ok').length;
    return { provider, targets: targets.length, sent, failed: targets.length - sent };
  } catch (error) {
    // The muster is already committed: a push outage only shows as "failed" on the board.
    log({
      outcome: 'push_failed',
      error: error instanceof Error ? error.message.slice(0, 120) : 'unknown',
    });
    return { provider, targets: targets.length, sent: 0, failed: targets.length };
  }
}

export async function handleMusterStart(req: Request, deps: MusterDeps): Promise<Response> {
  const requestId = deps.requestId ?? newRequestId();
  const log = (entry: Record<string, unknown>) => deps.log?.({ request_id: requestId, ...entry });
  if (!/^Bearer\s+\S+$/i.test(req.headers.get('authorization') ?? '')) {
    return apiError(401, 'UNAUTHENTICATED', requestId, 'Sign in first.');
  }
  const read = await readJsonBody(req, requestId);
  if (!read.ok) return read.response;
  const parsed = MusterStartRequestSchema.safeParse(read.body);
  if (!parsed.success) {
    const code = firstIssue(parsed.error.issues);
    return apiError(422, code, requestId, code);
  }
  try {
    const row = await deps.start({
      projectId: parsed.data.project_id,
      label: parsed.data.incident_label,
      idempotencyKey: parsed.data.idempotency_key,
      separate: parsed.data.separate ?? false,
    });
    const push = row.created ? await notify(deps, row.muster_id, log) : null;
    log({ outcome: 'ok', action: 'start', created: row.created, push_targets: push?.targets ?? 0 });
    return json(200, {
      schema_version: 1,
      request_id: requestId,
      muster_id: row.muster_id,
      created: row.created,
      duplicate: row.duplicate,
      already_active: row.already_active,
      push,
    });
  } catch (error) {
    return failure(error, requestId, log);
  }
}

export async function handleMusterClose(req: Request, deps: MusterDeps): Promise<Response> {
  const requestId = deps.requestId ?? newRequestId();
  const log = (entry: Record<string, unknown>) => deps.log?.({ request_id: requestId, ...entry });
  if (!/^Bearer\s+\S+$/i.test(req.headers.get('authorization') ?? '')) {
    return apiError(401, 'UNAUTHENTICATED', requestId, 'Sign in first.');
  }
  const read = await readJsonBody(req, requestId);
  if (!read.ok) return read.response;
  const parsed = MusterCloseRequestSchema.safeParse(read.body);
  if (!parsed.success) {
    const code = firstIssue(parsed.error.issues);
    return apiError(422, code, requestId, code);
  }
  try {
    const row = await deps.close({
      musterId: parsed.data.muster_id,
      note: parsed.data.closure_note,
      acknowledge: parsed.data.acknowledge_incomplete,
    });
    log({ outcome: 'ok', action: 'close', duplicate: row.duplicate });
    return json(200, {
      schema_version: 1,
      request_id: requestId,
      muster_id: row.muster_id,
      duplicate: row.duplicate,
      digest: row.digest,
      counts: row.counts,
    });
  } catch (error) {
    return failure(error, requestId, log);
  }
}
