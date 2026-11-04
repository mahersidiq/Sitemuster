import { describe, expect, it } from 'vitest';

import { buildBadgePayload } from '../../../packages/shared/src/api/badge.ts';
import { verifyDynamicBadge, type BadgeDeps } from './badge-core.ts';
import {
  developmentBadgeKey,
  encryptBadgeSecret,
  parseBadgeKey,
  resolveBadgeKey,
} from './badge-crypto.ts';

const DEVICE = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const PROJECT = '16fd2706-8baf-433b-82eb-8c7fada847da';
const OTHER_PROJECT = '0f8fad5b-d9cb-469f-a165-70867728950e';
const WORKER = '22222222-2222-4222-8222-222222222222';
const KEY = new Uint8Array(32).fill(9);
const SECRET = new Uint8Array(32).map((_, i) => i + 1);
const NOW = new Date('2026-11-04T14:00:10Z');

async function deps(
  overrides: Partial<BadgeDeps> = {},
): Promise<BadgeDeps & { redeemed: string[] }> {
  const ciphertext = await encryptBadgeSecret(KEY, SECRET, DEVICE);
  const redeemed: string[] = [];
  return {
    key: KEY,
    loadDevice: async (id) =>
      id === DEVICE ? { active: true, workerId: WORKER, ciphertext } : null,
    isApproved: async () => true,
    redeem: async (project, device, step) => {
      const key = `${project}|${device}|${step}`;
      if (redeemed.includes(key)) return 'replay';
      redeemed.push(key);
      return 'accepted';
    },
    redeemed,
    ...overrides,
  };
}

const payload = (at = NOW, secret = SECRET) =>
  buildBadgePayload(secret, DEVICE, PROJECT, Math.floor(at.getTime() / 1000));

describe('offline badge verification (server side)', () => {
  it('accepts a badge generated offline on the worker phone, once', async () => {
    const d = await deps();
    expect(
      await verifyDynamicBadge({ payload: payload(), projectId: PROJECT, observedAt: NOW }, d),
    ).toMatchObject({
      status: 'accepted',
      workerId: WORKER,
    });
    expect(
      await verifyDynamicBadge({ payload: payload(), projectId: PROJECT, observedAt: NOW }, d),
    ).toEqual({
      status: 'rejected',
      reason: 'BADGE_REPLAY',
    });
  });

  it('accepts the neighbouring step (kiosk clock) but not older badges', async () => {
    const d = await deps();
    const later = new Date(NOW.getTime() + 30_000);
    expect(
      (await verifyDynamicBadge({ payload: payload(), projectId: PROJECT, observedAt: later }, d))
        .status,
    ).toBe('accepted');
    const muchLater = new Date(NOW.getTime() + 90_000);
    expect(
      await verifyDynamicBadge(
        { payload: payload(), projectId: PROJECT, observedAt: muchLater },
        d,
      ),
    ).toEqual({
      status: 'rejected',
      reason: 'BADGE_EXPIRED',
    });
  });

  it('rejects other projects, revoked devices, forged secrets and unapproved workers', async () => {
    expect(
      await verifyDynamicBadge(
        { payload: payload(), projectId: OTHER_PROJECT, observedAt: NOW },
        await deps(),
      ),
    ).toEqual({ status: 'rejected', reason: 'BADGE_PROJECT_MISMATCH' });
    expect(
      await verifyDynamicBadge(
        { payload: payload(), projectId: PROJECT, observedAt: NOW },
        await deps({
          loadDevice: async () => ({
            active: false,
            workerId: WORKER,
            ciphertext: new Uint8Array(40),
          }),
        }),
      ),
    ).toEqual({ status: 'rejected', reason: 'DEVICE_REVOKED' });
    expect(
      await verifyDynamicBadge(
        { payload: payload(NOW, new Uint8Array(32).fill(1)), projectId: PROJECT, observedAt: NOW },
        await deps(),
      ),
    ).toEqual({ status: 'rejected', reason: 'BADGE_MAC_INVALID' });
    expect(
      await verifyDynamicBadge(
        { payload: payload(), projectId: PROJECT, observedAt: NOW },
        await deps({ isApproved: async () => false }),
      ),
    ).toEqual({ status: 'rejected', reason: 'NOT_APPROVED' });
    expect(
      await verifyDynamicBadge(
        { payload: 'SMP1.printed', projectId: PROJECT, observedAt: NOW },
        await deps(),
      ),
    ).toEqual({ status: 'rejected', reason: 'BADGE_INVALID' });
  });

  it('binds the encrypted secret to its device (a swapped ciphertext does not verify)', async () => {
    const otherDeviceBlob = await encryptBadgeSecret(
      KEY,
      SECRET,
      '11111111-1111-4111-8111-111111111111',
    );
    const d = await deps({
      loadDevice: async () => ({ active: true, workerId: WORKER, ciphertext: otherDeviceBlob }),
    });
    expect(
      await verifyDynamicBadge({ payload: payload(), projectId: PROJECT, observedAt: NOW }, d),
    ).toEqual({
      status: 'rejected',
      reason: 'BADGE_MAC_INVALID',
    });
  });
});

describe('badge secret key configuration (fails closed)', () => {
  it('uses the development key only in development', () => {
    expect(resolveBadgeKey('development', null)).toMatchObject({ ok: true });
    expect(resolveBadgeKey('staging', null)).toEqual({ ok: false, reason: 'MISSING' });
    expect(resolveBadgeKey('production', '')).toEqual({ ok: false, reason: 'MISSING' });
  });

  it('refuses the development key and malformed keys outside development', () => {
    const devKey = Buffer.from(developmentBadgeKey()).toString('base64');
    expect(resolveBadgeKey('production', devKey)).toEqual({
      ok: false,
      reason: 'DEVELOPMENT_KEY_IN_HOSTED',
    });
    expect(parseBadgeKey('too-short')).toBeNull();
    const real = Buffer.from(new Uint8Array(32).fill(3)).toString('base64');
    expect(resolveBadgeKey('production', real)).toMatchObject({ ok: true });
  });
});
