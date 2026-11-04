import { describe, expect, it } from 'vitest';

import { newClient, uniqueEmail } from './support/clients';
import { latestEmailCode } from './support/mailpit';
import { totp } from './support/totp';

/**
 * Staff passwordless email code + mandatory TOTP MFA end-to-end against the real local Auth
 * server (decision #3). Emails are captured by the local Mailpit server.
 */
describe('staff email code + TOTP MFA', () => {
  it('enrolls an authenticator, reaches aal2 and only then performs privileged actions', async () => {
    const supabase = newClient();
    const email = uniqueEmail('staff');

    expect((await supabase.auth.signInWithOtp({ email })).error).toBeNull();
    const emailCode = await latestEmailCode(email);
    const verified = await supabase.auth.verifyOtp({ email, token: emailCode, type: 'email' });
    expect(verified.error).toBeNull();
    expect(verified.data.user?.email_confirmed_at).toBeTruthy();

    // aal1: email proven, MFA not yet — privileged staff RPCs are refused.
    const denied = await supabase.rpc('create_organization', {
      p_name: 'Too Early LLC',
      p_idempotency_key: crypto.randomUUID(),
    });
    expect(denied.error?.code).toBe('42501');

    const enroll = await supabase.auth.mfa.enroll({
      factorType: 'totp',
      friendlyName: 'Primary authenticator',
    });
    expect(enroll.error).toBeNull();
    const secret = enroll.data?.totp.secret ?? '';
    expect(enroll.data?.totp.uri).toMatch(/^otpauth:\/\/totp\//);

    const challenge = await supabase.auth.mfa.challenge({ factorId: enroll.data?.id ?? '' });
    expect(challenge.error).toBeNull();
    const wrong = await supabase.auth.mfa.verify({
      factorId: enroll.data?.id ?? '',
      challengeId: challenge.data?.id ?? '',
      code: totp(secret) === '000000' ? '111111' : '000000',
    });
    expect(wrong.error).not.toBeNull();

    const challenge2 = await supabase.auth.mfa.challenge({ factorId: enroll.data?.id ?? '' });
    const ok = await supabase.auth.mfa.verify({
      factorId: enroll.data?.id ?? '',
      challengeId: challenge2.data?.id ?? '',
      code: totp(secret),
    });
    expect(ok.error).toBeNull();

    const level = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    expect(level.data?.currentLevel).toBe('aal2');

    const created = await supabase.rpc('create_organization', {
      p_name: 'MFA Builders LLC',
      p_idempotency_key: crypto.randomUUID(),
    });
    expect(created.error).toBeNull();
    const orgs = await supabase.from('organizations').select('id, name');
    expect(orgs.data).toEqual([{ id: created.data, name: 'MFA Builders LLC' }]);

    // Next sign-in: email code gives aal1 and requires the TOTP challenge again.
    await supabase.auth.signOut();
    const again = newClient();
    await new Promise((resolve) => setTimeout(resolve, 61_000));
    expect((await again.auth.signInWithOtp({ email })).error).toBeNull();
    await again.auth.verifyOtp({ email, token: await latestEmailCode(email), type: 'email' });
    const before = await again.auth.mfa.getAuthenticatorAssuranceLevel();
    expect(before.data).toMatchObject({ currentLevel: 'aal1', nextLevel: 'aal2' });
    const hidden = await again.from('organizations').select('id');
    expect(hidden.data).toEqual([]);

    const factors = await again.auth.mfa.listFactors();
    const factorId = factors.data?.totp[0]?.id ?? '';
    const c3 = await again.auth.mfa.challenge({ factorId });
    expect(
      (
        await again.auth.mfa.verify({
          factorId,
          challengeId: c3.data?.id ?? '',
          code: totp(secret),
        })
      ).error,
    ).toBeNull();
    const visible = await again.from('organizations').select('id');
    expect(visible.data).toHaveLength(1);
  }, 120_000);

  it('enforces the 60-second resend cooldown for staff email codes', async () => {
    const supabase = newClient();
    const email = uniqueEmail('cooldown');
    expect((await supabase.auth.signInWithOtp({ email })).error).toBeNull();
    const again = await supabase.auth.signInWithOtp({ email });
    expect(again.error?.status).toBe(429);
  });
});
