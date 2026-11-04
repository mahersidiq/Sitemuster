import { describe, expect, it } from 'vitest';

import { base64UrlDecode } from '../crypto/encoding.ts';
import { buildBadgePayload, checkBadgePayload, parseBadgePayload } from './badge.ts';
import {
  orientationCodeKind,
  orientationStep,
  rotatingOrientationCode,
  secondsUntilNextRotation,
  staticOrientationCode,
} from './orientation.ts';

const SESSION = '0f8fad5b-d9cb-469f-a165-70867728950e';
const DEVICE = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const PROJECT = '16fd2706-8baf-433b-82eb-8c7fada847da';
const SECRET = base64UrlDecode('3q2-7wABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhs');

describe('orientation QR codes', () => {
  it('rotates every 60 seconds and is deterministic for a step', () => {
    const t = 1_793_000_000;
    const a = rotatingOrientationCode(SECRET, SESSION, t);
    expect(a).toBe(rotatingOrientationCode(SECRET, SESSION, t + 59 - (t % 60)));
    expect(rotatingOrientationCode(SECRET, SESSION, t + 60)).not.toBe(a);
    expect(a.split('.')[2]).toBe(String(orientationStep(t)));
    expect(orientationCodeKind(a)).toBe('ROTATING');
    expect(secondsUntilNextRotation(t)).toBe(60 - (t % 60));
  });

  it('recognises printed static codes and rejects anything else', () => {
    const code = staticOrientationCode(SESSION, 'A'.repeat(43));
    expect(orientationCodeKind(code)).toBe('STATIC');
    expect(orientationCodeKind('SMO1.not-a-session.1.abc')).toBeNull();
    expect(orientationCodeKind('https://example.com')).toBeNull();
  });
});

describe('offline worker badge (decision #43)', () => {
  const t = 1_793_000_015;

  it('builds a payload the contract regex accepts and the server check verifies', () => {
    const payload = buildBadgePayload(SECRET, DEVICE, PROJECT, t);
    expect(parseBadgePayload(payload)).toMatchObject({ deviceId: DEVICE, projectId: PROJECT });
    expect(checkBadgePayload(payload, PROJECT, t, SECRET)).toEqual({
      ok: true,
      deviceId: DEVICE,
      timeStep: Math.floor(t / 30),
    });
  });

  it('accepts the neighbouring 30-second step and rejects older codes', () => {
    const payload = buildBadgePayload(SECRET, DEVICE, PROJECT, t);
    expect(checkBadgePayload(payload, PROJECT, t + 30, SECRET).ok).toBe(true);
    expect(checkBadgePayload(payload, PROJECT, t + 61, SECRET)).toEqual({
      ok: false,
      reason: 'BADGE_EXPIRED',
    });
  });

  it('rejects another project, a wrong secret and a tampered MAC', () => {
    const payload = buildBadgePayload(SECRET, DEVICE, PROJECT, t);
    expect(checkBadgePayload(payload, SESSION, t, SECRET)).toEqual({
      ok: false,
      reason: 'BADGE_PROJECT_MISMATCH',
    });
    const other = new Uint8Array(32).fill(7);
    expect(checkBadgePayload(payload, PROJECT, t, other)).toEqual({
      ok: false,
      reason: 'BADGE_MAC_INVALID',
    });
    const last = payload.at(-1) === 'A' ? 'B' : 'A';
    expect(checkBadgePayload(payload.slice(0, -1) + last, PROJECT, t, SECRET).ok).toBe(false);
    expect(checkBadgePayload('SMB1.garbage', PROJECT, t, SECRET)).toEqual({
      ok: false,
      reason: 'BADGE_INVALID',
    });
  });
});
