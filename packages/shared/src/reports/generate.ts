import { configAt } from '../attendance/config.ts';
import { projectConfigsFromJson } from '../attendance/store-codec.ts';
import {
  formatLocalDate,
  iso,
  localDateOf,
  localDayRange,
  ms,
  parseLocalDate,
} from '../attendance/time.ts';
import type { AttendanceConfig, SessionRecord } from '../attendance/types.ts';
import { TRACKING_DEFAULTS } from '../config/tracking-defaults.ts';
import {
  buildCompanyDayReports,
  type CompanyDayReport,
  emptyCompanyDayReport,
  reportDueAt,
} from './daily-report.ts';

/**
 * Generating and reissuing daily company reports (Milestone 10). One path for the `daily-reports`
 * Edge Function and both replay backends: the store is the service-side storage (`edge_*` RPCs or
 * memory); the rules are the shared, pure report functions. Nothing here trusts a client.
 */
export interface StoredReportInput {
  company_id: string;
  due_at: string;
  summary: CompanyDayReport;
}

export interface ReportStore {
  /** `edge_report_inputs`: project, configurations, the day's sessions and existing versions. */
  inputs(projectId: string, localDate: string): Promise<Record<string, unknown> | null>;
  /**
   * `edge_store_reports`: version 1 per company, once. Returns how many were stored. `now` is the
   * server clock (a late report is stored NOT_CONFIRMED).
   */
  store(
    projectId: string,
    localDate: string,
    reports: StoredReportInput[],
    now: string,
  ): Promise<number>;
  /** `edge_reissue_report`: the next version; the previous one becomes SUPERSEDED. */
  reissue(input: {
    projectId: string;
    companyId: string;
    localDate: string;
    summary: CompanyDayReport;
    dueAt: string;
    reason: string;
    actorId: string;
    now: string;
  }): Promise<{ reportId: string; version: number }>;
}

export interface DecodedReportInputs {
  timeZone: string;
  projectName: string;
  configs: AttendanceConfig[];
  sessions: SessionRecord[];
  correctedSessionIds: Set<string>;
  existing: { companyId: string; version: number; status: string }[];
}

export function decodeReportInputs(json: Record<string, unknown>): DecodedReportInputs {
  const { project, configs } = projectConfigsFromJson(json);
  const strings = (value: unknown) =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  return {
    timeZone: project.timezone,
    projectName: typeof json.project_name === 'string' ? json.project_name : '',
    configs,
    sessions: ((json.sessions as Record<string, unknown>[] | undefined) ?? []).map(
      (row) => ({ ...row }) as unknown as SessionRecord,
    ),
    correctedSessionIds: new Set(strings(json.corrected_session_ids)),
    existing: ((json.existing as Record<string, unknown>[] | undefined) ?? []).map((row) => ({
      companyId: String(row.company_id),
      version: Number(row.version),
      status: String(row.status),
    })),
  };
}

function buildReports(
  inputs: DecodedReportInputs,
  localDate: string,
  now: string,
): CompanyDayReport[] {
  const byId = new Map(inputs.configs.map((config) => [config.configVersionId, config]));
  return buildCompanyDayReports({
    localDate,
    timeZone: inputs.timeZone,
    now,
    sessions: inputs.sessions,
    correctedSessionIds: inputs.correctedSessionIds,
    presenceUnknownSeconds: (id) =>
      byId.get(id)?.presenceUnknownSeconds ?? TRACKING_DEFAULTS.presence_unknown_seconds,
  });
}

/** 12:00 on the next project workday after `localDate`, by the configuration in force at `at`. */
function dueAfter(inputs: DecodedReportInputs, localDate: string, at: number): string {
  const config = configAt(inputs.configs, iso(at));
  return reportDueAt(localDate, config ?? { operates24x7: false, windows: [] }, inputs.timeZone);
}

export type GenerateOutcome =
  { status: 'NOT_FOUND' } | { status: 'DAY_OPEN' } | { status: 'DONE'; stored: number };

