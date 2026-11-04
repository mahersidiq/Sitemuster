import { describe, expect, it } from 'vitest';

import {
  DeviceActivateResponseSchema,
  DeviceRenewResponseSchema,
  LocationIngestResponseSchema,
} from '@sitemuster/shared';

import { newClient, uniquePhone } from './support/clients';
import { latestSmsCode, withDb } from './support/db';
import { backendEnv } from './support/env';

/**
 * Milestone 07 acceptance on the real local stack (Auth, PostgREST, Postgres, Edge runtime):
 * the device bearer secret from `device-activate` uploads through `ingest-location-batch`
 * (verify_jwt=false, custom authentication), whole-batch 200/503, idempotent resend, project A/B
 * isolation, old-phone revocation with a review flag on the open session, and renewal in the
 * middle of a 25-record queue with zero loss and zero duplicates.
 */
const fn = (name: string) => `${backendEnv().apiUrl}/functions/v1/${name}`;

async function workerSession() {
  const client = newClient();
  const phone = uniquePhone();
  await client.auth.signInWithOtp({ phone });
  await client.auth.verifyOtp({ phone, token: await latestSmsCode(phone), type: 'sms' });
  const { data } = await client.auth.getSession();
  return { userId: data.session?.user.id ?? '', jwt: data.session?.access_token ?? '' };
}

interface Site {
  projectId: string;
  configVersionId: string;
  identifier: string;
  center: { lat: number; lng: number };
}

/** An ACTIVE 24/7 project (one circle of 150 m) in a fresh organization, seeded as superuser. */
async function site(center: { lat: number; lng: number }): Promise<Site> {
  const owner = crypto.randomUUID();
  const org = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  const configVersionId = crypto.randomUUID();
  const identifier = `sm_${crypto.randomUUID().replace(/-/g, '')}`;
  await withDb(async (db) => {
    await db.query(
      `insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
       values ('00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated', $2, now(), '{}', '{}', now(), now())`,
      [owner, `m07-${owner.slice(0, 8)}@example.test`],
    );
    await db.query(
      'insert into public.organizations (id, name, owner_user_id, idempotency_key) values ($1, $2, $3, gen_random_uuid())',
      [org, 'Ingest GC', owner],
    );
    await db.query(
      "insert into public.organization_members (organization_id, user_id, role) values ($1, $2, 'OWNER')",
      [org, owner],
    );
    await db.query(
      `insert into public.projects (id, organization_id, name, iana_timezone, status, idempotency_key)
       values ($1, $2, 'Ingest site', 'America/Chicago', 'ACTIVE', gen_random_uuid())`,
      [projectId, org],
    );
    await db.query(
      `insert into public.project_tracking_config_versions (id, project_id, version_number, effective_at, settings_json, operates_24_7)
       values ($1, $2, 1, now() - interval '1 day', app_private.build_settings(150, 600, 75, true, '[]'::jsonb), true)`,
      [configVersionId, projectId],
    );
    await db.query(
      `insert into public.project_geofences (config_version_id, project_id, center, radius_m, sdk_identifier)
       values ($1, $2, extensions.st_setsrid(extensions.st_makepoint($3, $4), 4326)::extensions.geography, 150, $5)`,
      [configVersionId, projectId, center.lng, center.lat, identifier],
    );
    await db.query('update public.projects set config_version_id = $1 where id = $2', [
      configVersionId,
      projectId,
    ]);
  });
  return { projectId, configVersionId, identifier, center };
}

