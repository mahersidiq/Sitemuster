import { Client } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

import { DEFAULT_WORK_WINDOWS } from '@sitemuster/shared';

import { SupabaseSiteMusterApi } from '../../src/api/supabase-api';
import { newClient, uniqueEmail, uniquePhone } from './support/clients';
import { latestSmsCode } from './support/db';
import { backendEnv } from './support/env';
import { staffClient } from './support/staff';

/**
 * Review findings on PR #5 (decision #76): two supervisors starting orientation at the same time
 * must leave exactly one open session, and two attendants issuing a printed badge for the same
 * worker at the same time must leave exactly one active badge. Each race uses two real database
 * connections acting as the signed-in organization owner.
 */
const clients: Client[] = [];

async function connect() {
  const client = new Client({ connectionString: backendEnv().dbUrl });
  await client.connect();
  clients.push(client);
  return client;
}

/** A transaction acting as `userId` through the same RLS/role path PostgREST uses. */
async function actingAs(userId: string) {
  const db = await connect();
  await db.query('begin');
  await db.query(
    "select set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)",
    [JSON.stringify({ sub: userId, role: 'authenticated', aal: 'aal2' })],
  );
  return db;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs `sql` in two transactions; the second starts while the first still holds its locks. */
async function race(userId: string, sql: string, params: unknown[]) {
  const first = await actingAs(userId);
  const second = await actingAs(userId);
  await first.query(sql, params);
  const pending = second.query(sql, params).then(
    () => null,
    (error: { code?: string }) => error.code ?? 'unknown',
  );
  await pause(300);
  await first.query('commit');
  const secondError = await pending;
  await second.query(secondError ? 'rollback' : 'commit');
  return secondError;
}

async function activeProjectWithApprovedWorker() {
  const owner = await staffClient(uniqueEmail('race-owner'));
  const api = new SupabaseSiteMusterApi(owner.client);
  const organizationId = await api.createOrganization({
    name: 'Race GC',
    address: '',
    businessEmail: '',
    phone: '',
    idempotencyKey: crypto.randomUUID(),
  });
  const projectId = await api.createProject({
    organizationId,
    name: 'Race Tower',
    projectNumber: '',
    address: '1 Race St',
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
  const ownerId = (await owner.client.auth.getUser()).data.user?.id ?? '';

  // A worker joins with the printed code and is approved.
  const session = (await owner.client.rpc('start_orientation_session', {
    p_project_id: projectId,
    p_idempotency_key: crypto.randomUUID(),
  })) as { data: { session_id: string; static_code: string } };
  const worker = newClient();
  const phone = uniquePhone();
  await worker.auth.signInWithOtp({ phone });
  await worker.auth.verifyOtp({ phone, token: await latestSmsCode(phone), type: 'sms' });
  const preview = await worker.rpc('preview_orientation', {
    p_code: `SMS1.${session.data.session_id}.${session.data.static_code}`,
    p_locale: 'en-US',
  });
  const { join_token: joinToken, notice } = preview.data as {
    join_token: string;
    notice: { id: string };
  };
  const joined = await worker.rpc('complete_orientation', {
    p_join_token: joinToken,
    p_locale: 'en-US',
    p_legal_name: 'Rita Race',
    p_company_id: null,
    p_company_name: 'Race Concrete',
    p_trade: 'Concrete',
    p_emergency_name: 'Ray Race',
    p_emergency_phone: '+15550007777',
    p_emergency_relationship: null,
    p_notice_version_id: notice.id,
    p_accept: true,
  });
  const enrollmentId = (joined.data as { enrollment_id: string }).enrollment_id;
  const approved = await owner.client.rpc('bulk_approve_enrollments', {
    p_project_id: projectId,
    p_enrollment_ids: [enrollmentId],
  });
  expect((approved.data as { result: string }[])[0]?.result).toBe('APPROVED');
  const db = await connect();
  const row = await db.query<{ worker_id: string }>(
    'select worker_id from public.worker_enrollments where id = $1',
    [enrollmentId],
  );
  return { ownerId, projectId, workerId: row.rows[0]?.worker_id ?? '' };
}

describe('orientation and printed-badge races (local stack)', () => {
  afterAll(async () => {
    await Promise.all(clients.map((client) => client.end()));
  });

  it('keeps one open orientation session and one active printed badge under concurrency', async () => {
    const { ownerId, projectId, workerId } = await activeProjectWithApprovedWorker();
    const check = await connect();

    // Two supervisors start orientation at the same moment: the second waits, then replaces.
    expect(
      await race(ownerId, 'select public.start_orientation_session($1, gen_random_uuid())', [
        projectId,
      ]),
    ).toBeNull();
    const open = await check.query<{ n: number }>(
      "select count(*)::int as n from public.orientation_sessions where project_id = $1 and status = 'OPEN'",
      [projectId],
    );
    expect(open.rows[0]?.n).toBe(1);

    // Two attendants issue a printed badge for the same worker at the same moment.
    expect(
      await race(ownerId, 'select public.issue_printed_badge($1, $2)', [projectId, workerId]),
    ).toBeNull();
    const badges = await check.query<{ n: number }>(
      "select count(*)::int as n from public.worker_badges where worker_id = $1 and badge_kind = 'PRINTED' and active",
      [workerId],
    );
    expect(badges.rows[0]?.n).toBe(1);
  });
});
