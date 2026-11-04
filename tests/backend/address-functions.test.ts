import { describe, expect, it } from 'vitest';

import { AddressResolveResponseSchema, AddressSearchResponseSchema } from '@sitemuster/shared';

import { newClient, uniqueEmail, uniquePhone } from './support/clients';
import { latestSmsCode } from './support/db';
import { backendEnv } from './support/env';
import { latestEmailCode } from './support/mailpit';
import { totp } from './support/totp';

/**
 * address-search / address-resolve running in the real local Edge runtime (Deno), authorized
 * through the database with the caller's own JWT. Locally no Google key exists, so the labelled
 * development fake answers; hosted environments fail closed without keys (unit-tested).
 */
async function staffSession() {
  const supabase = newClient();
  const email = uniqueEmail('address');
  await supabase.auth.signInWithOtp({ email });
  await supabase.auth.verifyOtp({ email, token: await latestEmailCode(email), type: 'email' });
  const enroll = await supabase.auth.mfa.enroll({ factorType: 'totp' });
  const factorId = enroll.data?.id ?? '';
  const challenge = await supabase.auth.mfa.challenge({ factorId });
  await supabase.auth.mfa.verify({
    factorId,
    challengeId: challenge.data?.id ?? '',
    code: totp(enroll.data?.totp.secret ?? ''),
  });
  const org = await supabase.rpc('create_organization', {
    p_name: 'Address GC',
    p_idempotency_key: crypto.randomUUID(),
  });
  expect(org.error).toBeNull();
  const token = (await supabase.auth.getSession()).data.session?.access_token ?? '';
  return token;
}

async function call(fn: string, token: string, body: unknown) {
  const response = await fetch(`${backendEnv().apiUrl}/functions/v1/${fn}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as unknown };
}

describe('address Edge Functions (local runtime)', () => {
  it('serves an MFA staff member and returns schema-valid results', async () => {
    const token = await staffSession();
    const search = await call('address-search', token, {
      query: '100 Main',
      session_token: 'session-abc1',
      locale: 'en-US',
    });
    expect(search.status).toBe(200);
    const parsed = AddressSearchResponseSchema.parse(search.body);
    expect(parsed.provider).toBe('development_fake');
    const first = parsed.candidates[0];
    const resolved = await call('address-resolve', token, {
      place_id: first?.place_id,
      session_token: 'session-abc1',
      locale: 'en-US',
    });
    expect(resolved.status).toBe(200);
    expect(AddressResolveResponseSchema.parse(resolved.body).attribution).toContain('Development');
  });

  it('refuses a worker session', async () => {
    const supabase = newClient();
    const phone = uniquePhone();
    await supabase.auth.signInWithOtp({ phone });
    await supabase.auth.verifyOtp({ phone, token: await latestSmsCode(phone), type: 'sms' });
    const token = (await supabase.auth.getSession()).data.session?.access_token ?? '';
    const result = await call('address-search', token, {
      query: '100 Main',
      session_token: 'session-abc1',
      locale: 'en-US',
    });
    expect(result.status).toBe(403);
  });

  it('rejects requests without a valid JWT at the gateway', async () => {
    const response = await fetch(`${backendEnv().apiUrl}/functions/v1/address-search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer not-a-jwt' },
      body: '{}',
    });
    expect(response.status).toBe(401);
  });
});
