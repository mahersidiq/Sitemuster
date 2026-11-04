import { sha256 } from '@noble/hashes/sha2.js';
import { describe, expect, it } from 'vitest';

import { DeviceRenewResponseSchema } from '../../../packages/shared/src/api/orientation.ts';
import { base64UrlEncode } from '../../../packages/shared/src/crypto/encoding.ts';
import { toPgHex } from './badge-crypto.ts';
import type { RpcResult } from './postgrest.ts';
import { handleDeviceRenew, type RenewDeps } from './renew-core.ts';

const DEVICE = '5d000000-0000-4000-8000-0000000000a1';
const USER = 'c1000000-0000-4000-8000-000000000001';
const SECRET_BYTES = new Uint8Array(32).fill(3);
const SECRET = base64UrlEncode(SECRET_BYTES);
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl';

function deps(result: RpcResult = okResult(), overrides: Partial<RenewDeps> = {}) {
  const calls: Parameters<RenewDeps['renew']>[0][] = [];
  const sessions: string[] = [];
  const d: RenewDeps = {
    userId: async (authorization) => {
      sessions.push(authorization);
      return authorization === `Bearer ${JWT}` ? USER : null;
    },
    renew: async (args) => {
      calls.push(args);
      return result;
    },
    randomBytes: (n) => new Uint8Array(n).fill(9),
    ...overrides,
  };
  return { d, calls, sessions };
}

function okResult(): RpcResult {
  return {
    ok: true,
    data: {
      status: 'OK',
      device_id: DEVICE,
      expires_at: '2026-12-04T15:00:00+00:00',
      renew_after: '2026-11-27T15:00:00+00:00',
    },
  };
}

const json = (body: unknown, authorization?: string) =>
  new Request('http://edge/device-renew', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(authorization ? { authorization } : {}),
    },
    body: JSON.stringify(body),
  });

describe('device-renew', () => {
  it('rotates with the current secret (app, JSON) and returns the new one under SDK names too', async () => {
    const { d, calls } = deps();
    const response = await handleDeviceRenew(json({ app_version: '0.3.2' }, `Bearer ${SECRET}`), d);
    expect(response.status).toBe(200);
    const body = DeviceRenewResponseSchema.parse(await response.json());
    const fresh = base64UrlEncode(new Uint8Array(32).fill(9));
    expect(body).toMatchObject({
      device_id: DEVICE,
      upload_token: fresh,
      access_token: fresh,
      refresh_token: fresh,
      expires: Math.floor(Date.parse('2026-11-27T15:00:00Z') / 1000),
    });
    expect(calls).toEqual([
      {
        p_token_hash: toPgHex(sha256(SECRET_BYTES)),
        p_user_id: null,
        p_new_token_hash: toPgHex(sha256(new Uint8Array(32).fill(9))),
        p_app_version: '0.3.2',
      },
    ]);
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });

  it('accepts the SDK authorization refresh as a urlencoded or multipart FORM POST', async () => {
    for (const body of [
      new URLSearchParams({ refresh_token: SECRET }),
      (() => {
        const form = new globalThis.FormData();
        form.set('refresh_token', SECRET);
        return form as unknown as BodyInit;
      })(),
    ]) {
      const { d, calls } = deps();
      const request = new Request('http://edge/device-renew', {
        method: 'POST',
        headers: { authorization: `Bearer ${SECRET}` },
        body: body as BodyInit,
      });
      const response = await handleDeviceRenew(request, d);
      expect(response.status).toBe(200);
      expect(calls[0]?.p_token_hash).toBe(toPgHex(sha256(SECRET_BYTES)));
    }
  });

  it('renews with the signed-in worker session (Auth server confirms the user)', async () => {
    const { d, calls, sessions } = deps();
    const response = await handleDeviceRenew(json({}, `Bearer ${JWT}`), d);
    expect(response.status).toBe(200);
    expect(sessions).toEqual([`Bearer ${JWT}`]);
    expect(calls[0]).toMatchObject({ p_token_hash: null, p_user_id: USER });
  });

  it('refuses missing or unconfirmed credentials', async () => {
    const { d, calls } = deps();
    expect((await handleDeviceRenew(json({}), d)).status).toBe(401);
    expect((await handleDeviceRenew(json({}, 'Bearer not.a.valid-session'), d)).status).toBe(401);
    const form = new Request('http://edge/device-renew', {
      method: 'POST',
      body: new URLSearchParams({ refresh_token: 'short' }),
    });
    expect((await handleDeviceRenew(form, d)).status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('maps database refusals to explicit codes (fail closed, no new secret)', async () => {
    const cases: [string, number, string][] = [
      ['EXPIRED', 401, 'CREDENTIAL_EXPIRED'],
      ['REVOKED', 401, 'DEVICE_REVOKED'],
      ['SUPERSEDED', 401, 'CREDENTIAL_SUPERSEDED'],
      ['INVALID', 401, 'UNAUTHENTICATED'],
      ['NO_DEVICE', 404, 'NO_DEVICE'],
      ['RATE_LIMITED', 429, 'RATE_LIMITED'],
    ];
    for (const [status, http, code] of cases) {
      const { d } = deps({ ok: true, data: { status } });
      const response = await handleDeviceRenew(json({}, `Bearer ${SECRET}`), d);
      expect(response.status).toBe(http);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ error: { code } });
      expect(body).not.toHaveProperty('upload_token');
    }
  });

  it('answers 503 when the database is unavailable', async () => {
    const { d } = deps({ ok: false, status: 503, code: null });
    expect((await handleDeviceRenew(json({}, `Bearer ${SECRET}`), d)).status).toBe(503);
  });

  it('enforces method, media type, size and a strict body', async () => {
    const { d } = deps();
    expect(
      (await handleDeviceRenew(new Request('http://edge/x', { method: 'GET' }), d)).status,
    ).toBe(405);
    const text = new Request('http://edge/x', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', authorization: `Bearer ${SECRET}` },
      body: 'x',
    });
    expect((await handleDeviceRenew(text, d)).status).toBe(415);
    expect(
      (await handleDeviceRenew(json({ app_version: '1', worker_id: USER }, `Bearer ${SECRET}`), d))
        .status,
    ).toBe(422);
    const big = json({ app_version: 'x'.repeat(5000) }, `Bearer ${SECRET}`);
    expect((await handleDeviceRenew(big, d)).status).toBe(413);
  });
});
