import { Client } from 'pg';

import { backendEnv } from './env';

/** Direct superuser access to the LOCAL test database (dev SMS outbox, time travel for expiry). */
export async function withDb<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: backendEnv().dbUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Latest development SMS code captured for a phone number (E.164 with or without +). */
export async function latestSmsCode(phoneE164: string): Promise<string> {
  const digits = phoneE164.replace(/^\+/, '');
  return withDb(async (db) => {
    const result = await db.query<{ otp: string }>(
      'select otp from app_private.dev_sms_outbox where phone = $1 order by id desc limit 1',
      [digits],
    );
    const otp = result.rows[0]?.otp;
    if (!otp) throw new Error('no SMS code captured for this phone');
    return otp;
  });
}

/** Moves every pending OTP for a user into the past so expiry can be tested without waiting. */
export async function ageOtps(userPhoneOrEmail: string, interval: string): Promise<void> {
  const digits = userPhoneOrEmail.replace(/^\+/, '');
  await withDb(async (db) => {
    await db.query(
      `update auth.users
          set confirmation_sent_at = confirmation_sent_at - $2::interval,
              recovery_sent_at = recovery_sent_at - $2::interval
        where phone = $1 or email = $1`,
      [digits.includes('@') ? userPhoneOrEmail : digits, interval],
    );
    await db.query(
      `update auth.one_time_tokens t
          set created_at = t.created_at - $2::interval
         from auth.users u
        where u.id = t.user_id and (u.phone = $1 or u.email = $1)`,
      [digits.includes('@') ? userPhoneOrEmail : digits, interval],
    );
  });
}
