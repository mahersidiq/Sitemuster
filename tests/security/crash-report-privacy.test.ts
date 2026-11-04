import { describe, expect, it } from 'vitest';

import { scrubBreadcrumb, scrubEvent } from '@sitemuster/shared';

/** Sentry beforeSend/beforeBreadcrumb privacy contract (docs/spec/09-security-privacy.md). */
describe('crash report scrubbing', () => {
  const event = {
    event_id: 'e1',
    message: 'Upload failed for +15555550123 at 29.7604,-95.3698 with Bearer abcDEF123',
    user: { id: 'user-uuid', email: 'ana@example.com', ip_address: '10.0.0.1', username: 'ana' },
    request: {
      url: 'https://x.supabase.co/functions/v1/ingest-location-batch?token=abc',
      method: 'POST',
      headers: { Authorization: 'Bearer secret' },
      data: { locations: [{ coords: { latitude: 29.76, longitude: -95.36 } }] },
      cookies: { sb: 'x' },
    },
    extra: { otp: '123456', emergency_contact: { name: 'B', phone: '+15555550199' }, batch: 3 },
    contexts: { device: { name: "Ana's iPhone", model: 'iPhone16,1' } },
    breadcrumbs: [{ message: 'code: 654321', data: { lat: 29.7, lng: -95.3, step: 'verify' } }],
    exception: {
      values: [
        {
          type: 'Error',
          value:
            'badge SMB1.33333333-3333-4333-8333-333333333333.00000000-0000-4000-8000-000000000001.59000000.AbCdEfGhIjKlMnOpQrStUv rejected',
        },
      ],
    },
  };

  const scrubbed = scrubEvent(event);
  const serialized = JSON.stringify(scrubbed);

  it.each([
    ['phone numbers', '+15555550123'],
    ['emergency contact phone', '+15555550199'],
    ['coordinates', '29.7604'],
    ['coordinate values', '-95.36'],
    ['bearer tokens', 'abcDEF123'],
    ['authorization header', 'Bearer secret'],
    ['email', 'ana@example.com'],
    ['ip address', '10.0.0.1'],
    ['OTP', '123456'],
    ['breadcrumb OTP', '654321'],
    ['device name', "Ana's iPhone"],
    ['badge payload', 'AbCdEfGhIjKlMnOpQrStUv'],
    ['query-string token', 'token=abc'],
  ])('removes %s', (_label, needle) => {
    expect(serialized).not.toContain(needle);
  });

  it('keeps only the pseudonymous user id and non-sensitive diagnostics', () => {
    expect(scrubbed.user).toEqual({ id: 'user-uuid' });
    expect(scrubbed.request).toEqual({
      url: 'https://x.supabase.co/functions/v1/ingest-location-batch',
      method: 'POST',
    });
    expect((scrubbed.extra as Record<string, unknown>).batch).toBe(3);
    expect(scrubbed.event_id).toBe('e1');
  });

  it('scrubs breadcrumbs independently', () => {
    const crumb = scrubBreadcrumb({
      message: 'GPS 29.7604, -95.3698',
      data: { latitude: 1, step: 2 },
    });
    expect(JSON.stringify(crumb)).not.toContain('29.7604');
    expect(crumb.data).toEqual({ latitude: '[REDACTED]', step: 2 });
  });
});
