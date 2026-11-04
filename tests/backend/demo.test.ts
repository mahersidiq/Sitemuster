import { describe, expect, it } from 'vitest';

import { DemoSimulateResponseSchema } from '@sitemuster/shared';

import type { ProjectDashboard } from '../../src/api/types';
import { withDb } from './support/db';
import { enroll, fn, jwtOf, scalar, site, userIdOf } from './support/operations';
import { staffClient } from './support/staff';

/**
 * Milestone 13 reviewer demo over the real `demo-simulate` Edge Function (local stack): the
 * reviewer account (MFA) moves synthetic people in the allowlisted demo through the production
 * ingest pipeline, the dashboard and map follow, and nobody can reach a real project with it.
 */
async function simulate(jwt: string, body: Record<string, unknown>) {
  const response = await fetch(fn('demo-simulate'), {
    method: 'POST',
    headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
    body: JSON.stringify({ schema_version: 1, idempotency_key: crypto.randomUUID(), ...body }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function seedDemo() {
  const reviewer = await staffClient();
  const reviewerId = await userIdOf(reviewer.client);
  const ownerId = crypto.randomUUID();
  const seeded = await withDb(async (db) => {
    // One active demo at a time: end any demo an earlier run left behind.
    await db.query(
      'update app_private.demo_organizations set retired_at = now() where retired_at is null',
    );
    await db.query(
      `insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
       values ('00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated', $2, now(), '{}', '{}', now(), now())`,
      [ownerId, `demo-owner-${ownerId.slice(0, 8)}@example.test`],
    );
    const row = await db.query<{ seed: Record<string, unknown> }>(
      'select app_private.seed_reviewer_demo($1, $2) as seed',
      [ownerId, reviewerId],
    );
    return row.rows[0]?.seed ?? {};
  });
  return {
    reviewer,
    projectId: String(seeded.project_id),
    synthetic: (seeded.synthetic_worker_ids as string[]) ?? [],
    reviewerWorkerId: String(seeded.reviewer_worker_id),
  };
}

async function dashboard(client: Awaited<ReturnType<typeof staffClient>>['client'], id: string) {
  const { data, error } = await client.rpc('project_dashboard', { p_project_id: id });
  expect(error).toBeNull();
  return data as ProjectDashboard;
}

/** Everything of a project that an outsider's call must never change. */
const fingerprint = (projectId: string) =>
  scalar<string>(
    `select md5(coalesce(string_agg(x, '|' order by x), '')) as v from (
       select 'a ' || t::text from public.attendance_events t where project_id = $1
       union all select 's ' || t::text from public.attendance_sessions t where project_id = $1
       union all select 'p ' || t::text from public.presence_states t where project_id = $1
       union all select 'l ' || t::text from public.latest_onsite_positions t where project_id = $1
     ) s(x)`,
    [projectId],
  );

describe('reviewer demo simulation (local stack)', () => {
  it('moves a synthetic person through the production pipeline; dashboard and map follow', async () => {
    const { reviewer, projectId, synthetic } = await seedDemo();
    const jwt = await jwtOf(reviewer.client);
    const person = synthetic[0] as string;

    expect((await reviewer.client.rpc('my_demo_projects')).data).toEqual([
      expect.objectContaining({ project_id: projectId, active: true }),
    ]);
    const before = await dashboard(reviewer.client, projectId);
    expect(before.counts.estimated_onsite).toBe(0);

    const arrive = await simulate(jwt, {
      project_id: projectId,
      worker_id: person,
      action: 'ARRIVE',
    });
    expect(arrive.status, JSON.stringify(arrive.body)).toBe(200);
    const parsed = DemoSimulateResponseSchema.parse(arrive.body);
    expect(parsed.simulated).toBe(true);
    expect(parsed.results.map((result) => result.status)).toEqual([
      'accepted',
      'accepted',
      'accepted',
    ]);

    const onsite = await dashboard(reviewer.client, projectId);
    expect(onsite.counts.estimated_onsite).toBe(1);
    expect(onsite.counts.onsite_by_source).toEqual({ GEOFENCE: 1 });
    const map = await reviewer.client.rpc('project_map', { p_project_id: projectId });
    expect(map.error).toBeNull();
    const markers = (map.data as { markers: { lat: number; lng: number; fresh: boolean }[] })
      .markers;
    expect(markers).toHaveLength(1);
    // Inside the synthetic Austin site, never near a real customer's site.
    expect(Math.abs((markers[0]?.lat ?? 0) - 30.2672)).toBeLessThan(0.001);
    expect(Math.abs((markers[0]?.lng ?? 0) + 97.7431)).toBeLessThan(0.001);

    const workers = await reviewer.client.rpc('demo_workers', { p_project_id: projectId });
    expect(workers.error).toBeNull();
    expect(
      (workers.data as { worker_id: string; presence: string | null }[]).find(
        (row) => row.worker_id === person,
      )?.presence,
    ).toBe('ONSITE_ESTIMATED');

    const leave = await simulate(jwt, {
      project_id: projectId,
      worker_id: person,
      action: 'LEAVE',
    });
    expect(leave.status, JSON.stringify(leave.body)).toBe(200);
    const after = await dashboard(reviewer.client, projectId);
    expect(after.counts.estimated_onsite).toBe(0);
    expect(
      await scalar<string>(
        `select status::text as v from public.attendance_sessions where project_id = $1 and worker_id = $2`,
        [projectId, person],
      ),
    ).toBe('CLOSED');

    // A new arrival right after the departure waits for the production 10-minute rule.
    const tooSoon = await simulate(jwt, {
      project_id: projectId,
      worker_id: person,
      action: 'ARRIVE',
    });
    expect(tooSoon.status).toBe(409);
    expect((tooSoon.body.error as { code: string }).code).toBe('DEMO_WAIT');
  });

  it('cannot reach a real project, a real person or another tenant', async () => {
    const { reviewer, projectId, synthetic, reviewerWorkerId } = await seedDemo();
    const jwt = await jwtOf(reviewer.client);
    const real = await site();
    const realWorker = await enroll(real.projectId, {
      companyId: real.companyId,
      name: 'Real Person',
    });
    const before = await fingerprint(real.projectId);

    const realProject = await simulate(jwt, {
      project_id: real.projectId,
      worker_id: realWorker,
      action: 'ARRIVE',
    });
    expect(realProject.status).toBe(403);
    expect((realProject.body.error as { code: string }).code).toBe('DEMO_NOT_ALLOWED');
    const realPersonInDemo = await simulate(jwt, {
      project_id: projectId,
      worker_id: reviewerWorkerId,
      action: 'ARRIVE',
    });
    expect(realPersonInDemo.status).toBe(403);
    expect((realPersonInDemo.body.error as { code: string }).code).toBe('NOT_A_DEMO_WORKER');
    const mixed = await simulate(jwt, {
      project_id: real.projectId,
      worker_id: synthetic[1],
      action: 'ARRIVE',
    });
    expect(mixed.status).toBe(403);

    // A real GC's superintendent (MFA) cannot use the demo, nor their own project.
    const otherGc = await staffClient();
    await withDb(async (db) =>
      db.query(
        "insert into public.project_staff (project_id, user_id, role, emergency_designated) values ($1, $2, 'SUPER', false)",
        [real.projectId, await userIdOf(otherGc.client)],
      ),
    );
    const otherJwt = await jwtOf(otherGc.client);
    const intoDemo = await simulate(otherJwt, {
      project_id: projectId,
      worker_id: synthetic[1],
      action: 'ARRIVE',
    });
    expect(intoDemo.status).toBe(403);
    const ownProject = await simulate(otherJwt, {
      project_id: real.projectId,
      worker_id: realWorker,
      action: 'ARRIVE',
    });
    expect(ownProject.status).toBe(403);
    expect((ownProject.body.error as { code: string }).code).toBe('DEMO_NOT_ALLOWED');

    expect(await fingerprint(real.projectId)).toBe(before);
    expect(
      await scalar<number>(
        "select count(*)::int as v from app_private.audit_logs where action = 'demo.simulated_arrive' and project_id = $1",
        [real.projectId],
      ),
    ).toBe(0);
  });
});
