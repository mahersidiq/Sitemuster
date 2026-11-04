import { describe, expect, it } from 'vitest';

import { DeviceActivateResponseSchema } from '@sitemuster/shared';

import { withDb } from './support/db';
import {
  enroll,
  fn,
  jwtOf,
  post,
  printedWorker,
  results,
  scalar,
  site,
  userIdOf,
  workerSession,
} from './support/operations';
import { staffClient } from './support/staff';

/**
 * Milestone 12 penetration tests over the real Edge Functions (local stack). A GC B staff member
 * with every role on B — owner-level admin, safety lead with the emergency role, superintendent —
 * signed in with MFA, aims each tenant-scoped function at GC A's real ids. Every call must be
 * refused without revealing or changing anything of A. Then: revocation takes effect on the very
 * next request (phone, staff member, kiosk), with no new sign-in needed. The database-wide sweep
 * of every RPC, table and view is pgTAP `031_cross_tenant_pen`.
 */
async function call(name: string, jwt: string, body: unknown) {
  const response = await fetch(fn(name), {
    method: 'POST',
    headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

/** Everything of a project that an outsider's call must never change. */
async function fingerprint(projectId: string): Promise<string> {
  return scalar<string>(
    `select md5(coalesce(string_agg(x, '|' order by x), '')) as v from (
       select 'm ' || t::text from public.muster_events t where project_id = $1
       union all select 'r ' || t::text from public.daily_company_reports t where project_id = $1
       union all select 'e ' || t::text from public.worker_enrollments t where project_id = $1
       union all select 'o ' || t::text from public.orientation_sessions t where project_id = $1
       union all select 'a ' || t::text from public.attendance_events t where project_id = $1
       union all select 's ' || t::text from public.attendance_sessions t where project_id = $1
     ) s(x)`,
    [projectId],
  );
}

async function organizationOf(projectId: string): Promise<string> {
  return scalar<string>('select organization_id::text as v from public.projects where id = $1', [
    projectId,
  ]);
}

describe('GC B against GC A on every tenant-scoped Edge Function (local stack)', () => {
  it('refuses every call, reveals nothing and changes nothing of A', async () => {
    const a = await site();
    const b = await site();
    // Tenant A: a worker, an active muster and a daily report.
    const workerA = await enroll(a.projectId, { companyId: a.companyId, name: 'Alma Alpha' });
    const enrollmentA = await scalar<string>(
      'select id::text as v from public.worker_enrollments where worker_id = $1',
      [workerA],
    );
    const musterA = crypto.randomUUID();
    const reportA = await withDb(async (db) => {
      await db.query(
        `insert into public.muster_events (id, project_id, triggered_by, incident_label, idempotency_key, config_version_id)
         select $1, p.id, o.owner_user_id, 'Alpha drill', gen_random_uuid(), p.config_version_id
           from public.projects p join public.organizations o on o.id = p.organization_id where p.id = $2`,
        [musterA, a.projectId],
      );
      const report = await db.query<{ id: string }>(
        `insert into public.daily_company_reports (project_id, subcontractor_id, local_date, summary, due_at)
         values ($1, $2, '2026-11-02', '{"estimated_onsite_hours": 8}', now() + interval '1 day') returning id`,
        [a.projectId, a.companyId],
      );
      return report.rows[0]?.id ?? '';
    });

    // GC B: one person holding every staff power in B (admin, safety lead, superintendent), MFA.
    const attacker = await staffClient();
    const attackerId = await userIdOf(attacker.client);
    await withDb(async (db) => {
      await db.query(
        "insert into public.organization_members (organization_id, user_id, role) values ($1, $2, 'ADMIN')",
        [await organizationOf(b.projectId), attackerId],
      );
      await db.query(
        `insert into public.project_staff (project_id, user_id, role, emergency_designated) values
           ($1, $2, 'SAFETY', true), ($1, $2, 'SUPER', false), ($1, $2, 'ATTENDANT', false)`,
        [b.projectId, attackerId],
      );
    });
    const jwt = await jwtOf(attacker.client);
    // The attacker's powers are real: the same call on B's own project works.
    expect(
      (await attacker.client.rpc('project_dashboard', { p_project_id: b.projectId })).error,
    ).toBeNull();

    const printed = await printedWorker(a.projectId);
    const before = await fingerprint(a.projectId);
    const attempts = [
      call('muster-start', jwt, {
        schema_version: 1,
        project_id: a.projectId,
        incident_label: 'Fake alarm',
        idempotency_key: crypto.randomUUID(),
      }),
      call('muster-close', jwt, {
        schema_version: 1,
        muster_id: musterA,
        closure_note: 'Everyone is fine',
        acknowledge_incomplete: true,
      }),
      call('daily-reports', jwt, {
        schema_version: 1,
        action: 'list',
        project_id: a.projectId,
        local_date: '2026-11-02',
      }),
      call('daily-reports', jwt, {
        schema_version: 1,
        action: 'reissue',
        project_id: a.projectId,
        company_id: a.companyId,
        local_date: '2026-11-02',
        reason: 'Numbers look wrong',
      }),
      call('report-confirm', jwt, {
        schema_version: 1,
        report_id: reportA,
        version: 1,
        action: 'CONFIRM',
        reason: null,
        proposed: [],
        event_uuid: crypto.randomUUID(),
      }),
      call('orientation-session', jwt, {
        action: 'START',
        project_id: a.projectId,
        idempotency_key: crypto.randomUUID(),
      }),
      call('enrollment-bulk-approve', jwt, {
        project_id: a.projectId,
        enrollment_ids: [enrollmentA],
      }),
    ];
    const answers = await Promise.all(attempts);
    for (const [index, answer] of answers.entries()) {
      expect([403, 404], `attempt ${index}: ${answer.text}`).toContain(answer.status);
      expect(answer.text).not.toContain(workerA);
      expect(answer.text).not.toContain('Alpha drill');
      expect(answer.text).not.toContain('Alma Alpha');
    }
    // A muster id that does not exist is answered exactly like A's real one (no existence leak).
    const unknown = await call('muster-close', jwt, {
      schema_version: 1,
      muster_id: crypto.randomUUID(),
      closure_note: 'Everyone is fine',
      acknowledge_incomplete: true,
    });
    expect(unknown.status).toBe(answers[1]?.status);

    // Kiosk and crew records aimed at A are refused one by one, nothing is written.
    const kiosk = await post(jwt, [
      {
        event_uuid: crypto.randomUUID(),
        project_id: a.projectId,
        operation_type: 'KIOSK_ENTRY',
        observed_at: new Date().toISOString(),
        payload: {
          badge_payload: printed.code,
          badge_kind: 'PRINTED',
          kiosk_device_id: crypto.randomUUID(),
          direction: 'ENTRY',
        },
      },
    ]);
    expect(kiosk.status).toBe(200);
    expect(results(kiosk.body)[0]).toMatchObject({
      status: 'rejected',
      reason: 'PROJECT_NOT_AUTHORIZED',
    });

    expect(await fingerprint(a.projectId)).toBe(before);
    expect(
      await scalar<string>('select status::text as v from public.muster_events where id = $1', [
        musterA,
      ]),
    ).toBe('ACTIVE');
  });
});

describe('revocation takes effect on the next request (local stack)', () => {
  it('a phone revoked by the operator is refused at once, upload and renewal alike', async () => {
    const { projectId, companyId } = await site();
    const worker = await workerSession();
    await enroll(projectId, { userId: worker.userId, companyId, name: 'Revoked Phone' });
    const activated = await fetch(fn('device-activate'), {
      method: 'POST',
      headers: { authorization: `Bearer ${worker.jwt}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        platform: 'IOS',
        installation_hash: crypto.randomUUID().replace(/-/g, '').padEnd(64, 'e'),
        app_version: '0.12.0',
      }),
    });
    expect(activated.status).toBe(200);
    const device = DeviceActivateResponseSchema.parse(await activated.json());
    const upload = () =>
      fetch(fn('ingest-location-batch'), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${device.upload_token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ locations: [] }),
      });
    expect((await upload()).status).not.toBe(401);

    const operator = await staffClient();
    const operatorId = await userIdOf(operator.client);
    await withDb((db) =>
      db.query('insert into app_private.platform_operators (user_id) values ($1)', [operatorId]),
    );
    const revoked = await operator.client.rpc('operator_revoke_device', {
      p_device_id: device.device_id,
      p_reason: 'reported stolen, ticket 7',
    });
    expect(revoked.error).toBeNull();

    expect((await upload()).status).toBe(401);
    const renew = await fetch(fn('device-renew'), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${device.upload_token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ app_version: '0.12.0' }),
    });
    expect(renew.status).toBe(401);
  });

  it('a removed superintendent loses the project on the next call, without signing in again', async () => {
    const { projectId } = await site();
    const admin = await staffClient();
    const superintendent = await staffClient();
    const superId = await userIdOf(superintendent.client);
    const staffId = await withDb(async (db) => {
      await db.query(
        "insert into public.organization_members (organization_id, user_id, role) values ($1, $2, 'ADMIN')",
        [await organizationOf(projectId), await userIdOf(admin.client)],
      );
      const row = await db.query<{ id: string }>(
        "insert into public.project_staff (project_id, user_id, role, emergency_designated) values ($1, $2, 'SUPER', false) returning id",
        [projectId, superId],
      );
      return row.rows[0]?.id ?? '';
    });
    const dashboard = () =>
      superintendent.client.rpc('project_dashboard', { p_project_id: projectId });
    expect((await dashboard()).error).toBeNull();
    const removed = await admin.client.rpc('remove_project_staff', {
      p_staff_id: staffId,
      p_reason: 'left the company',
    });
    expect(removed.error).toBeNull();
    expect((await dashboard()).error?.message).toContain('FORBIDDEN');
  });

  it('a revoked kiosk cannot record the next scan', async () => {
    const { projectId } = await site();
    const attendant = await staffClient();
    await withDb(async (db) =>
      db.query(
        "insert into public.project_staff (project_id, user_id, role, emergency_designated) values ($1, $2, 'ATTENDANT', false)",
        [projectId, await userIdOf(attendant.client)],
      ),
    );
    const registered = await attendant.client.rpc('register_kiosk', {
      p_project_id: projectId,
      p_device_public_id: `kiosk${crypto.randomUUID().replace(/-/g, '')}`,
    });
    expect(registered.error).toBeNull();
    const kioskId = (registered.data as { kiosk_device_id: string }).kiosk_device_id;
    const worker = await printedWorker(projectId);
    const scan = (direction: 'ENTRY' | 'EXIT', minutesAgo: number) => ({
      event_uuid: crypto.randomUUID(),
      project_id: projectId,
      operation_type: direction === 'ENTRY' ? 'KIOSK_ENTRY' : 'KIOSK_EXIT',
      observed_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
      payload: {
        badge_payload: worker.code,
        badge_kind: 'PRINTED',
        kiosk_device_id: kioskId,
        direction,
      },
    });
    const jwt = await jwtOf(attendant.client);
    const first = await post(jwt, [scan('ENTRY', 10)]);
    expect(results(first.body)[0]?.status).toBe('accepted');
    const revoked = await attendant.client.rpc('revoke_kiosk', {
      p_kiosk_device_id: kioskId,
      p_reason: 'tablet stolen from the gate',
    });
    expect(revoked.error).toBeNull();
    const next = await post(jwt, [scan('EXIT', 1)]);
    expect(results(next.body)[0]?.status).toBe('rejected');
  });
});
