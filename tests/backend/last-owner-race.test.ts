import { Client } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

import { backendEnv } from './support/env';

/**
 * Two transactions revoke the two remaining owners of one organization at the same time. The
 * last-owner trigger locks the organization row, so the second removal waits, re-counts and is
 * refused: the organization always keeps an active owner (review finding on PR #2, decision #76).
 */
const ORG = '88000000-0000-4000-8000-00000000000a';
const OWNER_1 = '88000000-0000-4000-8000-0000000000b1';
const OWNER_2 = '88000000-0000-4000-8000-0000000000b2';

async function connect() {
  const client = new Client({ connectionString: backendEnv().dbUrl });
  await client.connect();
  return client;
}

async function cleanup(db: Client) {
  await db.query('delete from public.organizations where id = $1', [ORG]);
  await db.query('delete from auth.users where id = any($1::uuid[])', [[OWNER_1, OWNER_2]]);
}

describe('last-owner protection under concurrency', () => {
  const clients: Client[] = [];
  afterAll(async () => {
    const db = await connect();
    await cleanup(db);
    await db.end();
    await Promise.all(clients.map((c) => c.end()));
  });

  it('refuses the second of two concurrent owner removals', async () => {
    const setup = await connect();
    await cleanup(setup);
    for (const [id, email] of [
      [OWNER_1, 'race-owner-1@example.test'],
      [OWNER_2, 'race-owner-2@example.test'],
    ] as const) {
      await setup.query(
        `insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
         values ('00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated', $2, now(), '{}', '{}', now(), now())`,
        [id, email],
      );
    }
    await setup.query(
      'insert into public.organizations (id, name, owner_user_id, idempotency_key) values ($1, $2, $3, gen_random_uuid())',
      [ORG, 'Race GC', OWNER_1],
    );
    await setup.query(
      `insert into public.organization_members (organization_id, user_id, role) values ($1, $2, 'OWNER'), ($1, $3, 'OWNER')`,
      [ORG, OWNER_1, OWNER_2],
    );
    await setup.end();

    const first = await connect();
    const second = await connect();
    clients.push(first, second);
    const revoke = (db: Client, user: string) =>
      db.query(
        `update public.organization_members set membership_status = 'REVOKED', revoked_at = now()
          where organization_id = $1 and user_id = $2`,
        [ORG, user],
      );

    await first.query('begin');
    await revoke(first, OWNER_1);
    await second.query('begin');
    // The second removal blocks on the organization lock held by the first transaction.
    const pending = revoke(second, OWNER_2).then(
      () => null,
      (error: { code?: string }) => error.code ?? 'unknown',
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    await first.query('commit');
    expect(await pending).toBe('23514');
    await second.query('rollback');

    const check = await connect();
    clients.push(check);
    const owners = await check.query(
      `select count(*)::int as n from public.organization_members
        where organization_id = $1 and role = 'OWNER' and membership_status = 'ACTIVE'`,
      [ORG],
    );
    expect(owners.rows[0]?.n).toBe(1);
  });
});
