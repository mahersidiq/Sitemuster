import type { ApiErrorCode } from '../../../packages/shared/src/api/common.ts';
import {
  DailyReportsRequestSchema,
  ReportConfirmRequestSchema,
  type ReportAction,
} from '../../../packages/shared/src/api/reports.ts';
import {
  generateDayReports,
  reissueDayReport,
  type ReportStore,
} from '../../../packages/shared/src/reports/generate.ts';
import { iso } from '../../../packages/shared/src/attendance/time.ts';
import { apiError, json, newRequestId, readJsonBody } from './http.ts';

/**
 * `daily-reports` and `report-confirm` (docs/spec/11 "Other Edge endpoints"; docs/spec/04 "Report
 * and confirmation lifecycle"; Milestone 10). Who may do what comes from database functions called
 * with the caller's OWN JWT (`report_context`, `report_list`, `my_pending_reports`); the service
 * role only runs the `edge_*` storage functions, always with ids that context derived. A report
 * is an estimate of onsite presence: never payroll, contract proof or a back-charge.
 */
export class ReportsAuthError extends Error {}

/** A database refusal carried through to the caller (code from `raise exception 'CODE'`). */
export class ReportsRpcError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
  ) {
    super(`RPC_FAILED:${status}:${code ?? ''}`);
  }
}

export interface ReportContext {
  userId: string;
  projectId: string;
  staff: boolean;
  canReissue: boolean;
  foremanCompanyIds: string[];
}

export function reportContextFromJson(value: unknown): ReportContext | null {
  const row = value as Record<string, unknown> | null;
  if (!row || typeof row.user_id !== 'string' || typeof row.project_id !== 'string') return null;
  return {
    userId: row.user_id,
    projectId: row.project_id,
    staff: row.staff === true,
    canReissue: row.can_reissue === true,
    foremanCompanyIds: Array.isArray(row.foreman_company_ids)
      ? row.foreman_company_ids.filter((id): id is string => typeof id === 'string')
      : [],
  };
}

export interface DailyReportsDeps {
  now(): number;
  requestId?: string;
  /**
   * `consume_report_budget` with the caller's JWT: false once the person used their hourly report
   * budget (spec 09 "rate-limit … report exports"; decision #132). Checked before any generation.
   */
  budget(): Promise<boolean>;
  /** `report_context` with the caller's JWT; null when they have no report role on the project. */
  context(projectId: string): Promise<ReportContext | null>;
  /** Projects where the caller is a verified foreman (`my_foreman_projects`, caller's JWT). */
  foremanProjects(): Promise<string[]>;
  /** `edge_report_gaps`: ended days within the last `days` that lack a company report. */
  gaps(projectId: string, days: number): Promise<string[]>;
  /** `report_list` with the caller's JWT (RLS-equivalent filtering in the database). */
  list(projectId: string, localDate: string): Promise<unknown[]>;
  /** `my_pending_reports` with the caller's JWT. */
  pending(): Promise<unknown[]>;
  store: ReportStore;
  log?(entry: Record<string, unknown>): void;
}

/** How far back the foreman's pending list looks for days still missing a report. */
export const PENDING_LOOKBACK_DAYS = 7;

const MESSAGES: Partial<Record<ApiErrorCode, string>> = {
  FORBIDDEN: 'You cannot see or change these reports.',
  DAY_OPEN: 'This day has not ended yet on the project clock.',
  NOT_FOUND: 'No report for this company and day.',
};

function refusal(status: number, code: ApiErrorCode, requestId: string): Response {
  return apiError(status, code, requestId, MESSAGES[code] ?? code);
}

function failure(
  error: unknown,
  requestId: string,
  log: (entry: Record<string, unknown>) => void,
): Response {
  if (error instanceof ReportsAuthError) {
    log({ outcome: 'refused', status: 401 });
    return apiError(401, 'UNAUTHENTICATED', requestId, 'Sign in again.');
  }
  log({ outcome: 'fail', error: error instanceof Error ? error.message.slice(0, 120) : 'unknown' });
  return apiError(503, 'TEMPORARILY_UNAVAILABLE', requestId, 'Nothing was changed. Try again.');
}

