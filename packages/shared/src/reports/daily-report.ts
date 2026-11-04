import { sessionIntervals } from '../attendance/counts.ts';
import {
  addDays,
  formatLocalDate,
  iso,
  isoWeekday,
  type LocalDate,
  localDateOf,
  localDayRange,
  ms,
  parseLocalDate,
  SECOND,
  zonedToUtc,
} from '../attendance/time.ts';
import type { AttendanceConfig, SessionRecord } from '../attendance/types.ts';
import type { AttendanceSource, SessionStatus } from '../enums.ts';

/**
 * Daily company reports and personal hours (docs/spec/04 "Report and confirmation lifecycle",
 * "Aggregations"; Milestone 10). Pure functions: no clock, no I/O. Every number is an ESTIMATE of
 * onsite presence, never payroll or a guaranteed headcount. Time is split by the project-local
 * calendar day, so an overnight shift counts on both days and DST days are 23 or 25 hours long.
 */
export const REPORT_SCHEMA_VERSION = 1 as const;
export const ESTIMATE_NOTICE = 'ESTIMATED_ONSITE_NOT_PAYROLL' as const;

type Interval = [number, number];

export interface ReportSessionLine {
  session_id: string;
  start_at: string;
  end_at: string | null;
  /** Latest possible end when the leaving time is uncertain (never an invented exit). */
  end_latest_at: string | null;
  start_source: AttendanceSource;
  end_source: AttendanceSource | null;
  status: SessionStatus;
  witnessed: boolean;
  /** Countable time inside this local day. */
  definite_seconds: number;
  /** Unresolved ends and evidence gaps inside this day (shown, never counted). */
  uncertain_seconds: number;
  /** Outside the shift and not yet approved (shown, never counted). */
  pending_approval_seconds: number;
  needs_review: boolean;
  corrected: boolean;
}

export interface ReportWorkerLine {
  worker_id: string;
  sessions: ReportSessionLine[];
  definite_seconds: number;
  uncertain_seconds: number;
  pending_approval_seconds: number;
  needs_review: boolean;
}

export interface CompanyDayReport {
  schema_version: typeof REPORT_SCHEMA_VERSION;
  company_id: string;
  local_date: string;
  time_zone: string;
  /** UTC bounds of the local day: 23, 24 or 25 hours. */
  day_start_at: string;
  day_end_at: string;
  workers: ReportWorkerLine[];
  totals: {
    workers: number;
    definite_seconds: number;
    uncertain_seconds: number;
    pending_approval_seconds: number;
    sessions_needing_review: number;
    peak_estimated_count: number;
  };
  notice: typeof ESTIMATE_NOTICE;
}

export interface ReportInputs {
  localDate: string;
  timeZone: string;
  /** When the report is generated (open sessions count up to here). */
  now: string;
  sessions: readonly SessionRecord[];
  /** Sessions with an approved correction (shown as corrected; the original stays in the audit). */
  correctedSessionIds?: ReadonlySet<string>;
  /** presence_unknown_seconds per configuration version (the session's own version applies). */
  presenceUnknownSeconds: (configVersionId: string) => number;
}

const REVIEW_STATUSES = new Set<SessionStatus>([
  'UNRESOLVED',
  'ENDED_UNVERIFIED',
  'PENDING_APPROVAL',
]);

function clip([a, b]: Interval, [from, to]: Interval): Interval | null {
  const start = Math.max(a, from);
  const end = Math.min(b, to);
  return end > start ? [start, end] : null;
}

const seconds = (intervals: Interval[], day: Interval) =>
  intervals.reduce((sum, interval) => {
    const part = clip(interval, day);
    return part ? sum + (part[1] - part[0]) / SECOND : sum;
  }, 0);

function sessionSpan(session: SessionRecord, now: number): Interval {
  const end = session.endAt
    ? ms(session.endAt)
    : session.endLatestAt
      ? ms(session.endLatestAt)
      : now;
  return [ms(session.startAt), Math.max(ms(session.startAt), end)];
}

