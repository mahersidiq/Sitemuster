import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import {
  addDays,
  DailyReportsResponseSchema,
  formatLocalDate,
  localDateOf,
  ReportConfirmResponseSchema,
  type ReportView,
  zonedToUtc,
} from '@sitemuster/shared';

import { withDb } from './support/db';
import { backendEnv } from './support/env';
import {
  assignStaff,
  crewBatch,
  crewSite,
  fn,
  jwtOf,
  post,
  results,
  scalar,
  site,
  workerSession,
  enroll,
} from './support/operations';
import { staffClient } from './support/staff';

/**
 * Milestone 10 acceptance on the real local stack: the `daily-reports` function generates one
 * version per company for yesterday (project time zone), the company foreman disputes it and the
 * issued version stays exactly as it was, staff reissue a new version, a foreman correction is
 * approved through the manual-correction operation (atomically), a worker's request is rejected
 * with a reason, other companies and GC B are refused, and a late answer is NOT_CONFIRMED.
 */
const TZ = 'America/Chicago';
const yesterday = () => addDays(localDateOf(Date.now(), TZ), -1);
const at = (minutesOfDay: number) => new Date(zonedToUtc(yesterday(), minutesOfDay, TZ));

async function callFn(name: string, jwt: string, body: unknown) {
  const response = await fetch(fn(name), {
    method: 'POST',
    headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const listReports = (jwt: string, projectId: string, localDate: string) =>
  callFn('daily-reports', jwt, {
    schema_version: 1,
    action: 'list',
    project_id: projectId,
    local_date: localDate,
  });

/** Yesterday 08:00–15:00 for the crew (project-local), signed in by the foreman. */
async function workedYesterday(size: number) {
  const world = await crewSite(size);
  const entry = crewBatch(world.projectId, world.companyId, world.crew, 'ENTRY', 0, at(8 * 60));
  const exit = crewBatch(world.projectId, world.companyId, world.crew, 'EXIT', 0, at(15 * 60));
  const posted = results((await post(world.foreman.jwt, [entry, exit])).body);
  expect(posted.map((r) => r.status)).toEqual(['accepted', 'accepted']);
  const superintendent = await staffClient();
  await assignStaff(superintendent.client, world.projectId, 'SUPER');
  return { ...world, superintendent, staffJwt: await jwtOf(superintendent.client) };
}

/** A PostgREST RPC with a worker's JWT (phone sign-in). */
async function rpcAs(jwt: string, name: string, args: Record<string, unknown>) {
  const env = backendEnv();
  const response = await fetch(`${env.apiUrl}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${jwt}`,
      apikey: env.anonKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  return { status: response.status, body: (await response.json()) as unknown };
}

async function rpc(client: SupabaseClient, name: string, args: Record<string, unknown>) {
  const { data, error } = await client.rpc(name, args);
  return { data, error };
}

describe('daily company reports and foreman answers (local stack)', () => {
  it('generates yesterday once per company, the foreman disputes, staff reissue, a correction is approved', async () => {
    const w = await workedYesterday(2);
    const date = formatLocalDate(yesterday());

    const listed = await listReports(w.staffJwt, w.projectId, date);
    expect(listed.status).toBe(200);
    const first = DailyReportsResponseSchema.parse(listed.body);
    expect(first.day_open).toBe(false);
    expect(first.reports).toHaveLength(1);
    const report = first.reports[0] as ReportView;
    expect(report).toMatchObject({
      company_name: 'Crew Concrete',
      version: 1,
      status: 'PENDING_CONFIRMATION',
      can_answer: false,
    });
    expect(report.summary.totals).toMatchObject({
      workers: 2,
      definite_seconds: 2 * 7 * 3600,
      peak_estimated_count: 2,
    });
    expect(Object.values(report.worker_names).sort()).toEqual(['Crew Member 1', 'Crew Member 2']);
    expect(JSON.stringify(first)).not.toMatch(/phone|"lat|"lng|emergency/);
    // A 24/7 site: due 12:00 the next calendar day (project time).
    expect(Date.parse(report.due_at)).toBe(zonedToUtc(addDays(yesterday(), 1), 12 * 60, TZ));
    // Opening the list again stores nothing new.
    await listReports(w.staffJwt, w.projectId, date);
    expect(
      await scalar<number>(
        'select count(*)::int as v from public.daily_company_reports where project_id = $1',
        [w.projectId],
      ),
    ).toBe(1);

    // The foreman's pending list holds the report and lets them answer.
    const pending = DailyReportsResponseSchema.parse(
      (await callFn('daily-reports', w.foreman.jwt, { schema_version: 1, action: 'pending' })).body,
    );
    expect(pending.reports.map((r) => [r.report_id, r.can_answer])).toEqual([
      [report.report_id, true],
    ]);

    // Dispute: the version keeps its issued content.
    const before = await scalar<string>(
      'select summary::text as v from public.daily_company_reports where id = $1',
      [report.report_id],
    );
    const disputed = await callFn('report-confirm', w.foreman.jwt, {
      schema_version: 1,
      report_id: report.report_id,
      version: 1,
      action: 'DISPUTE',
      reason: 'Crew Member 2 left at noon',
      proposed: [],
      event_uuid: crypto.randomUUID(),
    });
    expect(disputed.status).toBe(200);
    expect(ReportConfirmResponseSchema.parse(disputed.body)).toMatchObject({
      status: 'DISPUTED',
      duplicate: false,
    });
    expect(
      await scalar<string>(
        'select summary::text as v from public.daily_company_reports where id = $1',
        [report.report_id],
      ),
    ).toBe(before);

    // Staff reissue → version 2; version 1 is SUPERSEDED and its answer stays in the history.
    const reissued = await callFn('daily-reports', w.staffJwt, {
      schema_version: 1,
      action: 'reissue',
      project_id: w.projectId,
      company_id: w.companyId,
      local_date: date,
      reason: 'Reissued after the foreman dispute',
    });
    expect(reissued.status).toBe(200);
    const v2 = DailyReportsResponseSchema.parse(reissued.body).reports[0] as ReportView;
    expect(v2).toMatchObject({ version: 2, status: 'PENDING_CONFIRMATION' });
    expect(v2.earlier_versions).toEqual([{ version: 1, status: 'SUPERSEDED' }]);
    expect(v2.answers.map((a) => [a.version, a.action])).toEqual([[1, 'DISPUTE']]);

    // The foreman submits a correction on version 2 for Crew Member 2's session.
    const target = v2.summary.workers.find((x) => v2.worker_names[x.worker_id] === 'Crew Member 2');
    const session = target?.sessions[0];
    const corrected = await callFn('report-confirm', w.foreman.jwt, {
      schema_version: 1,
      report_id: v2.report_id,
      version: 2,
      action: 'SUBMIT_CORRECTION',
      reason: 'Left at noon',
      proposed: [
        {
          worker_id: target?.worker_id,
          session_id: session?.session_id,
          proposed_start_at: null,
          proposed_end_at: at(12 * 60)
            .toISOString()
            .replace('.000Z', 'Z'),
          note: 'left at noon',
        },
      ],
      event_uuid: crypto.randomUUID(),
    });
    expect(corrected.status).toBe(200);
    expect(corrected.body.status).toBe('CORRECTION_REQUESTED');

    // The superintendent sees the request and approves it with a manual correction naming it.
    const { data: requests } = await rpc(w.superintendent.client, 'correction_requests', {
      p_project_id: w.projectId,
    });
    const request = (requests as { request_id: string; channel: string; status: string }[]).find(
      (r) => r.channel === 'FOREMAN_REQUEST',
    );
    expect(request?.status).toBe('PENDING');
    const approve = {
      event_uuid: crypto.randomUUID(),
      project_id: w.projectId,
      operation_type: 'MANUAL_ATTENDANCE_CORRECTION',
      observed_at: new Date().toISOString(),
      payload: {
        worker_id: target?.worker_id,
        session_id: session?.session_id,
        corrected_end_at: at(12 * 60).toISOString(),
        reason: 'Approved the foreman correction',
        request_id: request?.request_id,
      },
    };
    expect(results((await post(w.staffJwt, [approve])).body)[0]?.status).toBe('accepted');
    expect(
      await scalar<string>(
        'select status::text as v from public.attendance_corrections where id = $1',
        [request?.request_id],
      ),
    ).toBe('APPROVED');
    // Approving the same request again is refused (it is no longer pending).
    const again = { ...approve, event_uuid: crypto.randomUUID() };
    expect(results((await post(w.staffJwt, [again])).body)[0]).toMatchObject({
      status: 'rejected',
      reason: 'REQUEST_ALREADY_DECIDED',
    });

    // A new version after the approved correction shows the shorter day and the corrected flag.
    const v3 = DailyReportsResponseSchema.parse(
      (
        await callFn('daily-reports', w.staffJwt, {
          schema_version: 1,
          action: 'reissue',
          project_id: w.projectId,
          company_id: w.companyId,
          local_date: date,
          reason: 'Applied the approved correction',
        })
      ).body,
    ).reports[0] as ReportView;
    expect(v3.version).toBe(3);
    expect(v3.summary.totals.definite_seconds).toBe(7 * 3600 + 4 * 3600);
    expect(v3.summary.workers.flatMap((x) => x.sessions).filter((s) => s.corrected)).toHaveLength(
      1,
    );
  });

  it("another company's foreman and GC B are refused; a late answer is NOT_CONFIRMED", async () => {
    const w = await workedYesterday(1);
    const date = formatLocalDate(yesterday());
    const report = DailyReportsResponseSchema.parse(
      (await listReports(w.staffJwt, w.projectId, date)).body,
    ).reports[0] as ReportView;

    const other = await site();
    const outsider = await workerSession();
    const outsiderProfile = await enroll(other.projectId, {
      userId: outsider.userId,
      companyId: other.companyId,
      name: 'Other Foreman',
    });
    await withDb((db) =>
      db.query(
        "update public.subcontractor_members set role = 'FOREMAN' where worker_profile_id = $1",
        [outsiderProfile],
      ),
    );
    const foreign = await callFn('report-confirm', outsider.jwt, {
      schema_version: 1,
      report_id: report.report_id,
      version: 1,
      action: 'CONFIRM',
      reason: null,
      proposed: [],
      event_uuid: crypto.randomUUID(),
    });
    expect(foreign.status).toBe(403);
    expect((await listReports(outsider.jwt, w.projectId, date)).status).toBe(403);

    const gcB = await staffClient();
    await assignStaff(gcB.client, other.projectId, 'SUPER');
    expect((await listReports(await jwtOf(gcB.client), w.projectId, date)).status).toBe(403);
    expect(
      await scalar<number>(
        'select count(*)::int as v from public.report_confirmations where report_id = $1',
        [report.report_id],
      ),
    ).toBe(0);

    // Past the deadline: the answer is refused and the report is stored NOT_CONFIRMED.
    await withDb(async (db) => {
      await db.query(
        `insert into public.daily_company_reports (project_id, subcontractor_id, local_date, report_version, summary, due_at)
         values ($1, $2, (now() at time zone 'America/Chicago')::date - 5, 1, '{"workers": []}', now() - interval '1 minute')`,
        [w.projectId, w.companyId],
      );
    });
    const lateId = await scalar<string>(
      "select id::text as v from public.daily_company_reports where project_id = $1 and due_at < now() and status = 'PENDING_CONFIRMATION'",
      [w.projectId],
    );
    const late = await callFn('report-confirm', w.foreman.jwt, {
      schema_version: 1,
      report_id: lateId,
      version: 1,
      action: 'CONFIRM',
      reason: null,
      proposed: [],
      event_uuid: crypto.randomUUID(),
    });
    expect([late.status, (late.body.error as { code: string }).code]).toEqual([
      409,
      'REPORT_DEADLINE_PASSED',
    ]);
    expect(
      await scalar<string>(
        'select status::text as v from public.daily_company_reports where id = $1',
        [lateId],
      ),
    ).toBe('NOT_CONFIRMED');
  });

  it('a worker sees only their own hours and requests a correction; staff reject it with a reason', async () => {
    const { projectId, companyId } = await site();
    const worker = await workerSession();
    const workerId = await enroll(projectId, {
      userId: worker.userId,
      companyId,
      name: 'Wanda Worker',
    });
    const neighbour = await enroll(projectId, { companyId, name: 'Neil Neighbour' });
    await withDb(async (db) => {
      for (const id of [workerId, neighbour]) {
        await db.query(
          `insert into public.attendance_sessions (project_id, worker_id, employer_snapshot_id, start_at, end_at, start_source, end_source,
                                                   config_version_id, status, iana_timezone, last_seen_at, witnessed, opened_by_event)
           select $1, $2, $3, $4, $5, 'MANUAL', 'MANUAL', p.config_version_id, 'CLOSED', 'America/Chicago', $5, true, gen_random_uuid()
             from public.projects p where p.id = $1`,
          [projectId, id, companyId, at(7 * 60).toISOString(), at(15 * 60).toISOString()],
        );
      }
    });
    const range = {
      p_project_id: projectId,
      p_from: new Date(Date.now() - 7 * 86_400_000).toISOString(),
      p_to: new Date().toISOString(),
    };
    const mine = await rpcAs(worker.jwt, 'my_attendance', range);
    expect(mine.status).toBe(200);
    const body = mine.body as {
      sessions: { workerId: string; id: string }[];
      project: { time_zone: string };
    };
    expect(body.sessions.map((s) => s.workerId)).toEqual([workerId]);
    expect(body.project.time_zone).toBe(TZ);
    expect(JSON.stringify(body)).not.toMatch(/Neil|Neighbour|"lat|"lng/);

    const asked = await rpcAs(worker.jwt, 'request_attendance_correction', {
      p_project_id: projectId,
      p_session_id: body.sessions[0]?.id,
      p_proposed_start_at: null,
      p_proposed_end_at: at(14 * 60).toISOString(),
      p_reason: 'I left at 2 pm',
      p_event_uuid: crypto.randomUUID(),
    });
    expect(asked.status).toBe(200);
    const requestId = (asked.body as { request_id: string }).request_id;
    // Someone else's session cannot be the target.
    const neighbourSession = await scalar<string>(
      'select id::text as v from public.attendance_sessions where worker_id = $1',
      [neighbour],
    );
    const foreign = await rpcAs(worker.jwt, 'request_attendance_correction', {
      p_project_id: projectId,
      p_session_id: neighbourSession,
      p_proposed_start_at: null,
      p_proposed_end_at: at(14 * 60).toISOString(),
      p_reason: 'Not mine',
      p_event_uuid: crypto.randomUUID(),
    });
    expect(foreign.status).toBe(400);

    const superintendent = await staffClient();
    await assignStaff(superintendent.client, projectId, 'SUPER');
    const rejected = await rpc(superintendent.client, 'reject_correction_request', {
      p_request_id: requestId,
      p_reason: 'Gate log shows 3 pm',
    });
    expect(rejected.error).toBeNull();
    const after = await rpcAs(worker.jwt, 'my_attendance', range);
    expect(
      (after.body as { requests: { status: string; decision_reason: string }[] }).requests,
    ).toEqual([
      expect.objectContaining({ status: 'REJECTED', decision_reason: 'Gate log shows 3 pm' }),
    ]);
  });
});