export async function handleDailyReports(req: Request, deps: DailyReportsDeps): Promise<Response> {
  const requestId = deps.requestId ?? newRequestId();
  const log = (entry: Record<string, unknown>) => deps.log?.({ request_id: requestId, ...entry });
  if (!/^Bearer\s+\S+$/i.test(req.headers.get('authorization') ?? '')) {
    return apiError(401, 'UNAUTHENTICATED', requestId, 'Sign in first.');
  }
  const read = await readJsonBody(req, requestId);
  if (!read.ok) return read.response;
  const parsed = DailyReportsRequestSchema.safeParse(read.body);
  if (!parsed.success) {
    return apiError(422, 'INVALID_REQUEST', requestId, 'Request does not match the contract.');
  }
  const request = parsed.data;
  const now = iso(deps.now());
  try {
    if (!(await deps.budget())) {
      log({ outcome: 'refused', status: 429, action: request.action });
      return apiError(
        429,
        'RATE_LIMITED',
        requestId,
        'Too many report requests. Try again later.',
        {
          'retry-after': '600',
        },
      );
    }
    if (request.action === 'pending') {
      // Generate what is missing for the caller's projects, then read their own pending reports.
      for (const projectId of await deps.foremanProjects()) {
        for (const localDate of await deps.gaps(projectId, PENDING_LOOKBACK_DAYS)) {
          await generateDayReports(deps.store, projectId, localDate, now);
        }
      }
      const reports = await deps.pending();
      log({ outcome: 'ok', action: 'pending', reports: reports.length });
      return json(200, { schema_version: 1, request_id: requestId, day_open: false, reports });
    }

    const context = await deps.context(request.project_id);
    if (!context) {
      log({ outcome: 'refused', status: 403, action: request.action });
      return refusal(403, 'FORBIDDEN', requestId);
    }
    if (request.action === 'list') {
      const outcome = await generateDayReports(
        deps.store,
        context.projectId,
        request.local_date,
        now,
      );
      if (outcome.status === 'NOT_FOUND') return refusal(403, 'FORBIDDEN', requestId);
      const reports = await deps.list(context.projectId, request.local_date);
      log({ outcome: 'ok', action: 'list', reports: reports.length });
      return json(200, {
        schema_version: 1,
        request_id: requestId,
        day_open: outcome.status === 'DAY_OPEN',
        reports,
      });
    }
    // reissue: owner, PM or superintendent with MFA (the same people who correct attendance).
    if (!context.canReissue) {
      log({ outcome: 'refused', status: 403, action: 'reissue' });
      return refusal(403, 'FORBIDDEN', requestId);
    }
    const outcome = await reissueDayReport(deps.store, {
      projectId: context.projectId,
      companyId: request.company_id,
      localDate: request.local_date,
      reason: request.reason,
      actorId: context.userId,
      now,
    });
    if (outcome.status === 'NOT_FOUND') return refusal(403, 'FORBIDDEN', requestId);
    if (outcome.status === 'DAY_OPEN') return refusal(409, 'DAY_OPEN', requestId);
    if (outcome.status === 'NO_REPORT') return refusal(404, 'NOT_FOUND', requestId);
    const reports = await deps.list(context.projectId, request.local_date);
    log({ outcome: 'ok', action: 'reissue', version: outcome.version });
    return json(200, { schema_version: 1, request_id: requestId, day_open: false, reports });
  } catch (error) {
    return failure(error, requestId, log);
  }
}

// ---------------------------------------------------------------------------------------------
// report-confirm
// ---------------------------------------------------------------------------------------------

export interface ReportRef {
  reportId: string;
  projectId: string;
  companyId: string;
}

export function reportRefFromJson(value: unknown): ReportRef | null {
  const row = value as Record<string, unknown> | null;
  if (!row || typeof row.report_id !== 'string' || typeof row.project_id !== 'string') return null;
  return { reportId: row.report_id, projectId: row.project_id, companyId: String(row.company_id) };
}

export type ConfirmResult =
  | { ok: true; reportId: string; version: number; status: string; duplicate: boolean }
  | { ok: false; code: string; status: string };

