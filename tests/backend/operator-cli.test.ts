import { describe, expect, it } from 'vitest';

import { runOperator } from '../../scripts/operator/operator.mts';
import { newClient, uniqueEmail } from './support/clients';
import { ageOtps, withDb } from './support/db';
import { latestEmailCode } from './support/mailpit';
import { scalar } from './support/operations';
import { totp } from './support/totp';

/**
 * The operator CLI end to end against the local stack (real Auth, MFA and RPCs): the operator
 * signs in with an e-mail code and their authenticator, runs one audited command, signs out.
 */
describe('operator CLI (local stack)', () => {
  it('runs an audited command after e-mail code + authenticator; a non-operator is refused', async () => {
    const email = uniqueEmail('m12-cli');
    const setup = newClient();
    await setup.auth.signInWithOtp({ email });
    await setup.auth.verifyOtp({ email, token: await latestEmailCode(email), type: 'email' });
    const userId = (await setup.auth.getUser()).data.user?.id ?? '';
    const enrolled = await setup.auth.mfa.enroll({ factorType: 'totp' });
    const secret = enrolled.data?.totp.secret ?? '';
    const factorId = enrolled.data?.id ?? '';
    const challenge = await setup.auth.mfa.challenge({ factorId });
    await setup.auth.mfa.verify({
      factorId,
      challengeId: challenge.data?.id ?? '',
      code: totp(secret),
    });

    const run = async (argv: string[]) => {
      await ageOtps(email, '2 minutes'); // the 60-second resend cooldown of the previous code
      const printed: string[] = [];
      let asked = 0;
      const code = await runOperator(argv, {
        client: newClient(),
        email,
        io: {
          prompt: async () => {
            asked += 1;
            return asked === 1 ? latestEmailCode(email) : totp(secret, Date.now() + 30_000);
          },
          print: (line) => printed.push(line),
        },
      });
      return { code, output: printed.join('\n') };
    };

    const refused = await run(['health', '--reason', 'weekly health review']);
    expect(refused.code).toBe(1);
    expect(refused.output).toContain('FORBIDDEN');

    await withDb((db) =>
      db.query('insert into app_private.platform_operators (user_id) values ($1)', [userId]),
    );
    const ok = await run(['health', '--reason', 'weekly health review']);
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.output)).toHaveProperty('jobs');
    expect(
      await scalar<number>(
        "select count(*)::int as v from app_private.platform_operator_actions where platform_user_id = $1 and reason = 'weekly health review'",
        [userId],
      ),
    ).toBe(1);
  });
});
