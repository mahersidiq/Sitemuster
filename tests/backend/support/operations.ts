import { sha256 } from '@noble/hashes/sha2.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { expect } from 'vitest';

import {
  base64UrlDecode,
  DeviceActivateResponseSchema,
  IngestOperationsResponseSchema,
} from '@sitemuster/shared';

import { newClient, uniquePhone } from './clients';
import { latestSmsCode, withDb } from './db';
import { backendEnv } from './env';

/**
 * Seeding and request helpers shared by the operations (Milestone 08) and dashboard (Milestone 09)
 * end-to-end tests: superuser seeding of an ACTIVE 24/7 project, approved workers, phone and
 * printed badges, and calls to the real `ingest-operations` Edge Function.
 */
export const fn = (name: string) => `${backendEnv().apiUrl}/functions/v1/${name}`;

export async function scalar<T>(sql: string, params: unknown[]): Promise<T> {
  return withDb(async (db) => (await db.query<{ v: T }>(sql, params)).rows[0]?.v as T);
}

export async function workerSession() {
  const client = newClient();
  const phone = uniquePhone();
  await client.auth.signInWithOtp({ phone });
  await client.auth.verifyOtp({ phone, token: await latestSmsCode(phone), type: 'sms' });
  const { data } = await client.auth.getSession();
  return { userId: data.session?.user.id ?? '', jwt: data.session?.access_token ?? '' };
}

export async function userIdOf(client: SupabaseClient): Promise<string> {
  return (await client.auth.getUser()).data.user?.id ?? '';
}

export async function jwtOf(client: SupabaseClient): Promise<string> {
  return (await client.auth.getSession()).data.session?.access_token ?? '';
}

/** An ACTIVE 24/7 project with one approved subcontractor, seeded as superuser. */
export async function site() {
  const owner = crypto.randomUUID();
  const org = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  const configVersionId = crypto.randomUUID();
  const companyId = crypto.randomUUID();
  await withDb(async (db) => {
    await db.query(
      `insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
       values ('00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated', $2, now(), '{}', '{}', now(), now())`,
      [owner, `m08-${owner.slice(0, 8)}@example.test`],
    );
    await db.query(
      'insert into public.organizations (id, name, owner_user_id, idempotency_key) values ($1, $2, $3, gen_random_uuid())',
      [org, 'Operations GC', owner],
    );
    await db.query(
      "insert into public.organization_members (organization_id, user_id, role) values ($1, $2, 'OWNER')",
      [org, owner],
    );
    await db.query(
      `insert into public.projects (id, organization_id, name, iana_timezone, status, idempotency_key)
       values ($1, $2, 'Operations site', 'America/Chicago', 'ACTIVE', gen_random_uuid())`,
      [projectId, org],
    );
    await db.query(
      `insert into public.project_tracking_config_versions (id, project_id, version_number, effective_at, settings_json, operates_24_7)
       values ($1, $2, 1, now() - interval '1 day', app_private.build_settings(150, 600, 75, true, '[]'::jsonb), true)`,
      [configVersionId, projectId],
    );
    await db.query(
      `insert into public.project_geofences (config_version_id, project_id, center, radius_m, sdk_identifier)
       values ($1, $2, extensions.st_setsrid(extensions.st_makepoint(-95.36, 29.75), 4326)::extensions.geography, 150, $3)`,
      [configVersionId, projectId, `sm_${projectId.replace(/-/g, '')}`],
    );
    await db.query('update public.projects set config_version_id = $1 where id = $2', [
      configVersionId,
      projectId,
    ]);
    await db.query(
      "insert into public.subcontractor_companies (id, canonical_name) values ($1, 'Crew Concrete')",
      [companyId],
    );
    await db.query(
      "insert into public.project_subcontractors (project_id, subcontractor_id, status) values ($1, $2, 'APPROVED')",
      [projectId, companyId],
    );
  });
  return { projectId, companyId };
}