export function confirmResultFromJson(value: unknown): ConfirmResult {
  const row = (value ?? {}) as Record<string, unknown>;
  if (row.ok === true) {
    return {
      ok: true,
      reportId: String(row.report_id),
      version: Number(row.version),
      status: String(row.status),
      duplicate: row.duplicate === true,
    };
  }
  return { ok: false, code: String(row.code), status: String(row.status) };
}

export interface ReportConfirmDeps {
  now(): number;
  requestId?: string;
  context(projectId: string): Promise<ReportContext | null>;
  /** `edge_report_ref` (service role): the report's project and company, or null. */
  ref(reportId: string): Promise<ReportRef | null>;
  /** `edge_confirm_report` (service role); throws ReportsRpcError for database refusals. */
  confirm(input: {
    reportId: string;
    version: number;
    action: ReportAction;
    comment: string | null;
    proposed: unknown[] | null;
    eventUuid: string;
    actorId: string;
    /** Server clock for the deadline check. */
    now: string;
  }): Promise<ConfirmResult>;
  log?(entry: Record<string, unknown>): void;
}

const CONFLICTS = new Set([
  'REPORT_VERSION_STALE',
  'REPORT_ALREADY_ANSWERED',
  'REPORT_DEADLINE_PASSED',
]);
const INVALID = new Set([
  'REASON_REQUIRED',
  'REASON_TOO_LONG',
  'PROPOSAL_REQUIRED',
  'WORKER_NOT_IN_REPORT',
  'SESSION_NOT_IN_REPORT',
]);

export async function handleReportConfirm(
  req: Request,
  deps: ReportConfirmDeps,
): Promise<Response> {
  const requestId = deps.requestId ?? newRequestId();
  const log = (entry: Record<string, unknown>) => deps.log?.({ request_id: requestId, ...entry });
  if (!/^Bearer\s+\S+$/i.test(req.headers.get('authorization') ?? '')) {
    return apiError(401, 'UNAUTHENTICATED', requestId, 'Sign in first.');
  }
  const read = await readJsonBody(req, requestId);
  if (!read.ok) return read.response;
  const parsed = ReportConfirmRequestSchema.safeParse(read.body);
  if (!parsed.success) {
    const code = parsed.error.issues.map((issue) => issue.message).find((m) => INVALID.has(m));
    return code
      ? apiError(422, code as ApiErrorCode, requestId, code)
      : apiError(422, 'INVALID_REQUEST', requestId, 'Request does not match the contract.');
  }
  const request = parsed.data;
  try {
    const ref = await deps.ref(request.report_id);
    // Unknown and foreign reports answer the same way (no existence leak).
    const context = ref ? await deps.context(ref.projectId) : null;
    if (!ref || !context || !context.foremanCompanyIds.includes(ref.companyId)) {
      log({ outcome: 'refused', status: 403 });
      return refusal(403, 'FORBIDDEN', requestId);
    }
    const result = await deps.confirm({
      reportId: ref.reportId,
      version: request.version,
      action: request.action,
      comment: request.reason,
      proposed: request.action === 'SUBMIT_CORRECTION' ? request.proposed : null,
      eventUuid: request.event_uuid,
      actorId: context.userId,
      now: iso(deps.now()),
    });
    if (!result.ok) {
      log({ outcome: 'refused', status: 409, code: result.code });
      const code = CONFLICTS.has(result.code) ? (result.code as ApiErrorCode) : 'INVALID_REQUEST';
      return apiError(409, code, requestId, code);
    }
    log({ outcome: 'ok', action: request.action, duplicate: result.duplicate });
    return json(200, {
      schema_version: 1,
      request_id: requestId,
      report_id: result.reportId,
      version: result.version,
      status: result.status,
      duplicate: result.duplicate,
    });
  } catch (error) {
    if (error instanceof ReportsRpcError && error.code) {
      if (error.code === 'FORBIDDEN') return refusal(403, 'FORBIDDEN', requestId);
      if (error.code === 'EVENT_ID_CONFLICT') {
        return apiError(409, 'EVENT_ID_CONFLICT', requestId, 'This answer id was already used.');
      }
      if (INVALID.has(error.code)) {
        return apiError(422, error.code as ApiErrorCode, requestId, error.code);
      }
    }
    return failure(error, requestId, log);
  }
}