/** The part of one session that falls inside a local day, or null when it does not touch it. */
function sessionLine(
  session: SessionRecord,
  day: Interval,
  now: number,
  inputs: Pick<ReportInputs, 'correctedSessionIds' | 'presenceUnknownSeconds'>,
): { line: ReportSessionLine; definite: Interval[] } | null {
  if (session.status === 'VOID') return null;
  const span = sessionSpan(session, now);
  const touches =
    clip(span, day) !== null || (span[0] === span[1] && span[0] >= day[0] && span[0] < day[1]);
  if (!touches) return null;
  const intervals = sessionIntervals(
    session,
    now,
    inputs.presenceUnknownSeconds(session.configVersionId),
  );
  const uncertain = Math.round(seconds(intervals.uncertain, day));
  const pending = Math.round(seconds(intervals.pendingApproval, day));
  const definite = intervals.definite.flatMap((interval) => {
    const part = clip(interval, day);
    return part ? [part] : [];
  });
  return {
    definite,
    line: {
      session_id: session.id,
      start_at: session.startAt,
      end_at: session.endAt,
      end_latest_at: session.endAt ? null : session.endLatestAt,
      start_source: session.startSource,
      end_source: session.endSource,
      status: session.status,
      witnessed: session.witnessed,
      definite_seconds: Math.round(seconds(definite, day)),
      uncertain_seconds: uncertain,
      pending_approval_seconds: pending,
      needs_review:
        REVIEW_STATUSES.has(session.status) ||
        session.reviewReasons.length > 0 ||
        uncertain > 0 ||
        pending > 0,
      corrected: inputs.correctedSessionIds?.has(session.id) ?? false,
    },
  };
}

function peakOf(definite: Interval[]): number {
  const edges = definite.flatMap(([a, b]): [number, number][] => [
    [a, 1],
    [b, -1],
  ]);
  edges.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let current = 0;
  let peak = 0;
  for (const [, delta] of edges) {
    current += delta;
    peak = Math.max(peak, current);
  }
  return peak;
}

/**
 * One report per company that had any session touching the local day (by the employer recorded
 * when each session started). Sessions without a company are not part of any company report.
 */
export function buildCompanyDayReports(inputs: ReportInputs): CompanyDayReport[] {
  const date = parseLocalDate(inputs.localDate);
  const day = localDayRange(date, inputs.timeZone);
  const now = ms(inputs.now);
  const byCompany = new Map<
    string,
    Map<string, { lines: ReportSessionLine[]; definite: Interval[] }>
  >();
  for (const session of inputs.sessions) {
    if (!session.employerSnapshotId) continue;
    const result = sessionLine(session, day, now, inputs);
    if (!result) continue;
    const workers = byCompany.get(session.employerSnapshotId) ?? new Map();
    byCompany.set(session.employerSnapshotId, workers);
    const worker = workers.get(session.workerId) ?? { lines: [], definite: [] };
    workers.set(session.workerId, worker);
    worker.lines.push(result.line);
    worker.definite.push(...result.definite);
  }
  return [...byCompany.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([companyId, workers]) => {
      const lines: ReportWorkerLine[] = [...workers.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([workerId, worker]) => {
          const sessions = worker.lines.sort((a, b) => ms(a.start_at) - ms(b.start_at));
          return {
            worker_id: workerId,
            sessions,
            definite_seconds: sessions.reduce((sum, s) => sum + s.definite_seconds, 0),
            uncertain_seconds: sessions.reduce((sum, s) => sum + s.uncertain_seconds, 0),
            pending_approval_seconds: sessions.reduce(
              (sum, s) => sum + s.pending_approval_seconds,
              0,
            ),
            needs_review: sessions.some((s) => s.needs_review),
          };
        });
      const definite = [...workers.values()].flatMap((worker) => worker.definite);
      return {
        schema_version: REPORT_SCHEMA_VERSION,
        company_id: companyId,
        local_date: inputs.localDate,
        time_zone: inputs.timeZone,
        day_start_at: iso(day[0]),
        day_end_at: iso(day[1]),
        workers: lines,
        totals: {
          workers: lines.length,
          definite_seconds: lines.reduce((sum, w) => sum + w.definite_seconds, 0),
          uncertain_seconds: lines.reduce((sum, w) => sum + w.uncertain_seconds, 0),
          pending_approval_seconds: lines.reduce((sum, w) => sum + w.pending_approval_seconds, 0),
          sessions_needing_review: lines.reduce(
            (sum, w) => sum + w.sessions.filter((s) => s.needs_review).length,
            0,
          ),
          peak_estimated_count: peakOf(definite),
        },
        notice: ESTIMATE_NOTICE,
      };
    });
}