/** A signed-in worker approved and consented on `project`, with an activated phone. */
async function trackedWorker(project: Site) {
  const session = await workerSession();
  const workerId = crypto.randomUUID();
  await withDb(async (db) => {
    const notice = await db.query<{ id: string }>(
      "select id from public.legal_notice_versions where document_id = 'WORKER_LOCATION_DISCLOSURE_EN_V1'",
    );
    await db.query(
      'insert into public.worker_profiles (id, auth_user_id, legal_name, managed_identity) values ($1, $2, $3, false)',
      [workerId, session.userId, 'Ingest Worker'],
    );
    await db.query(
      'insert into public.orientation_records (worker_profile_id, project_id, completed_at, notice_version_id) values ($1, $2, now(), $3)',
      [workerId, project.projectId, notice.rows[0]?.id],
    );
    await db.query(
      `insert into public.worker_enrollments (project_id, worker_id, enrollment_status, employer_status, approval_at)
       values ($1, $2, 'APPROVED', 'PENDING_CONFIRMATION', now())`,
      [project.projectId, workerId],
    );
    await db.query(
      `insert into public.tracking_consents (worker_id, project_id, notice_version_id, locale, method, accepted_at)
       values ($1, $2, $3, 'en-US', 'DIGITAL', now())`,
      [workerId, project.projectId, notice.rows[0]?.id],
    );
  });
  const phone = await activate(session.jwt);
  return { ...session, workerId, ...phone };
}

async function activate(jwt: string) {
  const response = await fetch(fn('device-activate'), {
    method: 'POST',
    headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      platform: 'IOS',
      installation_hash: crypto.randomUUID().replace(/-/g, '').padEnd(64, 'a'),
      app_version: '0.3.0',
    }),
  });
  expect(response.status).toBe(200);
  const body = DeviceActivateResponseSchema.parse(await response.json());
  return { deviceId: body.device_id, token: body.upload_token };
}

async function upload(token: string, locations: unknown[], extra: Record<string, unknown> = {}) {
  const response = await fetch(fn('ingest-location-batch'), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ locations, ...extra }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as unknown) : null };
}

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const enter = (identifier: string, minutesAgo: number) => ({
  uuid: crypto.randomUUID(),
  timestamp: at(minutesAgo),
  event: 'geofence',
  geofence: { identifier, action: 'ENTER' },
  accuracy: 10,
});
const fix = (point: { lat: number; lng: number }, minutesAgo: number) => ({
  uuid: crypto.randomUUID(),
  timestamp: at(minutesAgo),
  event: 'location',
  coords: { latitude: point.lat, longitude: point.lng, accuracy: 8 },
  is_moving: false,
});

async function scalar<T>(sql: string, params: unknown[]): Promise<T> {
  return withDb(async (db) => (await db.query<{ v: T }>(sql, params)).rows[0]?.v as T);
}

