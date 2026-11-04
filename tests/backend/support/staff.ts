import type { SupabaseClient } from '@supabase/supabase-js';
import { expect } from 'vitest';

import { newClient, uniqueEmail } from './clients';
import { latestEmailCode } from './mailpit';
import { totp } from './totp';

/** Signs a staff member in with an e-mail code and enrolls + verifies TOTP (aal2). */
export async function staffClient(
  email: string = uniqueEmail('staff'),
): Promise<{ client: SupabaseClient; email: string }> {
  const client = newClient();
  expect((await client.auth.signInWithOtp({ email })).error).toBeNull();
  const verified = await client.auth.verifyOtp({
    email,
    token: await latestEmailCode(email),
    type: 'email',
  });
  expect(verified.error).toBeNull();
  const enroll = await client.auth.mfa.enroll({ factorType: 'totp' });
  expect(enroll.error).toBeNull();
  const factorId = enroll.data?.id ?? '';
  const challenge = await client.auth.mfa.challenge({ factorId });
  const mfa = await client.auth.mfa.verify({
    factorId,
    challengeId: challenge.data?.id ?? '',
    code: totp(enroll.data?.totp.secret ?? ''),
  });
  expect(mfa.error).toBeNull();
  return { client, email };
}
