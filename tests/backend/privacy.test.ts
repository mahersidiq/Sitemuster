import { describe, expect, it } from 'vitest';

import { AccountDeleteResponseSchema, DeviceActivateResponseSchema } from '@sitemuster/shared';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { newClient, uniqueEmail, uniquePhone } from './support/clients';
import { latestSmsCode, withDb } from './support/db';
import { backendEnv } from './support/env';
import { latestEmailCode } from './support/mailpit';
import { enroll, fn, scalar, site } from './support/operations';
import { totp } from './support/totp';

/**
 * Milestone 12 end to end on the local stack (real Auth, PostgREST and Edge Functions): in-app
 * account deletion revokes everything at once and removes the identity later; someone with an
 * authenticator must use it to delete; the platform operator RPCs need MFA (decisions #126–#130).
 */
const CONFIRM = { schema_version: 1, confirmation: 'DELETE_MY_ACCOUNT' };

/**
 * A staff member with a verified authenticator (aal2 client), plus the access token from the same
 * sign-in BEFORE the authenticator step (aal1, still valid): one e-mail code serves both.
 */
async function staffWithWeakToken(email: string) {
  const client = newClient();
  await client.auth.signInWithOtp({ email });
  await client.auth.verifyOtp({ email, token: await latestEmailCode(email), type: 'email' });
  const aal1Token = (await client.auth.getSession()).data.session?.access_token ?? '';
  const enrolled = await client.auth.mfa.enroll({ factorType: 'totp' });
  const factorId = enrolled.data?.id ?? '';
  const challenge = await client.auth.mfa.challenge({ factorId });
  const verified = await client.auth.mfa.verify({
    factorId,
    challengeId: challenge.data?.id ?? '',
    code: totp(enrolled.data?.totp.secret ?? ''),
  });
  expect(verified.error).toBeNull();
  return { client, aal1Token };
}

function clientWithToken(token: string): SupabaseClient {
  const { apiUrl, anonKey } = backendEnv();
  return createClient(apiUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

async function deleteAccount(jwt: string) {
  const response = await fetch(fn('account-delete'), {
    method: 'POST',
    headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
    body: JSON.stringify(CONFIRM),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe('account deletion (local stack, real Edge Function)', () => {
  it('a worker deletes their account: the phone, the session and the data access stop at once', async () => {
    const { projectId, companyId } = await site();
    const client = newClient();
    const phone = uniquePhone();
    await client.auth.signInWithOtp({ phone });
    await client.auth.verifyOtp({ phone, token: await latestSmsCode(phone), type: 'sms' });
    const session = (await client.auth.getSession()).data.session;
    const jwt = session?.access_token ?? '';
    const userId = session?.user.id ?? '';
    const workerId = await enroll(projectId, { userId, companyId, name: 'Deleting Worker' });
    const activated = await fetch(fn('device-activate'), {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        platform: 'IOS',
        installation_hash: crypto.randomUUID().replace(/-/g, '').padEnd(64, 'd'),
        app_version: '0.12.0',
      }),
    });
    expect(activated.status).toBe(200);
    const device = DeviceActivateResponseSchema.parse(await activated.json());

    const out = await deleteAccount(jwt);
    expect(out.status).toBe(200);
    expect(AccountDeleteResponseSchema.parse(out.body)).toMatchObject({
      status: 'REQUESTED',
      duplicate: false,
    });

    // The phone's upload credential is refused at once.
    const upload = await fetch(fn('ingest-location-batch'), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${device.upload_token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ locations: [] }),
    });
    expect(upload.status).toBe(401);
    // The still-valid access token reads nothing; the refresh token was revoked everywhere.
    const plan = await client.rpc('my_tracking_plan', {});
    expect(plan.error?.message).toContain('WORKER_PROFILE_REQUIRED');
    expect((await client.auth.refreshSession()).error).not.toBeNull();

    // Identity removal after the 24-hour window (the hourly job, run here with a later clock).
    await withDb((db) =>
      db.query("select app_private.process_account_deletions(now() + interval '25 hours')"),
    );
    expect(
      await scalar<number>('select count(*)::int as v from auth.users where id = $1', [userId]),
    ).toBe(0);
    expect(
      await scalar<string>('select legal_name as v from public.worker_profiles where id = $1', [
        workerId,
      ]),
    ).toMatch(/^Deleted worker #[0-9a-f]{8}$/);
  });

  it('a sign-in that skipped the authenticator cannot delete a staff account; with it, it can', async () => {
    const { client, aal1Token } = await staffWithWeakToken(uniqueEmail('m12-staff'));
    const weak = await deleteAccount(aal1Token);
    expect([weak.status, (weak.body.error as { code: string }).code]).toEqual([
      401,
      'MFA_REQUIRED',
    ]);
    const strong = await deleteAccount(
      (await client.auth.getSession()).data.session?.access_token ?? '',
    );
    expect(strong.status).toBe(200);
  });
});

describe('platform operator RPCs (local stack)', () => {
  it('need an operator with MFA and a reason; the call is audited', async () => {
    const { client, aal1Token } = await staffWithWeakToken(uniqueEmail('m12-operator'));
    const userId = (await client.auth.getUser()).data.user?.id ?? '';
    const before = await client.rpc('operator_health', { p_reason: 'weekly health review' });
    expect(before.error?.message).toContain('FORBIDDEN');
    await withDb((db) =>
      db.query('insert into app_private.platform_operators (user_id) values ($1)', [userId]),
    );
    const health = await client.rpc('operator_health', { p_reason: 'weekly health review' });
    expect(health.error).toBeNull();
    expect(Object.keys(health.data as object)).toEqual(
      expect.arrayContaining(['jobs', 'location_receipts_last_hour', 'account_deletions']),
    );
    expect(
      await scalar<number>(
        "select count(*)::int as v from app_private.platform_operator_actions where platform_user_id = $1 and action = 'HEALTH_CHECK'",
        [userId],
      ),
    ).toBe(1);
    // The same operator's token from before the authenticator step is refused.
    const weak = await clientWithToken(aal1Token).rpc('operator_health', {
      p_reason: 'weekly health review',
    });
    expect(weak.error?.message).toContain('FORBIDDEN');
  });
});
