import { describe, expect, it } from 'vitest';

import type { SessionRecord } from '../../../packages/shared/src/attendance/types.ts';
import { MemoryReports } from '../../../tests/support/report-memory.ts';
import {
  type DailyReportsDeps,
  handleDailyReports,
  handleReportConfirm,
  type ReportConfirmDeps,
  type ReportContext,
  ReportsRpcError,
} from './reports-core.ts';

const PROJECT = '0a000000-0000-4000-8000-0000000000a1';
const ACME = '0c000000-0000-4000-8000-0000000000a1';
const BOLT = '0c000000-0000-4000-8000-0000000000b1';
const FOREMAN = 'f0000000-0000-4000-8000-0000000000a1';
const SUPER = '50000000-0000-4000-8000-0000000000a1';
const CONFIG = 'c0000000-0000-4000-8000-000000000001';
const TZ = 'America/Chicago';

let n = 0;
function session(overrides: Partial<SessionRecord>): SessionRecord {
  n += 1;
  return {
    id: `5e000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    projectId: PROJECT,
    workerId: 'b0000000-0000-4000-8000-000000000001',
    status: 'CLOSED',
    startAt: '2026-11-06T13:00:00Z',
    startSource: 'FOREMAN',
    startConfidence: 'HIGH',
    endAt: '2026-11-06T21:00:00Z',
    endSource: 'FOREMAN',
    endEarliestAt: null,
    endLatestAt: null,
    configVersionId: CONFIG,
    timezone: TZ,
    lastSeenAt: '2026-11-06T21:00:00Z',
    lastConfirmedInsideAt: '2026-11-06T21:00:00Z',
    closeoutAt: '2026-11-07T01:00:00Z',
    authorizeAt: null,
    authorizedCloseoutAt: null,
    windowStartAt: null,
    windowEndAt: null,
    unscheduled: false,
    unscheduledUntil: null,
    overtimeApprovedAt: null,
    overtimeApprovedBy: null,
    witnessed: true,
    gaps: [],
    reviewReasons: [],
    unresolvedAt: null,
    openedByEvent: 'e',
    employerSnapshotId: ACME,
    ...overrides,
  };
}

const MON_SAT = [1, 2, 3, 4, 5, 6].map((weekday) => ({
  weekday,
  local_start_time: '06:00',
  local_end_time: '18:00',
}));

interface World {
  clock: { now: number };
  reports: MemoryReports;
  sessions: SessionRecord[];
  contexts: Map<string, ReportContext | null>;
  actor: string;
  inputsLoaded: number;
  failStore: boolean;
  daily: DailyReportsDeps;
  confirm: ReportConfirmDeps;
}

function world(now = '2026-11-07T08:00:00Z'): World {
  const w = {
    clock: { now: Date.parse(now) },
    sessions: [] as SessionRecord[],
    contexts: new Map<string, ReportContext | null>(),
    actor: SUPER,
    inputsLoaded: 0,
    failStore: false,
  } as World;
  w.reports = new MemoryReports(async (projectId) => {
    w.inputsLoaded += 1;
    if (w.failStore) throw new Error('database unavailable');
    if (projectId !== PROJECT) return null;
    return {
      project: { id: PROJECT, status: 'ACTIVE', timezone: TZ },
      project_name: 'Alpha Tower',
      configs: [
        {
          configVersionId: CONFIG,
          projectId: PROJECT,
          versionNumber: 1,
          effectiveAt: '2026-10-01T00:00:00Z',
          settings: { work_windows: MON_SAT, operates_24_7: false },
          center: { lat: 29.76, lng: -95.37 },
          radiusM: 150,
          exitHysteresisM: 50,
        },
      ],
      sessions: w.sessions,
      corrected_session_ids: [],
    };
  });
  const context = (projectId: string): ReportContext | null => {
    if (w.contexts.has(w.actor)) return w.contexts.get(w.actor) ?? null;
    if (projectId !== PROJECT) return null;
    if (w.actor === SUPER) {
      return { userId: SUPER, projectId, staff: true, canReissue: true, foremanCompanyIds: [] };
    }
    if (w.actor === FOREMAN) {
      return {
        userId: FOREMAN,
        projectId,
        staff: false,
        canReissue: false,
        foremanCompanyIds: [ACME],
      };
    }
    return null;
  };
  const views = (projectId: string, localDate: string) =>
    [
      ...new Set(
        w.reports.reports
          .filter((r) => r.projectId === projectId && r.localDate === localDate)
          .map((r) => r.companyId),
      ),
    ]
      .map((companyId) => w.reports.latest(projectId, companyId, localDate))
      .map((r) => ({
        report_id: r?.id,
        company_id: r?.companyId,
        version: r?.version,
        status: r?.status,
        due_at: r?.dueAt,
      }));
  w.daily = {
    now: () => w.clock.now,
    requestId: '00000000-0000-4000-8000-000000000001',
    context: async (projectId) => context(projectId),
    foremanProjects: async () => (w.actor === FOREMAN ? [PROJECT] : []),
    gaps: async () => ['2026-11-06'],
    list: async (projectId, localDate) => views(projectId, localDate),
    pending: async () =>
      w.reports.reports
        .filter((r) => r.status === 'PENDING_CONFIRMATION' && r.companyId === ACME)
        .map((r) => ({ report_id: r.id, local_date: r.localDate })),
    store: w.reports.store,
  };
  w.confirm = {
    now: () => w.clock.now,
    requestId: '00000000-0000-4000-8000-000000000002',
    context: async (projectId) => context(projectId),
    ref: async (reportId) => {
      const report = w.reports.reports.find((r) => r.id === reportId);
      return report ? { reportId, projectId: report.projectId, companyId: report.companyId } : null;
    },
    confirm: async (input) => {
      try {
        return w.reports.confirm({
          ...input,
          proposed: (input.proposed ?? []) as { worker_id: string; session_id: string | null }[],
        });
      } catch (error) {
        throw new ReportsRpcError(400, (error as Error).message);
      }
    },
  };
  return w;
}

interface Reply {
  day_open?: boolean;
  reports: { company_id: string; status: string; version: number; due_at: string }[];
  error: { code: string };
  report_id?: string;
  version?: number;
  status?: string;
  duplicate?: boolean;
}

async function call(
  handler: (req: Request, deps: never) => Promise<Response>,
  deps: unknown,
  body: unknown,
  token: string | null = 'Bearer user-jwt',
) {
  const response = await handler(
    new Request('https://x.test/functions/v1/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: token } : {}) },
      body: JSON.stringify(body),
    }),
    deps as never,
  );
  return { status: response.status, body: (await response.json()) as Reply };
}

const list = (w: World, localDate = '2026-11-06') =>
  call(handleDailyReports, w.daily, {
    schema_version: 1,
    action: 'list',
    project_id: PROJECT,
    local_date: localDate,
  });

describe('daily-reports', () => {
  it('generates one version-1 report per company once the project-local day has ended, due 12:00 next workday', async () => {
    const w = world();
    w.sessions.push(
      session({}),
      session({ employerSnapshotId: BOLT, workerId: 'b0000000-0000-4000-8000-000000000002' }),
    );
    const first = await list(w);
    expect(first.status).toBe(200);
    expect(first.body.day_open).toBe(false);
    expect(
      first.body.reports.map(
        (r: { company_id: string; status: string; version: number; due_at: string }) => [
          r.company_id,
          r.status,
          r.version,
          r.due_at,
        ],
      ),
    ).toEqual([
      [ACME, 'PENDING_CONFIRMATION', 1, '2026-11-07T18:00:00Z'],
      [BOLT, 'PENDING_CONFIRMATION', 1, '2026-11-07T18:00:00Z'],
    ]);
    // Friday's report is due Saturday noon (Mon–Sat site); opening the list again adds nothing.
    await list(w);
    expect(w.reports.reports).toHaveLength(2);
    expect(w.reports.reports[0]?.summary.notice).toBe('ESTIMATED_ONSITE_NOT_PAYROLL');
  });

  it('nothing is generated for a day that has not ended on the project clock', async () => {
    const w = world('2026-11-06T23:00:00Z'); // 17:00 in Chicago
    w.sessions.push(session({}));
    const result = await list(w);
    expect(result.body.day_open).toBe(true);
    expect(w.reports.reports).toHaveLength(0);
  });

  it('a caller without a report role is refused before any data is read', async () => {
    const w = world();
    w.actor = 'd0000000-0000-4000-8000-000000000001';
    const result = await list(w);
    expect(result.status).toBe(403);
    expect(result.body.error.code).toBe('FORBIDDEN');
    expect(w.inputsLoaded).toBe(0);
  });

  it('a report generated after its deadline is stored NOT_CONFIRMED, never approved', async () => {
    const w = world('2026-11-09T20:00:00Z'); // Monday afternoon, Friday's report was due Saturday
    w.sessions.push(session({}));
    const result = await list(w);
    expect(result.body.reports[0]?.status).toBe('NOT_CONFIRMED');
  });

  it('reissue: staff only, the old version is superseded and the new one gets a fresh answer window', async () => {
    const w = world();
    w.sessions.push(session({}));
    await list(w);
    const reissue = {
      schema_version: 1,
      action: 'reissue',
      project_id: PROJECT,
      company_id: ACME,
      local_date: '2026-11-06',
      reason: 'Approved Ana correction',
    };
    w.actor = FOREMAN;
    expect((await call(handleDailyReports, w.daily, reissue)).status).toBe(403);
    w.actor = SUPER;
    w.clock.now = Date.parse('2026-11-09T20:00:00Z'); // after the first deadline
    const result = await call(handleDailyReports, w.daily, reissue);
    expect(result.status).toBe(200);
    expect(result.body.reports[0]).toMatchObject({
      version: 2,
      status: 'PENDING_CONFIRMATION',
      due_at: '2026-11-10T18:00:00Z',
    });
    expect(w.reports.reports.map((r) => [r.version, r.status])).toEqual([
      [1, 'SUPERSEDED'],
      [2, 'PENDING_CONFIRMATION'],
    ]);
    const open = await call(handleDailyReports, w.daily, { ...reissue, local_date: '2026-11-09' });
    expect(open.status).toBe(409);
    expect(open.body.error.code).toBe('DAY_OPEN');
  });

  it("pending: generates the foreman's missing days, then returns only their open reports", async () => {
    const w = world();
    w.actor = FOREMAN;
    w.sessions.push(
      session({}),
      session({ employerSnapshotId: BOLT, workerId: 'b0000000-0000-4000-8000-000000000002' }),
    );
    const result = await call(handleDailyReports, w.daily, {
      schema_version: 1,
      action: 'pending',
    });
    expect(result.status).toBe(200);
    expect(result.body.reports).toHaveLength(1);
    expect(w.reports.reports).toHaveLength(2);
  });

  it('refuses malformed requests and unauthenticated callers; a storage failure is 503, never success', async () => {
    const w = world();
    expect(
      (await call(handleDailyReports, w.daily, { schema_version: 1, action: 'list' })).status,
    ).toBe(422);
    expect(
      (await call(handleDailyReports, w.daily, { schema_version: 1, action: 'pending' }, null))
        .status,
    ).toBe(401);
    w.failStore = true;
    const failed = await list(w);
    expect(failed.status).toBe(503);
    expect(failed.body.error.code).toBe('TEMPORARILY_UNAVAILABLE');
  });
});

describe('report-confirm', () => {
  async function setup() {
    const w = world();
    w.sessions.push(
      session({}),
      session({ employerSnapshotId: BOLT, workerId: 'b0000000-0000-4000-8000-000000000002' }),
    );
    await list(w);
    w.actor = FOREMAN;
    const acme = w.reports.latest(PROJECT, ACME, '2026-11-06');
    const bolt = w.reports.latest(PROJECT, BOLT, '2026-11-06');
    return { w, acme: acme?.id as string, bolt: bolt?.id as string };
  }
  const answer = (reportId: string, overrides: Record<string, unknown> = {}) => ({
    schema_version: 1,
    report_id: reportId,
    version: 1,
    action: 'DISPUTE',
    reason: 'Ben worked all day',
    proposed: [],
    event_uuid: 'ad000000-0000-4000-8000-000000000001',
    ...overrides,
  });

  it('the company foreman disputes; the version stays exactly as issued; a resend is a duplicate', async () => {
    const { w, acme } = await setup();
    const before = JSON.stringify(w.reports.latest(PROJECT, ACME, '2026-11-06')?.summary);
    const result = await call(handleReportConfirm, w.confirm, answer(acme));
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      report_id: acme,
      version: 1,
      status: 'DISPUTED',
      duplicate: false,
    });
    expect(JSON.stringify(w.reports.latest(PROJECT, ACME, '2026-11-06')?.summary)).toBe(before);
    const again = await call(handleReportConfirm, w.confirm, answer(acme));
    expect(again.body.duplicate).toBe(true);
    const second = await call(
      handleReportConfirm,
      w.confirm,
      answer(acme, {
        action: 'CONFIRM',
        reason: null,
        event_uuid: 'ad000000-0000-4000-8000-000000000002',
      }),
    );
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('REPORT_ALREADY_ANSWERED');
  });

  it("another company's report and an unknown report are refused alike (no existence leak)", async () => {
    const { w, bolt } = await setup();
    const foreign = await call(handleReportConfirm, w.confirm, answer(bolt));
    const unknown = await call(
      handleReportConfirm,
      w.confirm,
      answer('ad000000-0000-4000-8000-0000000000ff'),
    );
    expect([foreign.status, unknown.status]).toEqual([403, 403]);
    expect(w.reports.answers).toHaveLength(0);
  });

  it('a dispute needs a reason, a correction needs a proposal for a worker of the report', async () => {
    const { w, acme } = await setup();
    const noReason = await call(handleReportConfirm, w.confirm, answer(acme, { reason: null }));
    expect([noReason.status, noReason.body.error.code]).toEqual([422, 'REASON_REQUIRED']);
    const noProposal = await call(
      handleReportConfirm,
      w.confirm,
      answer(acme, { action: 'SUBMIT_CORRECTION' }),
    );
    expect([noProposal.status, noProposal.body.error.code]).toEqual([422, 'PROPOSAL_REQUIRED']);
    const stranger = await call(
      handleReportConfirm,
      w.confirm,
      answer(acme, {
        action: 'SUBMIT_CORRECTION',
        proposed: [
          {
            worker_id: 'b0000000-0000-4000-8000-0000000000ee',
            session_id: null,
            proposed_start_at: '2026-11-06T13:00:00Z',
            proposed_end_at: '2026-11-06T20:00:00Z',
            note: null,
          },
        ],
      }),
    );
    expect([stranger.status, stranger.body.error.code]).toEqual([422, 'WORKER_NOT_IN_REPORT']);
    const ok = await call(
      handleReportConfirm,
      w.confirm,
      answer(acme, {
        action: 'SUBMIT_CORRECTION',
        proposed: [
          {
            worker_id: 'b0000000-0000-4000-8000-000000000001',
            session_id: null,
            proposed_start_at: '2026-11-06T13:00:00Z',
            proposed_end_at: '2026-11-06T20:00:00Z',
            note: 'left at 2',
          },
        ],
      }),
    );
    expect(ok.body.status).toBe('CORRECTION_REQUESTED');
    expect(w.reports.corrections).toHaveLength(1);
  });

  it('after the deadline the answer is refused and the report is NOT_CONFIRMED', async () => {
    const { w, acme } = await setup();
    w.clock.now = Date.parse('2026-11-07T18:00:01Z');
    const late = await call(handleReportConfirm, w.confirm, answer(acme));
    expect([late.status, late.body.error.code]).toEqual([409, 'REPORT_DEADLINE_PASSED']);
    expect(w.reports.latest(PROJECT, ACME, '2026-11-06')?.status).toBe('NOT_CONFIRMED');
  });
});