/** A company report with no countable time (every session of the day was voided or moved). */
export function emptyCompanyDayReport(
  companyId: string,
  localDate: string,
  timeZone: string,
): CompanyDayReport {
  const day = localDayRange(parseLocalDate(localDate), timeZone);
  return {
    schema_version: REPORT_SCHEMA_VERSION,
    company_id: companyId,
    local_date: localDate,
    time_zone: timeZone,
    day_start_at: iso(day[0]),
    day_end_at: iso(day[1]),
    workers: [],
    totals: {
      workers: 0,
      definite_seconds: 0,
      uncertain_seconds: 0,
      pending_approval_seconds: 0,
      sessions_needing_review: 0,
      peak_estimated_count: 0,
    },
    notice: ESTIMATE_NOTICE,
  };
}

const NOON = 12 * 60;

/**
 * 12:00 project-local time on the next project workday after the report's day (docs/spec/04,
 * spec 06 `foreman_confirm_deadline_local`): the next date whose weekday has a work window in the
 * configuration; 24/7 sites (or a configuration without windows) use the next calendar day.
 */
export function reportDueAt(
  localDate: string,
  config: Pick<AttendanceConfig, 'operates24x7' | 'windows'>,
  timeZone: string,
): string {
  const date = parseLocalDate(localDate);
  const workdays = new Set(config.windows.map((window) => window.weekday));
  let due: LocalDate = addDays(date, 1);
  if (!config.operates24x7 && workdays.size > 0) {
    for (let offset = 1; offset <= 7; offset += 1) {
      const candidate = addDays(date, offset);
      if (workdays.has(isoWeekday(candidate))) {
        due = candidate;
        break;
      }
    }
  }
  return iso(zonedToUtc(due, NOON, timeZone));
}

/** The local dates a session touches (an overnight shift touches two). */
export function localDatesOf(
  session: Pick<SessionRecord, 'startAt' | 'endAt' | 'endLatestAt' | 'status'>,
  timeZone: string,
  now: string,
): string[] {
  if (session.status === 'VOID') return [];
  const span = sessionSpan(session as SessionRecord, ms(now));
  const out: string[] = [];
  let date = localDateOf(span[0], timeZone);
  for (let guard = 0; guard < 400; guard += 1) {
    const range = localDayRange(date, timeZone);
    if (range[0] > span[1] || (range[0] === span[1] && span[1] > span[0])) break;
    out.push(formatLocalDate(date));
    date = addDays(date, 1);
  }
  return out;
}

export interface WorkerDayHours {
  local_date: string;
  sessions: ReportSessionLine[];
  definite_seconds: number;
  uncertain_seconds: number;
  pending_approval_seconds: number;
  needs_review: boolean;
}

/**
 * A worker's own estimated onsite time per project-local day (the Time History screen and the
 * personal CSV). The caller passes only that worker's own sessions.
 */
export function workerHoursByDay(
  sessions: readonly SessionRecord[],
  fromDate: string,
  days: number,
  timeZone: string,
  now: string,
  presenceUnknownSeconds: (configVersionId: string) => number,
): WorkerDayHours[] {
  const start = parseLocalDate(fromDate);
  const out: WorkerDayHours[] = [];
  for (let offset = 0; offset < days; offset += 1) {
    const date = addDays(start, offset);
    const day = localDayRange(date, timeZone);
    const lines = sessions
      .flatMap((session) => {
        const result = sessionLine(session, day, ms(now), { presenceUnknownSeconds });
        return result ? [result.line] : [];
      })
      .sort((a, b) => ms(a.start_at) - ms(b.start_at));
    out.push({
      local_date: formatLocalDate(date),
      sessions: lines,
      definite_seconds: lines.reduce((sum, s) => sum + s.definite_seconds, 0),
      uncertain_seconds: lines.reduce((sum, s) => sum + s.uncertain_seconds, 0),
      pending_approval_seconds: lines.reduce((sum, s) => sum + s.pending_approval_seconds, 0),
      needs_review: lines.some((s) => s.needs_review),
    });
  }
  return out;
}

/** Monday of the ISO week containing a local date (weekly totals start on Monday). */
export function isoWeekStart(localDate: string): string {
  const date = parseLocalDate(localDate);
  return formatLocalDate(addDays(date, 1 - isoWeekday(date)));
}
