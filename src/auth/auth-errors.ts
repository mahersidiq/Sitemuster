/**
 * Maps Supabase Auth errors to user-facing error kinds. The server intentionally answers
 * "expired or invalid" with one code (no oracle); the screen tells the two apart only by the
 * time elapsed since the code was requested.
 */
export type AuthErrorKind =
  | 'INVALID_OR_EXPIRED_CODE'
  | 'RATE_LIMITED'
  | 'INVALID_PHONE'
  | 'INVALID_EMAIL'
  | 'NETWORK'
  | 'SMS_UNAVAILABLE'
  | 'MFA_INVALID_CODE'
  | 'UNKNOWN';

export interface AuthErrorLike {
  status?: number;
  code?: string;
  name?: string;
  message?: string;
}

export function mapAuthError(error: AuthErrorLike | null | undefined): AuthErrorKind {
  if (!error) return 'UNKNOWN';
  const code = error.code ?? '';
  if (code === 'otp_expired') return 'INVALID_OR_EXPIRED_CODE';
  if (code.startsWith('mfa_')) return 'MFA_INVALID_CODE';
  if (error.status === 429 || code.startsWith('over_')) return 'RATE_LIMITED';
  if (
    code === 'sms_send_failed' ||
    code === 'phone_provider_disabled' ||
    code.startsWith('hook_')
  ) {
    return 'SMS_UNAVAILABLE';
  }
  if (code === 'validation_failed' && /phone/i.test(error.message ?? '')) return 'INVALID_PHONE';
  if (code === 'validation_failed' && /email/i.test(error.message ?? '')) return 'INVALID_EMAIL';
  if (code === 'email_address_invalid') return 'INVALID_EMAIL';
  if (
    error.name === 'AuthRetryableFetchError' ||
    error.status === 0 ||
    error.name === 'TypeError'
  ) {
    return 'NETWORK';
  }
  return 'UNKNOWN';
}

/** Server cooldown hint ("...after 42 seconds") in seconds, else null. */
export function retryAfterSeconds(error: AuthErrorLike | null | undefined): number | null {
  const match = error?.message?.match(/after (\d+) seconds?/i);
  return match?.[1] ? Number(match[1]) : null;
}

export const CODE_LIFETIME_MS = 10 * 60 * 1000;

/** i18n key for an error, distinguishing expiry by elapsed time for code errors. */
export function errorMessageKey(
  kind: AuthErrorKind,
  codeRequestedAtMs?: number,
  nowMs = Date.now(),
) {
  switch (kind) {
    case 'INVALID_OR_EXPIRED_CODE':
      return codeRequestedAtMs !== undefined && nowMs - codeRequestedAtMs >= CODE_LIFETIME_MS
        ? 'auth.errors.expiredCode'
        : 'auth.errors.invalidCode';
    case 'RATE_LIMITED':
      return 'auth.errors.rateLimited';
    case 'INVALID_PHONE':
      return 'auth.errors.invalidPhone';
    case 'INVALID_EMAIL':
      return 'auth.errors.invalidEmail';
    case 'NETWORK':
      return 'auth.errors.network';
    case 'SMS_UNAVAILABLE':
      return 'auth.errors.smsUnavailable';
    case 'MFA_INVALID_CODE':
      return 'auth.errors.mfaInvalid';
    case 'UNKNOWN':
      return 'auth.errors.unknown';
  }
}
