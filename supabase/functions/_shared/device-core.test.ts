import { describe, expect, it } from 'vitest';

import { DeviceActivateResponseSchema } from '../../../packages/shared/src/api/orientation.ts';
import { base64UrlDecode } from '../../../packages/shared/src/crypto/encoding.ts';
import { decryptBadgeSecret, developmentBadgeKey } from './badge-crypto.ts';
import { handleDeviceActivate, type DeviceDeps } from './device-core.ts';

const USER = '11111111-1111-4111-8111-111111111111';
const DEVICE = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

function request(body: unknown, authorization = 'Bearer worker-jwt') {
  return new Request('http://edge/device-activate', {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const valid = { platform: 'IOS', installation_hash: 'a'.repeat(64), app_version: '0.1.0' };

function deps(overrides: Partial<DeviceDeps> = {}) {
  const calls: Record<string, unknown>[] = [];
  let counter = 0;
  const d: DeviceDeps = {
    environment: 'development',
    badgeKey: null,
    userId: async () => USER,
    activate: async (args) => {
      calls.push(args);
      return {
        ok: true,
        data: { replaced_device_id: null, upload_expires_at: '2026-12-04T00:00:00Z' },
      };
    },
    randomBytes: (n) => new Uint8Array(n).fill(++counter),
    newDeviceId: () => DEVICE,
    ...overrides,
  };
  return { d, calls };
}

describe('device-activate', () => {
  it('returns the badge secret and upload token once and stores only ciphertext and a hash', async () => {
    const { d, calls } = deps();
    const response = await handleDeviceActivate(request(valid), d);
    expect(response.status).toBe(200);
    const body = DeviceActivateResponseSchema.parse(await response.json());
    expect(body.device_id).toBe(DEVICE);
    const stored = calls[0] as {
      p_user_id: string;
      p_secret_ciphertext: string;
      p_upload_token_hash: string;
    };
    expect(stored.p_user_id).toBe(USER);
    const blob = Uint8Array.from(Buffer.from(stored.p_secret_ciphertext.slice(2), 'hex'));
    const secret = await decryptBadgeSecret(developmentBadgeKey(), blob, DEVICE);
    expect(secret).toEqual(base64UrlDecode(body.badge_secret));
    expect(stored.p_secret_ciphertext).not.toContain(Buffer.from(secret).toString('hex'));
    expect(stored.p_upload_token_hash).toMatch(/^\\x[0-9a-f]{64}$/);
  });

  it('fails closed without a key outside development and refuses unauthenticated callers', async () => {
    expect(
      (await handleDeviceActivate(request(valid), deps({ environment: 'production' }).d)).status,
    ).toBe(503);
    expect((await handleDeviceActivate(request(valid, ''), deps().d)).status).toBe(401);
    expect(
      (await handleDeviceActivate(request(valid), deps({ userId: async () => null }).d)).status,
    ).toBe(401);
  });

  it('validates input and maps database refusals', async () => {
    expect(
      (await handleDeviceActivate(request({ ...valid, platform: 'WEB' }), deps().d)).status,
    ).toBe(422);
    const noProfile = deps({
      activate: async () => ({ ok: false, status: 400, code: 'WORKER_PROFILE_REQUIRED' }),
    });
    const response = await handleDeviceActivate(request(valid), noProfile.d);
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'WORKER_PROFILE_REQUIRED',
    );
    const limited = deps({
      activate: async () => ({ ok: false, status: 400, code: 'RATE_LIMITED' }),
    });
    const tooMany = await handleDeviceActivate(request(valid), limited.d);
    expect(tooMany.status).toBe(429);
    expect(((await tooMany.json()) as { error: { code: string } }).error.code).toBe('RATE_LIMITED');
    // Account deletion requested (or an operator account): refused, nothing issued.
    const refused = deps({ activate: async () => ({ ok: false, status: 403, code: 'FORBIDDEN' }) });
    const forbidden = await handleDeviceActivate(request(valid), refused.d);
    expect(forbidden.status).toBe(403);
    expect(JSON.stringify(await forbidden.json())).not.toContain('upload_token');
  });

  it("flags the worker's active sessions for review when a phone is replaced (decision #27)", async () => {
    const flagged: unknown[] = [];
    const { d } = deps({
      activate: async () => ({
        ok: true,
        data: {
          replaced_device_id: '00000000-0000-4000-8000-0000000000d0',
          worker_id: '4a000000-0000-4000-8000-0000000000a1',
          upload_expires_at: '2026-12-04T00:00:00Z',
        },
      }),
      openSessionProjects: async () => ['0a000000-0000-4000-8000-0000000000a1'],
      flagReplacement: async (evidence) => {
        flagged.push(...evidence);
      },
      now: () => Date.parse('2026-11-04T15:00:00Z'),
    });
    const response = await handleDeviceActivate(request(valid), d);
    expect(response.status).toBe(200);
    expect(flagged).toEqual([
      expect.objectContaining({
        kind: 'MONITORING',
        change: 'REPLACED',
        reason: 'DEVICE_REPLACED',
        projectId: '0a000000-0000-4000-8000-0000000000a1',
        workerId: '4a000000-0000-4000-8000-0000000000a1',
        deviceId: DEVICE,
        observedAt: '2026-11-04T15:00:00Z',
      }),
    ]);
  });

  it('keeps a committed activation successful when the review flag cannot be applied (retried, logged)', async () => {
    let attempts = 0;
    const logs: Record<string, unknown>[] = [];
    const { d } = deps({
      activate: async () => ({
        ok: true,
        data: {
          replaced_device_id: '00000000-0000-4000-8000-0000000000d0',
          worker_id: '4a000000-0000-4000-8000-0000000000a1',
          upload_expires_at: '2026-12-04T00:00:00Z',
        },
      }),
      openSessionProjects: async () => ['0a000000-0000-4000-8000-0000000000a1'],
      flagReplacement: async () => {
        attempts += 1;
        throw new Error('database unavailable');
      },
      log: (entry) => logs.push(entry),
    });
    const response = await handleDeviceActivate(request(valid), d);
    expect(response.status).toBe(200);
    expect(attempts).toBe(3);
    expect(logs.at(-1)).toMatchObject({ outcome: 'replacement_review_failed' });
  });
});
