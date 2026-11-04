import { describe, expect, it } from 'vitest';

import { containsCoordinateKeys, stripCoordinateKeys } from './coordinates.ts';
import { redact, redactString, REDACTED } from './redact.ts';

describe('redactString', () => {
  it.each([
    ['token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJlX2hlcmU', '[REDACTED_JWT]'],
    ['Authorization: Bearer abc.DEF_123-xyz', 'Bearer [REDACTED]'],
    ['call +15555550123 now', '[REDACTED_PHONE]'],
    ['call (555) 555-0123 now', '[REDACTED_PHONE]'],
    ['mail ana@example.com', '[REDACTED_EMAIL]'],
    ['at 29.7604,-95.3698 today', '[REDACTED_COORDS]'],
    ['your code: 123456', '[REDACTED_OTP]'],
    ['su código 654321', '[REDACTED_OTP]'],
  ])('scrubs %j', (input, marker) => {
    const out = redactString(input);
    expect(out).toContain(marker);
  });

  it('scrubs offline badge payloads and long secrets', () => {
    const badge =
      'SMB1.33333333-3333-4333-8333-333333333333.00000000-0000-4000-8000-000000000001.59000000.AbCdEfGhIjKlMnOpQrStUv';
    expect(redactString(`scan ${badge}`)).toBe('scan [REDACTED_BADGE]');
    expect(redactString('k=Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9v')).toContain(
      '[REDACTED_SECRET]',
    );
  });

  it('leaves ordinary diagnostics readable', () => {
    expect(redactString('HTTP 503 from ingest-location-batch request 42')).toBe(
      'HTTP 503 from ingest-location-batch request 42',
    );
  });
});

describe('redact', () => {
  it('deep-redacts sensitive keys including coordinates and emergency contacts', () => {
    const out = redact({
      request_id: 'r-1',
      worker: {
        legal_name: 'Ana Pérez',
        phone: '+15555550123',
        emergency_contacts: [{ name: 'B' }],
      },
      fix: { latitude: 29.76, longitude: -95.37, accuracy: 12 },
      coords: [29.76, -95.37],
      otp_code: '123456',
      device_token: 'abc',
      nested: { deeper: { authorization: 'Bearer x' } },
    }) as Record<string, unknown>;
    expect(out.request_id).toBe('r-1');
    expect(out.worker).toEqual({
      legal_name: REDACTED,
      phone: REDACTED,
      emergency_contacts: REDACTED,
    });
    expect(out.fix).toEqual({ latitude: REDACTED, longitude: REDACTED, accuracy: 12 });
    expect(out.coords).toBe(REDACTED);
    expect(out.otp_code).toBe(REDACTED);
    expect(out.device_token).toBe(REDACTED);
    expect(out.nested).toEqual({ deeper: { authorization: REDACTED } });
  });

  it('handles cycles and bounds depth without throwing', () => {
    const a: Record<string, unknown> = { id: 1 };
    a.self = a;
    expect(redact(a)).toEqual({ id: 1, self: '[CIRCULAR]' });
  });

  it('does not mutate its input', () => {
    const input = { phone: '+15555550123' };
    redact(input);
    expect(input.phone).toBe('+15555550123');
  });
});

describe('coordinate key helpers', () => {
  it('detects and strips coordinate keys at any depth', () => {
    const payload = { uuid: 'u', extras: { site: { lat: 1, lng: 2 } }, accuracy: 9 };
    expect(containsCoordinateKeys(payload)).toBe(true);
    expect(stripCoordinateKeys(payload)).toEqual({ uuid: 'u', extras: { site: {} }, accuracy: 9 });
    expect(containsCoordinateKeys(stripCoordinateKeys(payload))).toBe(false);
  });
});
