import { describe, expect, it } from 'vitest';

import { newClient, uniquePhone } from './support/clients';
import { ageOtps, latestSmsCode } from './support/db';

/**
 * Worker phone OTP end-to-end against the real local Auth server with the development SMS
 * capture hook (decision #3: 6 digits, expiry, 60 s resend, single use). Real Twilio delivery is
 * NOT exercised here and stays NOT VERIFIED until the provider is configured.
 */
describe('worker SMS OTP sign-in (local Auth + development SMS hook)', () => {
  it('signs a worker in with a 6-digit code and yields an aal1 session', async () => {
    const supabase = newClient();
    const phone = uniquePhone();
    const request = await supabase.auth.signInWithOtp({ phone });
    expect(request.error).toBeNull();

    const code = await latestSmsCode(phone);
    expect(code).toMatch(/^\d{6}$/);

    const verify = await supabase.auth.verifyOtp({ phone, token: code, type: 'sms' });
    expect(verify.error).toBeNull();
    expect(verify.data.session?.user.phone).toBe(phone.replace('+', ''));

    const access = await supabase.rpc('get_my_access');
    expect(access.error).toBeNull();
    expect(access.data).toMatchObject({
      aal: 'aal1',
      phone_verified: true,
      worker_profile_id: null,
    });
  });

  it('rejects a wrong code without revealing whether the account exists', async () => {
    const supabase = newClient();
    const phone = uniquePhone();
    await supabase.auth.signInWithOtp({ phone });
    const real = await latestSmsCode(phone);
    const wrong = real === '000000' ? '111111' : '000000';
    const verify = await supabase.auth.verifyOtp({ phone, token: wrong, type: 'sms' });
    expect(verify.data.session).toBeNull();
    expect(verify.error?.code).toBe('otp_expired');
  });

  it('enforces the 60-second resend cooldown', async () => {
    const supabase = newClient();
    const phone = uniquePhone();
    expect((await supabase.auth.signInWithOtp({ phone })).error).toBeNull();
    const again = await supabase.auth.signInWithOtp({ phone });
    expect(again.error?.status).toBe(429);
    expect(again.error?.code).toBe('over_sms_send_rate_limit');
  });

  it('rejects an expired code', async () => {
    const supabase = newClient();
    const phone = uniquePhone();
    await supabase.auth.signInWithOtp({ phone });
    const code = await latestSmsCode(phone);
    await ageOtps(phone, '3 hours');
    const verify = await supabase.auth.verifyOtp({ phone, token: code, type: 'sms' });
    expect(verify.data.session).toBeNull();
    expect(verify.error?.code).toBe('otp_expired');
  });

  it('accepts each code only once', async () => {
    const phone = uniquePhone();
    const first = newClient();
    await first.auth.signInWithOtp({ phone });
    const code = await latestSmsCode(phone);
    expect((await first.auth.verifyOtp({ phone, token: code, type: 'sms' })).error).toBeNull();
    const replay = await newClient().auth.verifyOtp({ phone, token: code, type: 'sms' });
    expect(replay.data.session).toBeNull();
    expect(replay.error).not.toBeNull();
  });

  it('keeps a phone-only worker out of staff operations', async () => {
    const supabase = newClient();
    const phone = uniquePhone();
    await supabase.auth.signInWithOtp({ phone });
    await supabase.auth.verifyOtp({ phone, token: await latestSmsCode(phone), type: 'sms' });
    const create = await supabase.rpc('create_organization', {
      p_name: 'Worker Org',
      p_idempotency_key: crypto.randomUUID(),
    });
    expect(create.error?.code).toBe('42501');
  });
});
