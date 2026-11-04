import { describe, expect, it } from 'vitest';

import { AccountDeleteResponseSchema } from '../../../packages/shared/src/api/account.ts';
import {
  type AccountDeleteDeps,
  decodeJwtClaims,
  DeleteRpcError,
  handleAccountDelete,
  sessionFromClaims,
} from './account-delete-core.ts';

const USER = '99999999-9999-4999-8999-999999999999';
const NOW = Date.parse('2026-11-04T15:00:00Z');

function deps(overrides: Partial<AccountDeleteDeps> = {}) {
  const calls: string[] = [];
  const value: AccountDeleteDeps = {
    now: () => NOW,
    requestId: '00000000-0000-4000-8000-000000000001',
    verify: async () => ({ userId: USER, aal: 'aal1', authenticatedAt: NOW / 1000 - 60 }),
    request: async (userId, aal) => {
      calls.push(`request:${userId}:${aal}`);
      return { status: 'REQUESTED', process_after: '2026-11-05T15:00:00Z', duplicate: false };
    },
    signOutEverywhere: async () => {
      calls.push('signOut');
    },
    ...overrides,
  };
  return { value, calls };
}

async function call(d: AccountDeleteDeps, body: unknown, token: string | null = 'Bearer jwt') {
  const response = await handleAccountDelete(
    new Request('https://x.test/functions/v1/account-delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: token } : {}) },
      body: JSON.stringify(body),
    }),
    d,
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const confirm = { schema_version: 1, confirmation: 'DELETE_MY_ACCOUNT' };
const code = (body: Record<string, unknown>) => (body.error as { code: string }).code;

describe('account-delete', () => {
  it('a fresh sign-in deletes: the request is recorded, then every session is signed out', async () => {
    const d = deps();
    const out = await call(d.value, confirm);
    expect(out.status).toBe(200);
    expect(AccountDeleteResponseSchema.parse(out.body)).toMatchObject({
      status: 'REQUESTED',
      duplicate: false,
    });
    expect(d.calls).toEqual([`request:${USER}:aal1`, 'signOut']);
  });

  it('refuses without a sign-in, without the confirmation, or with a sign-in older than 15 minutes', async () => {
    expect((await call(deps().value, confirm, null)).status).toBe(401);
    const wrong = await call(deps().value, { schema_version: 1, confirmation: 'yes' });
    expect([wrong.status, code(wrong.body)]).toEqual([422, 'CONFIRMATION_REQUIRED']);
    const stale = deps({
      verify: async () => ({ userId: USER, aal: 'aal1', authenticatedAt: NOW / 1000 - 16 * 60 }),
    });
    const out = await call(stale.value, confirm);
    expect([out.status, code(out.body)]).toEqual([401, 'REAUTHENTICATION_REQUIRED']);
    expect(stale.calls).toEqual([]);
    const unknown = deps({
      verify: async () => ({ userId: USER, aal: 'aal1', authenticatedAt: null }),
    });
    expect((await call(unknown.value, confirm)).status).toBe(401);
  });

  it('maps database refusals; a failed sign-out never undoes the request', async () => {
    const refuse = (dbCode: string) =>
      deps({
        request: async () => {
          throw new DeleteRpcError(400, dbCode);
        },
      }).value;
    const owner = await call(refuse('ORG_OWNER_TRANSFER_REQUIRED'), confirm);
    expect([owner.status, code(owner.body)]).toEqual([409, 'ORG_OWNER_TRANSFER_REQUIRED']);
    const mfa = await call(refuse('MFA_REQUIRED'), confirm);
    expect([mfa.status, code(mfa.body)]).toEqual([401, 'MFA_REQUIRED']);
    expect((await call(refuse('RATE_LIMITED'), confirm)).status).toBe(429);
    expect((await call(refuse('SOMETHING_ELSE'), confirm)).status).toBe(503);
    const signOutDown = deps({
      signOutEverywhere: async () => {
        throw new Error('auth down');
      },
    });
    expect((await call(signOutDown.value, confirm)).status).toBe(200);
  });

  it('reads aal and the newest sign-in time from verified claims', () => {
    const payload = {
      sub: USER,
      aal: 'aal2',
      amr: [
        { method: 'otp', timestamp: 100 },
        { method: 'totp', timestamp: 250 },
      ],
    };
    const token = `x.${btoa(JSON.stringify(payload)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')}.y`;
    const claims = decodeJwtClaims(token);
    expect(claims?.sub).toBe(USER);
    expect(sessionFromClaims(USER, claims ?? {})).toEqual({
      userId: USER,
      aal: 'aal2',
      authenticatedAt: 250,
    });
    expect(decodeJwtClaims('not-a-token')).toBeNull();
    expect(sessionFromClaims(USER, { aal: 'aal3' })).toEqual({
      userId: USER,
      aal: 'aal1',
      authenticatedAt: null,
    });
  });
});
