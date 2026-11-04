import type {
  CompanyDayReport,
  ReportAction,
  ReportStore,
  StoredReportInput,
} from '@sitemuster/shared';

/**
 * In-memory daily report storage with the same rules as the database functions of Milestone 10
 * (`edge_store_reports`, `edge_reissue_report`, `edge_confirm_report`, the deadline sweep). Used by
 * the reports core unit tests and the in-memory replay backend; the database replay runs the real
 * functions, so any divergence fails the `backend` project.
 */
export type MemoryReportStatus =
  | 'PENDING_CONFIRMATION'
  | 'CONFIRMED'
  | 'DISPUTED'
  | 'CORRECTION_REQUESTED'
  | 'NOT_CONFIRMED'
  | 'SUPERSEDED';

export interface MemoryReport {
  id: string;
  projectId: string;
  companyId: string;
  localDate: string;
  version: number;
  status: MemoryReportStatus;
  dueAt: string;
  summary: CompanyDayReport;
  supersedesId: string | null;
}

export interface MemoryAnswer {
  reportId: string;
  version: number;
  action: ReportAction;
  comment: string | null;
  eventUuid: string;
  actorId: string;
}

export interface MemoryCorrectionRequest {
  eventUuid: string;
  reportId: string;
  workerId: string;
  sessionId: string | null;
}

export type MemoryConfirmResult =
  | { ok: true; reportId: string; version: number; status: MemoryReportStatus; duplicate: boolean }
  | { ok: false; code: string; status: MemoryReportStatus };

export class MemoryReports {
  readonly reports: MemoryReport[] = [];
  readonly answers: MemoryAnswer[] = [];
  readonly corrections: MemoryCorrectionRequest[] = [];
  private seq = 0;

  constructor(
    private readonly inputsOf: (
      projectId: string,
      localDate: string,
    ) => Promise<Record<string, unknown> | null>,
  ) {}

  private nextId(): string {
    this.seq += 1;
    return `7e000000-0000-4000-8000-${this.seq.toString(16).padStart(12, '0')}`;
  }

  private initialStatus(dueAt: string, now: string): MemoryReportStatus {
    return Date.parse(dueAt) <= Date.parse(now) ? 'NOT_CONFIRMED' : 'PENDING_CONFIRMATION';
  }

  latest(projectId: string, companyId: string, localDate: string): MemoryReport | undefined {
    return this.reports
      .filter(
        (r) => r.projectId === projectId && r.companyId === companyId && r.localDate === localDate,
      )
      .sort((a, b) => b.version - a.version)[0];
  }

  private existing(projectId: string, localDate: string) {
    const companies = new Set(
      this.reports
        .filter((r) => r.projectId === projectId && r.localDate === localDate)
        .map((r) => r.companyId),
    );
    return [...companies].map((companyId) => {
      const latest = this.latest(projectId, companyId, localDate) as MemoryReport;
      return { company_id: companyId, version: latest.version, status: latest.status };
    });
  }

  readonly store: ReportStore = {
    inputs: async (projectId, localDate) => {
      const raw = await this.inputsOf(projectId, localDate);
      return raw ? { ...raw, existing: this.existing(projectId, localDate) } : null;
    },
    store: async (projectId, localDate, rows: StoredReportInput[], now: string) => {
      let stored = 0;
      for (const row of rows) {
        if (row.summary.company_id !== row.company_id || row.summary.local_date !== localDate) {
          throw new Error('REPORT_SUMMARY_MISMATCH');
        }
        if (
          this.reports.some(
            (r) =>
              r.projectId === projectId &&
              r.companyId === row.company_id &&
              r.localDate === localDate &&
              r.version === 1,
          )
        ) {
          continue;
        }
        this.reports.push({
          id: this.nextId(),
          projectId,
          companyId: row.company_id,
          localDate,
          version: 1,
          status: this.initialStatus(row.due_at, now),
          dueAt: row.due_at,
          summary: row.summary,
          supersedesId: null,
        });
        stored += 1;
      }
      return stored;
    },
    reissue: async (input) => {
      if (input.reason.trim().length < 3) throw new Error('REASON_REQUIRED');
      const previous = this.latest(input.projectId, input.companyId, input.localDate);
      if (previous) previous.status = 'SUPERSEDED';
      const report: MemoryReport = {
        id: this.nextId(),
        projectId: input.projectId,
        companyId: input.companyId,
        localDate: input.localDate,
        version: (previous?.version ?? 0) + 1,
        status: this.initialStatus(input.dueAt, input.now),
        dueAt: input.dueAt,
        summary: input.summary,
        supersedesId: previous?.id ?? null,
      };
      this.reports.push(report);
      return { reportId: report.id, version: report.version };
    },
  };