describe('custom device ingestion (local stack, real Edge Functions)', () => {
  it('rejects requests without a valid device secret and malformed envelopes', async () => {
    const project = await site({ lat: 29.75, lng: -95.36 });
    const worker = await trackedWorker(project);
    const get = await fetch(fn('ingest-location-batch'), {
      method: 'GET',
      headers: { authorization: `Bearer ${worker.token}` },
    });
    expect(get.status).toBe(405);
    expect((await upload('x'.repeat(43), [enter(project.identifier, 1)])).status).toBe(401);
    expect((await upload(worker.jwt, [enter(project.identifier, 1)])).status).toBe(401);
    const text = await fetch(fn('ingest-location-batch'), {
      method: 'POST',
      headers: { authorization: `Bearer ${worker.token}`, 'content-type': 'text/plain' },
      body: 'x',
    });
    expect(text.status).toBe(415);
    expect(
      (await upload(worker.token, [enter(project.identifier, 1)], { worker_id: worker.workerId }))
        .status,
    ).toBe(422);
  });

  it('accepts a batch durably, answers duplicates on resend, and opens one session after the dwell', async () => {
    const project = await site({ lat: 29.7, lng: -95.3 });
    const worker = await trackedWorker(project);
    const batch = [enter(project.identifier, 15), fix(project.center, 14), fix(project.center, 3)];
    const first = await upload(worker.token, batch);
    expect(first.status).toBe(200);
    const body = LocationIngestResponseSchema.parse(first.body);
    expect(body.results.map((r) => r.status)).toEqual(['accepted', 'accepted', 'accepted']);
    const again = LocationIngestResponseSchema.parse((await upload(worker.token, batch)).body);
    expect(again.results.map((r) => r.status)).toEqual(['duplicate', 'duplicate', 'duplicate']);
    expect(
      await scalar<number>(
        "select count(*)::int as v from public.attendance_sessions where project_id = $1 and worker_id = $2 and status = 'OPEN'",
        [project.projectId, worker.workerId],
      ),
    ).toBe(1);
    expect(
      await scalar<number>(
        'select count(*)::int as v from app_private.location_event_receipts where event_uuid = any($1::uuid[])',
        [batch.map((r) => r.uuid)],
      ),
    ).toBe(3);
  });

  it('a project-A credential never writes project B (identifier, ids in extras, coordinates inside B)', async () => {
    const projectA = await site({ lat: 29.6, lng: -95.2 });
    const projectB = await site({ lat: 40.7, lng: -74.0 });
    const workerA = await trackedWorker(projectA);
    const workerB = await trackedWorker(projectB);
    const hostile = [
      { ...enter(projectB.identifier, 2), extras: { project_id: projectB.projectId } },
      { ...enter(projectA.identifier, 2), extras: { worker_id: workerB.workerId } },
      { ...fix(projectB.center, 1), extras: { project_id: projectB.projectId } },
    ];
    const response = await upload(workerA.token, hostile);
    expect(response.status).toBe(200);
    const body = LocationIngestResponseSchema.parse(response.body);
    expect(body.results.map((r) => [r.status, r.reason])).toEqual([
      ['rejected', 'PROJECT_NOT_AUTHORIZED'],
      ['accepted', null],
      ['rejected', 'COORDINATES_NOT_PERMITTED'],
    ]);
    const touchedB = await scalar<number>(
      `select ((select count(*) from app_private.location_event_receipts where device_id = $1 and project_id = $2)
             + (select count(*) from public.presence_states where project_id = $2 and worker_id = $3)
             + (select count(*) from public.attendance_events where project_id = $2 and worker_id = $3)
             + (select count(*) from public.latest_onsite_positions where project_id = $2))::int as v`,
      [workerA.deviceId, projectB.projectId, workerA.workerId],
    );
    expect(touchedB).toBe(0);
    expect(
      await scalar<number>(
        "select count(*)::int as v from app_private.location_ingest_quarantine where device_id = $1 and sanitized_payload::text ~ '(latitude|longitude|40\\.7)'",
        [workerA.deviceId],
      ),
    ).toBe(0);
  });

  it('answers 503 for the whole batch while the reconciler is unavailable, then applies it exactly once', async () => {
    const project = await site({ lat: 29.65, lng: -95.25 });
    const worker = await trackedWorker(project);
    const batch = [enter(project.identifier, 5), enter('sm_not_bound_anywhere', 4)];
    await withDb((db) =>
      db.query('revoke execute on function public.edge_attendance_commit(jsonb) from service_role'),
    );
    try {
      const failed = await upload(worker.token, batch);
      expect(failed.status).toBe(503);
    } finally {
      await withDb((db) =>
        db.query('grant execute on function public.edge_attendance_commit(jsonb) to service_role'),
      );
    }
    const retried = LocationIngestResponseSchema.parse((await upload(worker.token, batch)).body);
    expect(retried.results.map((r) => r.status)).toEqual(['accepted', 'duplicate']);
    expect(
      await scalar<number>(
        'select count(*)::int as v from app_private.location_event_receipts where event_uuid = any($1::uuid[])',
        [batch.map((r) => r.uuid)],
      ),
    ).toBe(2);
  });

  it('a replaced phone is refused (401) and the open session is flagged DEVICE_REPLACED', async () => {
    const project = await site({ lat: 29.55, lng: -95.15 });
    const worker = await trackedWorker(project);
    await upload(worker.token, [
      enter(project.identifier, 15),
      fix(project.center, 14),
      fix(project.center, 2),
    ]);
    const second = await activate(worker.jwt);
    expect((await upload(worker.token, [fix(project.center, 1)])).status).toBe(401);
    expect((await upload(second.token, [fix(project.center, 1)])).status).toBe(200);
    expect(
      await scalar<string[]>(
        "select review_reasons as v from public.attendance_sessions where project_id = $1 and worker_id = $2 and status in ('OPEN', 'PENDING_APPROVAL')",
        [project.projectId, worker.workerId],
      ),
    ).toContain('DEVICE_REPLACED');
  });

  it('renewal in the middle of a 25-record queue: zero loss, zero duplicates, old secret ends after the overlap', async () => {
    const project = await site({ lat: 29.5, lng: -95.1 });
    const worker = await trackedWorker(project);
    const queued = [
      enter(project.identifier, 30),
      ...Array.from({ length: 24 }, (_, i) => fix(project.center, 29 - i)),
    ];
    // The SDK refreshes its token natively (FORM POST) while this batch is already in flight.
    const renewal = await fetch(fn('device-renew'), {
      method: 'POST',
      headers: { authorization: `Bearer ${worker.token}` },
      body: new URLSearchParams({ refresh_token: worker.token }),
    });
    expect(renewal.status).toBe(200);
    const renewed = DeviceRenewResponseSchema.parse(await renewal.json());
    expect(renewed.access_token).toBe(renewed.upload_token);
    expect(renewed.upload_token).not.toBe(worker.token);

    const inFlight = await upload(worker.token, queued); // old header, inside the 24 h overlap
    expect(inFlight.status).toBe(200);
    const accepted = LocationIngestResponseSchema.parse(inFlight.body);
    expect(accepted.results.filter((r) => r.status === 'accepted')).toHaveLength(25);
    const resent = LocationIngestResponseSchema.parse(
      (await upload(renewed.upload_token, queued)).body,
    );
    expect(resent.results.every((r) => r.status === 'duplicate')).toBe(true);
    expect(
      await scalar<number>(
        'select count(*)::int as v from app_private.location_event_receipts where event_uuid = any($1::uuid[])',
        [queued.map((r) => r.uuid)],
      ),
    ).toBe(25);

    const superseded = await fetch(fn('device-renew'), {
      method: 'POST',
      headers: { authorization: `Bearer ${worker.token}`, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(superseded.status).toBe(401);
    expect(await superseded.json()).toMatchObject({ error: { code: 'CREDENTIAL_SUPERSEDED' } });

    await withDb((db) =>
      db.query(
        "update app_private.device_upload_credentials set overlap_until = now() - interval '1 second' where device_id = $1 and overlap_until is not null",
        [worker.deviceId],
      ),
    );
    expect((await upload(worker.token, [fix(project.center, 0)])).status).toBe(401);
    expect((await upload(renewed.upload_token, [fix(project.center, 0)])).status).toBe(200);
  });

  it('the signed-in worker can renew in the foreground (also after the secret expired)', async () => {
    const project = await site({ lat: 29.45, lng: -95.05 });
    const worker = await trackedWorker(project);
    await withDb((db) =>
      db.query(
        "update app_private.device_upload_credentials set expires_at = now() - interval '1 minute', created_at = now() - interval '30 days' where device_id = $1",
        [worker.deviceId],
      ),
    );
    expect((await upload(worker.token, [enter(project.identifier, 1)])).status).toBe(401);
    const response = await fetch(fn('device-renew'), {
      method: 'POST',
      headers: { authorization: `Bearer ${worker.jwt}`, 'content-type': 'application/json' },
      body: JSON.stringify({ app_version: '0.3.1' }),
    });
    expect(response.status).toBe(200);
    const renewed = DeviceRenewResponseSchema.parse(await response.json());
    expect((await upload(renewed.upload_token, [enter(project.identifier, 1)])).status).toBe(200);
  });
});
