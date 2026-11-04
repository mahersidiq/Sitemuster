import { describe, expect, it } from 'vitest';

import { CODE_LIFETIME_MS, errorMessageKey, mapAuthError, retryAfterSeconds } from './auth-errors';

describe('mapAuthError (Supabase Auth error codes)', () => {
  it.each([
    [{ code: 'otp_expired', status: 403 }, 'INVALID_OR_EXPIRED_CODE'],
    [{ code: 'over_sms_send_rate_limit', status: 429 }, 'RATE_LIMITED'],
    [{ code: 'over_email_send_rate_limit', status: 429 }, 'RATE_LIMITED'],
    [{ status: 429 }, 'RATE_LIMITED'],
    [{ code: 'sms_send_failed', status: 500 }, 'SMS_UNAVAILABLE'],
    [{ code: 'hook_timeout', status: 500 }, 'SMS_UNAVAILABLE'],
    [{ code: 'mfa_verification_failed', status: 422 }, 'MFA_INVALID_CODE'],
    [{ code: 'validation_failed', message: 'Invalid phone number format' }, 'INVALID_PHONE'],
    [{ code: 'email_address_invalid' }, 'INVALID_EMAIL'],
    [{ name: 'AuthRetryableFetchError', status: 0 }, 'NETWORK'],
    [{ code: 'something_new' }, 'UNKNOWN'],
  ])('maps %j to %s', (error, kind) => {
    expect(mapAuthError(error)).toBe(kind);
  });

  it('reads the server cooldown hint', () => {
    expect(
      retryAfterSeconds({
        message: 'For security purposes, you can only request this after 42 seconds.',
      }),
    ).toBe(42);
    expect(retryAfterSeconds({ message: 'nope' })).toBeNull();
  });

  it('distinguishes expired from wrong codes only by elapsed time', () => {
    const requested = 1_000_000;
    expect(errorMessageKey('INVALID_OR_EXPIRED_CODE', requested, requested + 60_000)).toBe(
      'auth.errors.invalidCode',
    );
    expect(
      errorMessageKey('INVALID_OR_EXPIRED_CODE', requested, requested + CODE_LIFETIME_MS),
    ).toBe('auth.errors.expiredCode');
    expect(errorMessageKey('SMS_UNAVAILABLE')).toBe('auth.errors.smsUnavailable');
  });
});