  /** Mirrors `edge_confirm_report` (the caller already checked the foreman's company). */
  confirm(input: {
    reportId: string;
    version: number;
    action: ReportAction;
    comment: string | null;
    proposed: { worker_id: string; session_id: string | null }[];
    eventUuid: string;
    actorId: string;
    now: string;
  }): MemoryConfirmResult {
    const seen = this.answers.find((a) => a.eventUuid === input.eventUuid);
    const report = this.reports.find((r) => r.id === input.reportId);
    if (!report) throw new Error('FORBIDDEN');
    if (seen) {
      if (seen.reportId !== input.reportId || seen.actorId !== input.actorId)
        throw new Error('EVENT_ID_CONFLICT');
      return {
        ok: true,
        reportId: report.id,
        version: seen.version,
        status: report.status,
        duplicate: true,
      };
    }
    if (report.version !== input.version || report.status === 'SUPERSEDED') {
      return { ok: false, code: 'REPORT_VERSION_STALE', status: report.status };
    }
    if (
      report.status === 'PENDING_CONFIRMATION' &&
      Date.parse(report.dueAt) <= Date.parse(input.now)
    ) {
      report.status = 'NOT_CONFIRMED';
      return { ok: false, code: 'REPORT_DEADLINE_PASSED', status: 'NOT_CONFIRMED' };
    }
    if (report.status !== 'PENDING_CONFIRMATION') {
      return { ok: false, code: 'REPORT_ALREADY_ANSWERED', status: report.status };
    }
    if (input.action !== 'CONFIRM' && (input.comment ?? '').trim().length < 3)
      throw new Error('REASON_REQUIRED');
    if (input.action === 'SUBMIT_CORRECTION') {
      if (input.proposed.length === 0) throw new Error('PROPOSAL_REQUIRED');
      for (const item of input.proposed) {
        const worker = report.summary.workers.find((w) => w.worker_id === item.worker_id);
        if (!worker) throw new Error('WORKER_NOT_IN_REPORT');
        if (item.session_id && !worker.sessions.some((s) => s.session_id === item.session_id)) {
          throw new Error('SESSION_NOT_IN_REPORT');
        }
        this.corrections.push({
          eventUuid: input.eventUuid,
          reportId: report.id,
          workerId: item.worker_id,
          sessionId: item.session_id,
        });
      }
    }
    this.answers.push({
      reportId: report.id,
      version: report.version,
      action: input.action,
      comment: input.comment?.trim() || null,
      eventUuid: input.eventUuid,
      actorId: input.actorId,
    });
    report.status =
      input.action === 'CONFIRM'
        ? 'CONFIRMED'
        : input.action === 'DISPUTE'
          ? 'DISPUTED'
          : 'CORRECTION_REQUESTED';
    return {
      ok: true,
      reportId: report.id,
      version: report.version,
      status: report.status,
      duplicate: false,
    };
  }

  /** Mirrors `app_private.report_deadline_sweep`. */
  sweep(now: number): number {
    let changed = 0;
    for (const report of this.reports) {
      if (report.status === 'PENDING_CONFIRMATION' && Date.parse(report.dueAt) <= now) {
        report.status = 'NOT_CONFIRMED';
        changed += 1;
      }
    }
    return changed;
  }
}