/**
 * Stores version 1 for every company that worked on an ended project-local day and has no report
 * yet. Safe to run again or concurrently: the database keeps the first version.
 */
export async function generateDayReports(
  store: ReportStore,
  projectId: string,
  localDate: string,
  now: string,
): Promise<GenerateOutcome> {
  const raw = await store.inputs(projectId, localDate);
  if (!raw) return { status: 'NOT_FOUND' };
  const inputs = decodeReportInputs(raw);
  const day = localDayRange(parseLocalDate(localDate), inputs.timeZone);
  if (ms(now) < day[1]) return { status: 'DAY_OPEN' };
  const have = new Set(inputs.existing.map((row) => row.companyId));
  const missing = buildReports(inputs, localDate, now).filter(
    (report) => !have.has(report.company_id),
  );
  if (missing.length === 0) return { status: 'DONE', stored: 0 };
  const dueAt = dueAfter(inputs, localDate, day[1] - 1);
  const stored = await store.store(
    projectId,
    localDate,
    missing.map((summary) => ({ company_id: summary.company_id, due_at: dueAt, summary })),
    now,
  );
  return { status: 'DONE', stored };
}

export type ReissueOutcome =
  | { status: 'NOT_FOUND' }
  | { status: 'DAY_OPEN' }
  | { status: 'NO_REPORT' }
  | { status: 'DONE'; reportId: string; version: number };

/**
 * A new version of one company's report from the current sessions (after approved corrections).
 * The foreman gets a fresh answer window: 12:00 on the next project workday after the reissue
 * (decision #110); the earlier version and its answers stay as they were.
 */
export async function reissueDayReport(
  store: ReportStore,
  input: {
    projectId: string;
    companyId: string;
    localDate: string;
    reason: string;
    actorId: string;
    now: string;
  },
): Promise<ReissueOutcome> {
  const raw = await store.inputs(input.projectId, input.localDate);
  if (!raw) return { status: 'NOT_FOUND' };
  const inputs = decodeReportInputs(raw);
  const day = localDayRange(parseLocalDate(input.localDate), inputs.timeZone);
  if (ms(input.now) < day[1]) return { status: 'DAY_OPEN' };
  if (!inputs.existing.some((row) => row.companyId === input.companyId)) {
    return { status: 'NO_REPORT' };
  }
  const summary =
    buildReports(inputs, input.localDate, input.now).find(
      (report) => report.company_id === input.companyId,
    ) ?? emptyCompanyDayReport(input.companyId, input.localDate, inputs.timeZone);
  const today = formatLocalDate(localDateOf(ms(input.now), inputs.timeZone));
  const result = await store.reissue({
    projectId: input.projectId,
    companyId: input.companyId,
    localDate: input.localDate,
    summary,
    dueAt: dueAfter(inputs, today, ms(input.now)),
    reason: input.reason,
    actorId: input.actorId,
    now: input.now,
  });
  return { status: 'DONE', ...result };
}

/** `edge_*` RPC implementation of the store (Edge Functions and the database replay). */
export function rpcReportStore(
  rpc: (fn: string, args: Record<string, unknown>) => Promise<unknown>,
): ReportStore {
  return {
    inputs: async (projectId, localDate) =>
      ((await rpc('edge_report_inputs', { p_project: projectId, p_local_date: localDate })) ??
        null) as Record<string, unknown> | null,
    store: async (projectId, localDate, reports, now) =>
      Number(
        await rpc('edge_store_reports', {
          p_project: projectId,
          p_local_date: localDate,
          p_reports: reports,
          p_now: now,
        }),
      ),
    reissue: async (input) => {
      const row = (await rpc('edge_reissue_report', {
        p_project: input.projectId,
        p_company: input.companyId,
        p_local_date: input.localDate,
        p_summary: input.summary,
        p_due_at: input.dueAt,
        p_reason: input.reason,
        p_actor: input.actorId,
        p_now: input.now,
      })) as { report_id: string; version: number };
      return { reportId: row.report_id, version: Number(row.version) };
    },
  };
}
