import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import {
  buildBadgePayload,
  MusterCloseResponseSchema,
  MusterStartResponseSchema,
} from '@sitemuster/shared';

import { withDb } from './support/db';
import {
  assignStaff,
  crewSite,
  fn,
  jwtOf,
  phoneWorker,
  post,
  results,
  scalar,
  site,
  workerSession,
  enroll,
} from './support/operations';
import { staffClient } from './support/staff';

/**
 * Milestone 11 acceptance on the real local stack (Auth, PostgREST, Postgres, Edge runtime):
 * - the designated safety role starts a muster through `muster-start`;
 * - a worker taps I'M SAFE through `ingest-operations`, the foreman physically checks his crew,
 *   the attended kiosk scans a badge and the visitor desk checks the visitor; the counters stay
 *   separate and a self report never becomes verified;
 * - two simultaneous starts give one muster; non-role, GC B and workers are refused;
 * - push goes to registered phones only and is recorded as metadata;
 * - an offline check syncs once; close needs an acknowledgement and freezes the report; a check
 *   made before the close but synced after it is an amendment, one made after it is refused.
 */
async function callFn(name: string, jwt: string, body: unknown) {
  const response = await fetch(fn(name), {
    method: 'POST',
    headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const startBody = (projectId: string, key = crypto.randomUUID()) => ({
  schema_version: 1,
  project_id: projectId,
  incident_label: 'Fire alarm, north stair',
  idempotency_key: key,
});

async function board(client: SupabaseClient, musterId: string) {
  const { data, error } = await client.rpc('muster_board', { p_muster_id: musterId });
  expect(error).toBeNull();
  return data as {
    counts: {
      workers: {
        total: number;
        verified: number;
        self_reported: number;
        unaccounted: number;
        unknown: number;
      };
      visitors: { total: number; verified: number };
    };
    members: { member_id: string; name: string; kind: string; status: string }[];
  };
}

const musterOp = (
  projectId: string,
  type: 'MUSTER_SELF_REPORT' | 'MUSTER_PHYSICAL_VERIFY',
  payload: Record<string, unknown>,
  at = new Date(),
) => ({
  event_uuid: crypto.randomUUID(),
  project_id: projectId,
  operation_type: type,
  observed_at: at.toISOString(),
  payload: {
    action: type === 'MUSTER_SELF_REPORT' ? 'SELF_REPORT' : 'PHYSICAL_VERIFICATION',
    ...payload,
  },
});

/** A project with a crew of two, their foreman, a phone worker, a visitor on site and the staff. */
async function musterSite() {
  const world = await crewSite(2);
  const phone = await workerSession();
  const phoneWorkerId = await enroll(world.projectId, {
    userId: phone.userId,
    companyId: world.companyId,
    name: 'Paula Phone',
  });
  const safety = await staffClient();
  await assignStaff(safety.client, world.projectId, 'SAFETY');
  const attendant = await staffClient();
  await assignStaff(attendant.client, world.projectId, 'ATTENDANT');
  const visitorId = crypto.randomUUID();
  await withDb(async (db) => {
    await db.query(
      "insert into public.visitor_records (id, project_id, name, organization, purpose) values ($1, $2, 'Ivy Inspector', 'City', 'Inspection')",
      [visitorId, world.projectId],
    );
    await db.query(
      "insert into public.visitor_visits (visitor_id, project_id, checked_in_at, idempotency_key) values ($1, $2, now() - interval '30 minutes', gen_random_uuid())",
      [visitorId, world.projectId],
    );
  });
  return {
    ...world,
    phone,
    phoneWorkerId,
    safety,
    safetyJwt: await jwtOf(safety.client),
    attendant,
    attendantJwt: await jwtOf(attendant.client),
  };
}

describe('Active Muster Mode (local stack)', () => {
  it("2 workers + 1 visitor: I'M SAFE, a foreman check and a visitor check stay separate; self never becomes verified", async () => {
    const w = await musterSite();
    const started = await callFn('muster-start', w.safetyJwt, startBody(w.projectId));
    expect(started.status).toBe(200);
    const start = MusterStartResponseSchema.parse(started.body);
    expect(start).toMatchObject({
      created: true,
      push: { provider: 'development-fake', targets: 0 },
    });
    const initial = await board(w.safety.client, start.muster_id);
    expect(initial.counts.workers).toMatchObject({ total: 4, unaccounted: 4 });
    expect(initial.counts.visitors).toMatchObject({ total: 1, verified: 0 });
    const memberId = (name: string) => initial.members.find((m) => m.name === name)?.member_id;

    // The phone worker answers for herself only (worker JWT, own row resolved by the server).
    const self = musterOp(w.projectId, 'MUSTER_SELF_REPORT', {
      muster_id: start.muster_id,
      channel: 'APP',
    });
    expect(results((await post(w.phone.jwt, [self])).body)[0]?.status).toBe('accepted');
    // Resent from the offline queue: recorded once.
    expect(results((await post(w.phone.jwt, [self])).body)[0]?.status).toBe('duplicate');
    // She cannot answer for a crew member.
    const forOther = musterOp(w.projectId, 'MUSTER_SELF_REPORT', {
      muster_id: start.muster_id,
      snapshot_member_id: memberId('Crew Member 1'),
    });
    expect(results((await post(w.phone.jwt, [forOther])).body)[0]).toMatchObject({
      status: 'rejected',
      reason: 'FORBIDDEN',
    });

    // The foreman physically sees Crew Member 1; the visitor desk checks the visitor.
    const foremanCheck = musterOp(w.projectId, 'MUSTER_PHYSICAL_VERIFY', {
      muster_id: start.muster_id,
      snapshot_member_id: memberId('Crew Member 1'),
    });
    expect(results((await post(w.foreman.jwt, [foremanCheck])).body)[0]?.status).toBe('accepted');
    const visitorCheck = musterOp(w.projectId, 'MUSTER_PHYSICAL_VERIFY', {
      muster_id: start.muster_id,
      snapshot_member_id: memberId('Ivy Inspector'),
    });
    expect(results((await post(w.attendantJwt, [visitorCheck])).body)[0]?.status).toBe('accepted');

    const after = await board(w.safety.client, start.muster_id);
    expect(after.counts.workers).toMatchObject({
      total: 4,
      verified: 1,
      self_reported: 1,
      unaccounted: 2,
    });
    expect(after.counts.visitors).toMatchObject({ total: 1, verified: 1 });
    expect(after.members.find((m) => m.name === 'Paula Phone')?.status).toBe('SELF_REPORTED_SAFE');
    expect(
      await scalar<string>(
        "select string_agg(channel::text, ',' order by received_at) as v from public.muster_responses where muster_id = $1",
        [start.muster_id],
      ),
    ).toBe('APP,FOREMAN,KIOSK');
  });

  it('an attended kiosk verifies a phone badge at the assembly point', async () => {
    const w = await musterSite();
    const badgeWorker = await phoneWorker(w.projectId); // approved, activated phone with a badge secret
    await withDb((db) =>
      db.query(
        'update public.worker_enrollments set subcontractor_id = $1, employer_status = $2, employer_confirmed_at = now() where worker_id = $3',
        [w.companyId, 'VERIFIED', badgeWorker.workerId],
      ),
    );
    const registered = await w.attendant.client.rpc('register_kiosk', {
      p_project_id: w.projectId,
      p_device_public_id: `kiosk${crypto.randomUUID().replace(/-/g, '')}`,
    });
    expect(registered.error).toBeNull();
    const kioskId = (registered.data as { kiosk_device_id: string }).kiosk_device_id;
    const start = MusterStartResponseSchema.parse(
      (await callFn('muster-start', w.safetyJwt, startBody(w.projectId))).body,
    );
    const scan = musterOp(w.projectId, 'MUSTER_PHYSICAL_VERIFY', {
      muster_id: start.muster_id,
      badge_payload: buildBadgePayload(
        badgeWorker.secret,
        badgeWorker.deviceId,
        w.projectId,
        Math.floor(Date.now() / 1000),
      ),
      badge_kind: 'DYNAMIC_APP',
      kiosk_device_id: kioskId,
    });
    expect(results((await post(w.attendantJwt, [scan])).body)[0]).toMatchObject({
      status: 'accepted',
      worker_id: badgeWorker.workerId,
    });
    expect(
      await scalar<string>(
        'select canonical_status::text as v from public.muster_snapshot_members where muster_id = $1 and worker_id = $2',
        [start.muster_id, badgeWorker.workerId],
      ),
    ).toBe('VERIFIED_ACCOUNTED');
  });

  it('two simultaneous starts give one muster; only the designated role starts', async () => {
    const w = await musterSite();
    const [a, b] = await Promise.all([
      callFn('muster-start', w.safetyJwt, startBody(w.projectId)),
      callFn('muster-start', w.safetyJwt, startBody(w.projectId)),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body.muster_id).toBe(b.body.muster_id);
    expect([a.body.created, b.body.created].sort()).toEqual([false, true]);
    expect(
      await scalar<number>(
        "select count(*)::int as v from public.muster_events where project_id = $1 and status = 'ACTIVE'",
        [w.projectId],
      ),
    ).toBe(1);

    const superintendent = await staffClient();
    await assignStaff(superintendent.client, w.projectId, 'SUPER');
    expect(
      (await callFn('muster-start', await jwtOf(superintendent.client), startBody(w.projectId)))
        .status,
    ).toBe(403);
    expect((await callFn('muster-start', w.phone.jwt, startBody(w.projectId))).status).toBe(403);
    const other = await site();
    const gcB = await staffClient();
    await assignStaff(gcB.client, other.projectId, 'SAFETY');
    expect(
      (await callFn('muster-start', await jwtOf(gcB.client), startBody(w.projectId))).status,
    ).toBe(403);
    const { error } = await gcB.client.rpc('muster_board', { p_muster_id: a.body.muster_id });
    expect(error).not.toBeNull();
  });

  it('push goes only to registered phones and is recorded as metadata, never as presence', async () => {
    const w = await musterSite();
    const registered = await fetch(`${process.env.API_URL}/rest/v1/rpc/register_push_token`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${w.phone.jwt}`,
        apikey: process.env.ANON_KEY ?? '',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        p_installation_id: `install-${crypto.randomUUID()}`,
        p_expo_token: 'ExponentPushToken[backendtest0001]',
        p_platform: 'ANDROID',
      }),
    });
    expect(registered.status).toBe(204);
    const start = MusterStartResponseSchema.parse(
      (await callFn('muster-start', w.safetyJwt, startBody(w.projectId))).body,
    );
    expect(start.push).toEqual({ provider: 'development-fake', targets: 1, sent: 1, failed: 0 });
    expect(
      await scalar<string>(
        "select string_agg(status || ':' || n, ',' order by status) as v from (select status, count(*) as n from app_private.muster_push_attempts where muster_id = $1 group by status) x",
        [start.muster_id],
      ),
    ).toBe('NO_DEVICE:3,SENT:1');
    const now = await board(w.safety.client, start.muster_id);
    expect(now.counts.workers.self_reported + now.counts.workers.verified).toBe(0);
  });

  it('close needs an acknowledgement, freezes the report; late offline checks become amendments', async () => {
    const w = await musterSite();
    const start = MusterStartResponseSchema.parse(
      (await callFn('muster-start', w.safetyJwt, startBody(w.projectId))).body,
    );
    const members = (await board(w.safety.client, start.muster_id)).members;
    const crew2 = members.find((m) => m.name === 'Crew Member 2')?.member_id;
    const noAck = await callFn('muster-close', w.safetyJwt, {
      schema_version: 1,
      muster_id: start.muster_id,
      closure_note: 'Fire out',
      acknowledge_incomplete: false,
    });
    expect([noAck.status, (noAck.body.error as { code: string }).code]).toEqual([
      422,
      'ACKNOWLEDGE_INCOMPLETE_REQUIRED',
    ]);
    const madeBeforeClose = new Date(Date.now() - 1000);
    const closed = MusterCloseResponseSchema.parse(
      (
        await callFn('muster-close', w.safetyJwt, {
          schema_version: 1,
          muster_id: start.muster_id,
          closure_note: 'Fire out; four not checked',
          acknowledge_incomplete: true,
        })
      ).body,
    );
    expect(closed.counts.workers.unaccounted).toBe(4);
    expect(
      await scalar<string>('select digest as v from public.muster_reports where muster_id = $1', [
        start.muster_id,
      ]),
    ).toBe(closed.digest);

    // The foreman's phone was offline: his check (made before the close) syncs afterwards.
    const late = musterOp(
      w.projectId,
      'MUSTER_PHYSICAL_VERIFY',
      { muster_id: start.muster_id, snapshot_member_id: crew2 },
      madeBeforeClose,
    );
    expect(results((await post(w.foreman.jwt, [late], madeBeforeClose)).body)[0]?.status).toBe(
      'accepted',
    );
    expect(
      await scalar<string>('select kind as v from public.muster_amendments where muster_id = $1', [
        start.muster_id,
      ]),
    ).toBe('LATE_RESPONSE');
    expect(
      await scalar<string>(
        'select canonical_status::text as v from public.muster_snapshot_members where id = $1',
        [crew2],
      ),
    ).toBe('UNACCOUNTED');
    const tooLate = musterOp(
      w.projectId,
      'MUSTER_PHYSICAL_VERIFY',
      { muster_id: start.muster_id, snapshot_member_id: crew2 },
      new Date(Date.now() + 60_000),
    );
    expect(
      results((await post(w.foreman.jwt, [tooLate], new Date(Date.now() + 60_000))).body)[0],
    ).toMatchObject({ status: 'rejected', reason: 'MUSTER_CLOSED' });
  });
});
