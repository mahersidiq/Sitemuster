import { describe, expect, it } from 'vitest';

import { buildBadgePayload } from '@sitemuster/shared';

import { withDb } from './support/db';
import { backendEnv } from './support/env';
import {
  enroll,
  fn,
  jwtOf,
  minutesAgo,
  phoneWorker,
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
 * Milestone 08 acceptance on the real local stack (Auth, PostgREST, Postgres, Edge runtime):
 * `ingest-operations` (verify_jwt = true) with kiosk scans (offline phone badge + printed badge),
 * foreman crew batches, a manual correction and a visitor, sent late as an offline outbox would,
 * then resent: exactly-once, per-person results, the printed flag kept, visitors separate, and
 * no cross-tenant write.
 */
describe('ingest-operations (local stack, real Edge Function)', () => {
  it('offline kiosk 20 scans + foreman 20 crew events → exactly 40 accepted; the resend adds nothing', async () => {
    const { projectId, companyId } = await site();
    // Kiosk attendant (MFA) with a registered kiosk.
    const attendant = await staffClient();
    const attendantId = await userIdOf(attendant.client);
    await withDb((db) =>
      db.query(
        "insert into public.project_staff (project_id, user_id, role, emergency_designated) values ($1, $2, 'ATTENDANT', false)",
        [projectId, attendantId],
      ),
    );
    const registered = await attendant.client.rpc('register_kiosk', {
      p_project_id: projectId,
      p_device_public_id: `kiosk${crypto.randomUUID().replace(/-/g, '')}`,
    });
    expect(registered.error).toBeNull();
    const kioskId = (registered.data as { kiosk_device_id: string }).kiosk_device_id;

    // 10 workers with phone badges, 10 with printed badges; 20 crew workers for the foreman.
    const phones = [];
    for (let i = 0; i < 10; i += 1) phones.push(await phoneWorker(projectId));
    const printed = [];
    for (let i = 0; i < 10; i += 1) printed.push(await printedWorker(projectId));
    const crew = [];
    for (let i = 0; i < 20; i += 1) crew.push(await enroll(projectId, { companyId }));
    const foreman = await workerSession();
    const foremanProfile = await enroll(projectId, {
      userId: foreman.userId,
      companyId,
      name: 'Fran Foreman',
    });
    await withDb((db) =>
      db.query(
        "update public.subcontractor_members set role = 'FOREMAN' where company_id = $1 and worker_profile_id = $2",
        [companyId, foremanProfile],
      ),
    );

    // Both phones and the kiosk were offline: scans happened 30–40 minutes ago.
    const scans = [
      ...phones.map((p, i) => {
        const at = minutesAgo(40 - i);
        return {
          event_uuid: crypto.randomUUID(),
          project_id: projectId,
          operation_type: 'KIOSK_ENTRY',
          observed_at: at.toISOString(),
          payload: {
            badge_payload: buildBadgePayload(
              p.secret,
              p.deviceId,
              projectId,
              Math.floor(at.getTime() / 1000),
            ),
            badge_kind: 'DYNAMIC_APP',
            kiosk_device_id: kioskId,
            direction: 'ENTRY',
          },
        };
      }),
      ...printed.map((p, i) => ({
        event_uuid: crypto.randomUUID(),
        project_id: projectId,
        operation_type: 'KIOSK_ENTRY',
        observed_at: minutesAgo(30 - i).toISOString(),
        payload: {
          badge_payload: p.code,
          badge_kind: 'PRINTED',
          kiosk_device_id: kioskId,
          direction: 'ENTRY',
        },
      })),
    ];
    const crews = [crew.slice(0, 10), crew.slice(10)].map((workers) => ({
      event_uuid: crypto.randomUUID(),
      project_id: projectId,
      operation_type: 'FOREMAN_BULK_ENTRY',
      observed_at: minutesAgo(35).toISOString(),
      payload: {
        subcontractor_id: companyId,
        worker_ids: workers,
        direction: 'ENTRY',
        verification_method: 'PHYSICAL_CONFIRMATION',
      },
    }));

    const attendantJwt = await jwtOf(attendant.client);
    const kioskResponse = await post(attendantJwt, scans);
    expect(kioskResponse.status).toBe(200);
    const crewResponse = await post(foreman.jwt, crews);
    expect(crewResponse.status).toBe(200);
    const kioskResults = results(kioskResponse.body);
    const crewResults = results(crewResponse.body);
    const accepted =
      kioskResults.filter((r) => r.status === 'accepted').length +
      crewResults.flatMap((r) => r.children ?? []).filter((c) => c.status === 'accepted').length;
    expect(accepted).toBe(40);
    expect(kioskResults.map((r) => r.worker_id)).toEqual([
      ...phones.map((p) => p.workerId),
      ...printed.map((p) => p.workerId),
    ]);

    const openSessions = () =>
      scalar<number>(
        "select count(*)::int as v from public.attendance_sessions where project_id = $1 and status = 'OPEN'",
        [projectId],
      );
    expect(await openSessions()).toBe(40);
    expect(
      await scalar<number>(
        "select count(*)::int as v from public.attendance_sessions where project_id = $1 and start_source = 'KIOSK_PRINTED_BADGE'",
        [projectId],
      ),
    ).toBe(10);

    // Airplane mode on/off: the answers were lost and the outboxes resend everything.
    const kioskAgain = results((await post(attendantJwt, scans)).body);
    expect(
      kioskAgain.every((r) => r.status === 'duplicate' && r.original_status === 'accepted'),
    ).toBe(true);
    const crewAgain = results((await post(foreman.jwt, crews)).body);
    expect(crewAgain.every((r) => r.status === 'duplicate' && r.children?.length === 10)).toBe(
      true,
    );
    expect(await openSessions()).toBe(40);
    expect(
      await scalar<number>(
        'select count(*)::int as v from public.attendance_events where project_id = $1',
        [projectId],
      ),
    ).toBe(40);
    expect(
      await scalar<number>(
        'select count(*)::int as v from app_private.operational_outbox_receipts where event_uuid = any($1::uuid[])',
        [[...scans, ...crews].map((e) => e.event_uuid)],
      ),
    ).toBe(22);

    // The same 30-second code scanned again is a replay; per-worker errors are surfaced.
    const replay = { ...scans[0], event_uuid: crypto.randomUUID() };
    expect(results((await post(attendantJwt, [replay])).body)[0]).toMatchObject({
      status: 'rejected',
      reason: 'BADGE_REPLAY',
    });
    const outsider = await enroll(projectId, { name: 'Other Company' });
    const mixed = {
      event_uuid: crypto.randomUUID(),
      project_id: projectId,
      operation_type: 'FOREMAN_BULK_EXIT',
      observed_at: new Date().toISOString(),
      payload: {
        subcontractor_id: companyId,
        worker_ids: [crew[0], outsider],
        direction: 'EXIT',
        verification_method: 'FOREMAN_REPORT',
      },
    };
    const [mixedResult] = results((await post(foreman.jwt, [mixed])).body);
    expect(mixedResult).toMatchObject({ status: 'accepted', reason: 'SOME_WORKERS_REJECTED' });
    expect(mixedResult?.children?.map((c) => c.status)).toEqual(['accepted', 'rejected']);
    expect(mixedResult?.children?.[1]?.reason).toBe('WORKER_NOT_IN_COMPANY');

    // A visitor signs in and is never a workforce session.
    const visitorId = crypto.randomUUID();
    const superClient = await staffClient();
    const superId = await userIdOf(superClient.client);
    await withDb((db) =>
      db.query(
        "insert into public.project_staff (project_id, user_id, role, emergency_designated) values ($1, $2, 'SUPER', false)",
        [projectId, superId],
      ),
    );
    const visit = results(
      (
        await post(attendantJwt, [
          {
            event_uuid: crypto.randomUUID(),
            project_id: projectId,
            operation_type: 'VISITOR_ENTRY',
            observed_at: new Date().toISOString(),
            payload: {
              visitor_id: visitorId,
              name: 'Ivy Inspector',
              organization: 'City',
              host_user_id: superId,
              purpose: 'Inspection',
              direction: 'ENTRY',
            },
          },
        ])
      ).body,
    );
    expect(visit[0]?.status).toBe('accepted');
    expect(
      await scalar<string>(
        'select status::text as v from public.visitor_visits where visitor_id = $1',
        [visitorId],
      ),
    ).toBe('OPEN');
    expect(await openSessions()).toBe(39); // crew[0] signed out above; the visitor added nothing

    // A manual correction by the superintendent: pick the session, change its start, give a reason.
    const listed = await superClient.client.rpc('worker_attendance_sessions', {
      p_project_id: projectId,
      p_worker_id: crew[1],
    });
    expect(listed.error).toBeNull();
    const sessionId = (listed.data as { session_id: string }[])[0]?.session_id;
    expect(typeof sessionId).toBe('string');
    const correctionEvent = {
      event_uuid: crypto.randomUUID(),
      project_id: projectId,
      operation_type: 'MANUAL_ATTENDANCE_CORRECTION',
      observed_at: new Date().toISOString(),
      payload: {
        worker_id: crew[1],
        session_id: sessionId,
        corrected_start_at: minutesAgo(50).toISOString(),
        reason: 'Arrived before the crew sheet',
      },
    };
    const [correction] = results(
      (await post(await jwtOf(superClient.client), [correctionEvent])).body,
    );
    expect([correction?.status, correction?.reason]).toEqual(['accepted', null]);
    // Without a session the same change would be a second, overlapping session: refused.
    const [overlap] = results(
      (
        await post(await jwtOf(superClient.client), [
          {
            ...correctionEvent,
            event_uuid: crypto.randomUUID(),
            payload: { ...correctionEvent.payload, session_id: undefined },
          },
        ])
      ).body,
    );
    expect(overlap).toMatchObject({ status: 'rejected', reason: 'OVERLAPPING_SESSION' });
    // The kiosk attendant cannot correct attendance.
    const [byAttendant] = results(
      (await post(attendantJwt, [{ ...correctionEvent, event_uuid: crypto.randomUUID() }])).body,
    );
    expect(byAttendant).toMatchObject({ status: 'rejected', reason: 'FORBIDDEN' });
    expect(
      await scalar<string>(
        "select reason as v from public.attendance_corrections where worker_id = $1 and channel = 'STAFF_MANUAL'",
        [crew[1]],
      ),
    ).toBe('Arrived before the crew sheet');
  });

  it('refuses a project the caller has no role on without writing anything there, and requires a user', async () => {
    const a = await site();
    const b = await site();
    const attendantB = await staffClient();
    const attendantBId = await userIdOf(attendantB.client);
    await withDb((db) =>
      db.query(
        "insert into public.project_staff (project_id, user_id, role, emergency_designated) values ($1, $2, 'ATTENDANT', false)",
        [b.projectId, attendantBId],
      ),
    );
    const worker = await printedWorker(a.projectId);
    const foreign = {
      event_uuid: crypto.randomUUID(),
      project_id: a.projectId,
      operation_type: 'KIOSK_ENTRY',
      observed_at: new Date().toISOString(),
      payload: {
        badge_payload: worker.code,
        badge_kind: 'PRINTED',
        kiosk_device_id: crypto.randomUUID(),
        direction: 'ENTRY',
      },
    };
    const response = await post(await jwtOf(attendantB.client), [foreign]);
    expect(response.status).toBe(200);
    expect(results(response.body)[0]).toMatchObject({
      status: 'rejected',
      reason: 'PROJECT_NOT_AUTHORIZED',
    });
    expect(
      await scalar<number>(
        'select count(*)::int as v from public.attendance_events where project_id = $1',
        [a.projectId],
      ),
    ).toBe(0);
    expect(
      await scalar<string | null>(
        'select project_id::text as v from app_private.operational_outbox_receipts where event_uuid = $1',
        [foreign.event_uuid],
      ),
    ).toBeNull();
    expect((await post(backendEnv().anonKey, [foreign])).status).toBe(401);
    const unsigned = await fetch(fn('ingest-operations'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(unsigned.status).toBe(401);
  });
});
