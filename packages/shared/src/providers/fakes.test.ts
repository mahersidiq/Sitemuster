import { randomBytes as nodeRandomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { base64UrlDecode, sha256Hex } from '../crypto/encoding.ts';
import {
  FakeAddressProvider,
  FakeCredentialProvisioner,
  FakeLocationProvider,
  FakePushProvider,
  FakeSmsOtpProvider,
} from './fakes.ts';

const randomBytes = (n: number) => new Uint8Array(nodeRandomBytes(n));

describe('FakeSmsOtpProvider (development/test only)', () => {
  it('issues random 6-digit codes, enforces the 60 s resend cooldown and 600 s expiry', async () => {
    let now = 1_000_000;
    const sms = new FakeSmsOtpProvider('test', randomBytes, () => now);
    const phone = '+15555550100';
    expect(await sms.requestOtp(phone, 'en-US')).toEqual({ status: 'sent' });
    const code = sms.peekCodeForDevelopment(phone);
    expect(code).toMatch(/^\d{6}$/);

    now += 59_000;
    expect(await sms.requestOtp(phone, 'en-US')).toEqual({ status: 'rate_limited' });
    expect(await sms.verifyOtp(phone, '000000' === code ? '111111' : '000000')).toEqual({
      status: 'invalid',
    });

    now += 600_000;
    expect(await sms.verifyOtp(phone, code ?? '')).toEqual({ status: 'expired' });
  });

  it('verifies a correct code exactly once', async () => {
    const sms = new FakeSmsOtpProvider('development', randomBytes, () => 0);
    await sms.requestOtp('+15555550101', 'es-US');
    const code = sms.peekCodeForDevelopment('+15555550101') ?? '';
    expect(await sms.verifyOtp('+15555550101', code)).toEqual({ status: 'verified' });
    expect(await sms.verifyOtp('+15555550101', code)).toEqual({ status: 'invalid' });
  });
});

describe('FakeAddressProvider', () => {
  it('returns clearly labelled synthetic candidates and deterministic resolution', async () => {
    const address = new FakeAddressProvider('test');
    expect(await address.search('ab', 'tok', 'en-US')).toEqual([]);
    const results = await address.search('100 Main St', 'tok', 'en-US');
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.secondaryText.includes('not real'))).toBe(true);
    const first = results[0];
    if (!first) throw new Error('expected a candidate');
    const a = await address.resolve(first.placeId, 'tok');
    const b = await address.resolve(first.placeId, 'tok');
    expect(a).toEqual(b);
    expect(a.attribution).toContain('Development fake');
  });
});

describe('FakePushProvider', () => {
  it('records sends and can simulate an outage without claiming delivery', async () => {
    const push = new FakePushProvider('test');
    expect(await push.send([{ to: 'ExpoPushToken[x]', title: 't', body: 'b' }])).toEqual([
      { to: 'ExpoPushToken[x]', status: 'ok' },
    ]);
    push.outage = true;
    expect(await push.send([{ to: 'ExpoPushToken[x]', title: 't', body: 'b' }])).toEqual([
      { to: 'ExpoPushToken[x]', status: 'error', error: 'FAKE_OUTAGE' },
    ]);
    expect(push.sent).toHaveLength(1);
  });
});

describe('FakeLocationProvider', () => {
  it('arms regions and delivers scripted events to listeners until unsubscribed', async () => {
    const location = new FakeLocationProvider('test');
    await location.armGeofences([
      { identifier: 'pf_1', latitude: 29.76, longitude: -95.37, radiusM: 200 },
    ]);
    expect(location.armedRegions()).toHaveLength(1);
    const seen: string[] = [];
    const off = location.onEvent((event) => seen.push(event.type));
    location.emit({
      type: 'GEOFENCE',
      uuid: '22222222-2222-4222-8222-222222222222',
      timestamp: '2026-11-03T12:00:00Z',
      identifier: 'pf_1',
      action: 'ENTER',
      accuracy: 10,
    });
    off();
    location.emit({
      type: 'GEOFENCE',
      uuid: '33333333-3333-4333-8333-333333333333',
      timestamp: '2026-11-03T12:01:00Z',
      identifier: 'pf_1',
      action: 'EXIT',
      accuracy: 10,
    });
    expect(seen).toEqual(['GEOFENCE']);
    await location.disarm();
    expect(location.armedRegions()).toHaveLength(0);
  });
});

describe('FakeCredentialProvisioner', () => {
  it('issues 32-byte tokens whose SHA-256 is the only server-side form', async () => {
    const provisioner = new FakeCredentialProvisioner('test', randomBytes);
    const issued = await provisioner.issue();
    expect(base64UrlDecode(issued.token)).toHaveLength(32);
    expect(issued.tokenSha256Hex).toBe(sha256Hex(base64UrlDecode(issued.token)));
    expect(issued.badgeSecretCiphertext.startsWith('FAKE_DEV_ONLY.')).toBe(true);
    const second = await provisioner.issue();
    expect(second.token).not.toBe(issued.token);
  });
});