/** An approved, acknowledged worker on the project (managed identity unless a user is given). */
export async function enroll(
  projectId: string,
  options: { userId?: string; companyId?: string; name?: string } = {},
): Promise<string> {
  const workerId = crypto.randomUUID();
  await withDb(async (db) => {
    const notice = await db.query<{ id: string }>(
      "select id from public.legal_notice_versions where document_id = 'WORKER_LOCATION_DISCLOSURE_EN_V1'",
    );
    await db.query(
      'insert into public.worker_profiles (id, auth_user_id, legal_name, managed_identity) values ($1, $2, $3, $4)',
      [workerId, options.userId ?? null, options.name ?? 'Crew Worker', !options.userId],
    );
    await db.query(
      'insert into public.orientation_records (worker_profile_id, project_id, completed_at, notice_version_id) values ($1, $2, now(), $3)',
      [workerId, projectId, notice.rows[0]?.id],
    );
    await db.query(
      `insert into public.worker_enrollments (project_id, worker_id, subcontractor_id, enrollment_status, employer_status,
                                              employer_confirmed_at, approval_at)
       values ($1, $2, $3, 'APPROVED', $4, $5, now())`,
      [
        projectId,
        workerId,
        options.companyId ?? null,
        options.companyId ? 'VERIFIED' : 'PENDING_CONFIRMATION',
        options.companyId ? new Date().toISOString() : null,
      ],
    );
    await db.query(
      `insert into public.tracking_consents (worker_id, project_id, notice_version_id, locale, method, accepted_at)
       values ($1, $2, $3, 'en-US', 'DIGITAL', now())`,
      [workerId, projectId, notice.rows[0]?.id],
    );
    if (options.companyId) {
      await db.query(
        "insert into public.subcontractor_members (company_id, worker_profile_id, role, verification_status) values ($1, $2, 'WORKER', 'VERIFIED')",
        [options.companyId, workerId],
      );
    }
  });
  return workerId;
}

/** A worker with an activated phone: the offline badge secret comes back from device-activate. */
export async function phoneWorker(projectId: string) {
  const session = await workerSession();
  const workerId = await enroll(projectId, { userId: session.userId, name: 'Phone Worker' });
  const response = await fetch(fn('device-activate'), {
    method: 'POST',
    headers: { authorization: `Bearer ${session.jwt}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      platform: 'ANDROID',
      installation_hash: crypto.randomUUID().replace(/-/g, '').padEnd(64, 'b'),
      app_version: '0.4.0',
    }),
  });
  expect(response.status).toBe(200);
  const body = DeviceActivateResponseSchema.parse(await response.json());
  return { workerId, deviceId: body.device_id, secret: base64UrlDecode(body.badge_secret) };
}

export async function printedWorker(projectId: string) {
  const workerId = await enroll(projectId, { name: 'No-Phone Worker' });
  const code = `SMP1.${crypto.randomUUID().replace(/-/g, '')}`;
  await withDb((db) =>
    db.query(
      "insert into public.worker_badges (worker_id, badge_kind, opaque_badge_hash) values ($1, 'PRINTED', $2)",
      [workerId, Buffer.from(sha256(new TextEncoder().encode(code)))],
    ),
  );
  return { workerId, code };
}

export async function post(jwt: string, events: unknown[], sentAt = new Date()) {
  const response = await fetch(fn('ingest-operations'), {
    method: 'POST',
    headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
    body: JSON.stringify({ schema_version: 1, client_sent_at: sentAt.toISOString(), events }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as unknown) : null };
}

export const results = (body: unknown) => IngestOperationsResponseSchema.parse(body).results;
export const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

/** A project with one company, `size` approved crew workers and a verified foreman. */
export async function crewSite(size: number) {
  const { projectId, companyId } = await site();
  const crew: string[] = [];
  for (let i = 0; i < size; i += 1) {
    crew.push(await enroll(projectId, { companyId, name: `Crew Member ${i + 1}` }));
  }
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
  return { projectId, companyId, crew, foreman };
}

export async function assignStaff(client: SupabaseClient, projectId: string, role: string) {
  const userId = await userIdOf(client);
  await withDb((db) =>
    db.query(
      'insert into public.project_staff (project_id, user_id, role, emergency_designated) values ($1, $2, $3, false)',
      [projectId, userId, role],
    ),
  );
}

export const crewBatch = (
  projectId: string,
  companyId: string,
  workers: string[],
  direction: 'ENTRY' | 'EXIT' = 'ENTRY',
  minutes = 5,
  observedAt: Date = minutesAgo(minutes),
) => ({
  event_uuid: crypto.randomUUID(),
  project_id: projectId,
  operation_type: direction === 'ENTRY' ? 'FOREMAN_BULK_ENTRY' : 'FOREMAN_BULK_EXIT',
  observed_at: observedAt.toISOString(),
  payload: {
    subcontractor_id: companyId,
    worker_ids: workers,
    direction,
    verification_method: 'PHYSICAL_CONFIRMATION',
  },
});
