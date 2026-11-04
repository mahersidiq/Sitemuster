import { describe, expect, it } from 'vitest';

import {
  base64UrlDecode,
  buildBadgePayload,
  DEFAULT_WORK_WINDOWS,
  DeviceActivateResponseSchema,
  OrientationSessionSchema,
  rotatingOrientationCode,
  staticOrientationCode,
} from '@sitemuster/shared';

import { SupabaseSiteMusterApi } from '../../src/api/supabase-api';
import { verifyDynamicBadge } from '../../supabase/functions/_shared/badge-core';
import { developmentBadgeKey } from '../../supabase/functions/_shared/badge-crypto';
import { newClient, uniqueEmail, uniquePhone } from './support/clients';
import { latestSmsCode, withDb } from './support/db';
import { backendEnv } from './support/env';
import { staffClient } from './support/staff';

/**
 * Milestone 05 acceptance on the real local stack (Auth, PostgREST, Postgres, Edge runtime):
 * worker joins by QR and stays PENDING until staff approve; closed sessions reject the printed QR;
 * device activation returns a badge secret stored only encrypted; an offline badge verifies once
 * and its replay is rejected.
 */
async function edge(fn: string, token: string, body: unknown) {
  const response = await fetch(`${backendEnv().apiUrl}/functions/v1/${fn}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function tokenOf(client: ReturnType<typeof newClient>) {
  return (await client.auth.getSession()).data.session?.access_token ?? '';
}

async function activeProject() {
  const owner = await staffClient(uniqueEmail('orient-owner'));
  const api = new SupabaseSiteMusterApi(owner.client);
  const organizationId = await api.createOrganization({
    name: 'Orientation GC',
    address: '',
    businessEmail: '',
    phone: '',
    idempotencyKey: crypto.randomUUID(),
  });
  const projectId = await api.createProject({
    organizationId,
    name: 'Orientation Tower',
    projectNumber: '',
    address: '1 Test St',
    centerLat: 29.76,
    centerLng: -95.37,
    ianaTimezone: 'America/Chicago',
    radiusM: 150,
    operates24x7: false,
    workWindows: [...DEFAULT_WORK_WINDOWS],
    entryDwellSeconds: 600,
    maxHorizontalAccuracyM: 75,
    idempotencyKey: crypto.randomUUID(),
  });
  await api.setStatus(projectId, 'ACTIVE', null);
  return { owner, projectId };
}

async function workerClient() {
  const client = newClient();
  const phone = uniquePhone();
  await client.auth.signInWithOtp({ phone });
  await client.auth.verifyOtp({ phone, token: await latestSmsCode(phone), type: 'sms' });
  return client;
}

describe('orientation, approval and offline badge (local stack)', () => {
  it('joins by rotating QR, stays PENDING until approval, then gets a working single-use badge', async () => {
    const { owner, projectId } = await activeProject();
    const staffToken = await tokenOf(owner.client);

    const started = await edge('orientation-session', staffToken, {
      action: 'START',
      project_id: projectId,
      idempotency_key: crypto.randomUUID(),
    });
    expect(started.status).toBe(200);
    const session = OrientationSessionSchema.parse(started.body.session);

    // The app computes the 60-second code locally; the database verifies it independently.
    const worker = await workerClient();
    const code = rotatingOrientationCode(
      base64UrlDecode(session.rotating_secret),
      session.session_id,
      Math.floor(Date.now() / 1000),
    );
    const preview = await worker.rpc('preview_orientation', { p_code: code, p_locale: 'es-US' });
    expect(preview.error).toBeNull();
    const notice = (preview.data as { notice: { id: string; review_status: string } }).notice;
    expect(notice.review_status).toBe('DRAFT_REQUIRES_HUMAN_REVIEW');

    const joined = await worker.rpc('complete_orientation', {
      p_code: code,
      p_locale: 'es-US',
      p_legal_name: 'Ana Trabajadora',
      p_company_id: null,
      p_company_name: 'Concretos del Sur',
      p_trade: 'Concreto',
      p_emergency_name: 'Luis',
      p_emergency_phone: '+15550002222',
      p_emergency_relationship: 'Hermano',
      p_notice_version_id: notice.id,
      p_accept: true,
    });
    expect(joined.error).toBeNull();
    const enrollmentId = (joined.data as { enrollment_id: string; enrollment_status: string })
      .enrollment_id;
    expect((joined.data as { enrollment_status: string }).enrollment_status).toBe('PENDING');

    // Not approved yet: no device can produce a valid badge for this project.
    const workerToken = await tokenOf(worker);
    const activated = await edge('device-activate', workerToken, {
      platform: 'ANDROID',
      installation_hash: 'e'.repeat(64),
      app_version: '0.1.0',
    });
    expect(activated.status).toBe(200);
    const device = DeviceActivateResponseSchema.parse(activated.body);

    const approval = await edge('enrollment-bulk-approve', staffToken, {
      project_id: projectId,
      enrollment_ids: [enrollmentId],
    });
    expect(approval.status).toBe(200);
    expect(approval.body.results).toEqual([{ enrollment_id: enrollmentId, result: 'APPROVED' }]);
    const employer = await owner.client.rpc('bulk_confirm_employer', {
      p_project_id: projectId,
      p_enrollment_ids: [enrollmentId],
      p_decision: 'VERIFIED',
    });
    expect((employer.data as { result: string }[])[0]?.result).toBe('VERIFIED');

    // Offline badge from the returned secret; the server side only holds ciphertext.
    const secret = base64UrlDecode(device.badge_secret);
    const stored = await withDb(
      async (db) =>
        (
          await db.query<{ blob: Buffer }>(
            'select secret_ciphertext as blob from app_private.device_badge_secrets where device_id = $1',
            [device.device_id],
          )
        ).rows[0]?.blob,
    );
    expect(stored).toBeDefined();
    expect(Buffer.from(stored ?? []).includes(Buffer.from(secret))).toBe(false);

    const now = new Date();
    const payload = buildBadgePayload(
      secret,
      device.device_id,
      projectId,
      Math.floor(now.getTime() / 1000),
    );
    const deps = {
      key: developmentBadgeKey(),
      loadDevice: async (id: string) =>
        withDb(async (db) => {
          const row = (
            await db.query<{ d: { active: boolean; worker_id: string } }>(
              'select public.edge_badge_device($1) as d',
              [id],
            )
          ).rows[0]?.d;
          return row
            ? {
                active: row.active,
                workerId: row.worker_id,
                ciphertext: new Uint8Array(stored ?? []),
              }
            : null;
        }),
      isApproved: async (workerId: string, project: string) =>
        withDb(
          async (db) =>
            (
              await db.query(
                "select 1 from public.worker_enrollments where worker_id = $1 and project_id = $2 and enrollment_status = 'APPROVED'",
                [workerId, project],
              )
            ).rowCount === 1,
        ),
      redeem: async (project: string, deviceId: string, step: number) =>
        withDb(
          async (db) =>
            (
              await db.query<{ r: 'accepted' | 'duplicate' | 'replay' }>(
                'select public.edge_redeem_badge_step($1, $2, $3, $4, null, null) as r',
                [project, deviceId, step, crypto.randomUUID()],
              )
            ).rows[0]?.r ?? 'replay',
        ),
    };
    expect((await verifyDynamicBadge({ payload, projectId, observedAt: now }, deps)).status).toBe(
      'accepted',
    );
    expect(await verifyDynamicBadge({ payload, projectId, observedAt: now }, deps)).toEqual({
      status: 'rejected',
      reason: 'BADGE_REPLAY',
    });
  });

  it('accepts the printed QR only while the session is open and never approves from it', async () => {
    const { owner, projectId } = await activeProject();
    const staffToken = await tokenOf(owner.client);
    const started = await edge('orientation-session', staffToken, {
      action: 'START',
      project_id: projectId,
      idempotency_key: crypto.randomUUID(),
    });
    const session = OrientationSessionSchema.parse(started.body.session);
    const printed = staticOrientationCode(session.session_id, session.static_code);

    const worker = await workerClient();
    const preview = await worker.rpc('preview_orientation', { p_code: printed, p_locale: 'en-US' });
    expect((preview.data as { project_id: string }).project_id).toBe(projectId);

    const closed = await edge('orientation-session', staffToken, {
      action: 'CLOSE',
      project_id: projectId,
      session_id: session.session_id,
    });
    expect(closed.status).toBe(200);
    const after = await worker.rpc('preview_orientation', { p_code: printed, p_locale: 'en-US' });
    expect((after.data as { error: string }).error).toBe('ORIENTATION_SESSION_CLOSED');

    // A worker cannot start sessions or approve anyone through the Edge Functions.
    const workerToken = await tokenOf(worker);
    expect(
      (
        await edge('orientation-session', workerToken, {
          action: 'START',
          project_id: projectId,
          idempotency_key: crypto.randomUUID(),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await edge('enrollment-bulk-approve', workerToken, {
          project_id: projectId,
          enrollment_ids: [crypto.randomUUID()],
        })
      ).status,
    ).toBe(403);
  });

  it('refuses device activation for someone who never joined a project', async () => {
    const staff = await staffClient(uniqueEmail('no-worker'));
    const result = await edge('device-activate', await tokenOf(staff.client), {
      platform: 'IOS',
      installation_hash: 'f'.repeat(64),
      app_version: '0.1.0',
    });
    expect(result.status).toBe(422);
    expect((result.body.error as { code: string }).code).toBe('WORKER_PROFILE_REQUIRED');
  });
});
