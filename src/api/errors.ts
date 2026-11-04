import { ApiError } from './types';

/** Server/transport codes that have a dedicated, translated message (apiErrors.<CODE>). */
export const KNOWN_API_ERRORS = [
  'FORBIDDEN',
  'NETWORK',
  'UNKNOWN',
  'RATE_LIMITED',
  'UNAUTHENTICATED',
  'CONFIGURATION_ERROR',
  'TEMPORARILY_UNAVAILABLE',
  'INVALID_REQUEST',
  'NAME_REQUIRED',
  'PROJECT_NUMBER_TOO_LONG',
  'INVALID_TIMEZONE',
  'INVALID_COORDINATES',
  'RADIUS_OUT_OF_BOUNDS',
  'DWELL_OUT_OF_BOUNDS',
  'ACCURACY_OUT_OF_BOUNDS',
  'INVALID_WORK_WINDOWS',
  'TOO_MANY_WORK_WINDOWS',
  'WORK_WINDOW_REQUIRED',
  'INVALID_WORK_WINDOW_WEEKDAY',
  'INVALID_WORK_WINDOW_TIME',
  'EMPTY_WORK_WINDOW',
  'OVERLAPPING_WORK_WINDOWS',
  'PROJECT_CLOSED',
  'REASON_REQUIRED',
  'INVALID_STATUS_TRANSITION',
  'INVALID_EMAIL',
  'DELEGATION_REQUIRES_ORG_ADMIN',
  'INVITATION_NOT_FOUND',
  'INVITATION_NOT_ACTIVE',
  'SENSITIVE_CHANGE_REQUIRES_CONFIRMATION',
  // Milestone 05
  'ORIENTATION_CODE_INVALID',
  'ORIENTATION_CODE_EXPIRED',
  'ORIENTATION_SESSION_CLOSED',
  'PROJECT_NOT_ACTIVE',
  'NOTICE_OUTDATED',
  'NOTICE_UNAVAILABLE',
  'CONSENT_REQUIRED',
  'CONSENT_NOTICE_NOT_APPROVED',
  'COMPANY_REQUIRED',
  'COMPANY_NOT_ON_PROJECT',
  'EMERGENCY_CONTACT_REQUIRED',
  'TRADE_TOO_LONG',
  'NO_ENROLLMENTS',
  'TOO_MANY_ENROLLMENTS',
  'INVALID_DECISION',
  'ENROLLMENT_NOT_APPROVED',
  'WORKER_PROFILE_REQUIRED',
  'IDEMPOTENCY_KEY_REQUIRED',
  // Milestone 10
  'NOT_FOUND',
  'DAY_OPEN',
  'REPORT_VERSION_STALE',
  'REPORT_ALREADY_ANSWERED',
  'REPORT_DEADLINE_PASSED',
  'REASON_TOO_LONG',
  'PROPOSAL_REQUIRED',
  'WORKER_NOT_IN_REPORT',
  'SESSION_NOT_IN_REPORT',
  'EVENT_ID_CONFLICT',
  'REQUEST_ALREADY_DECIDED',
  'SESSION_NOT_FOUND',
  'TIME_IN_FUTURE',
  'MISSING_VISIT_NEEDS_BOTH_TIMES',
  'END_BEFORE_START',
  'TOO_MANY_PENDING',
  'RANGE_INVALID',
  'FOREMAN_NOT_FOUND',
  // Milestone 11
  'LABEL_REQUIRED',
  'ACKNOWLEDGE_INCOMPLETE_REQUIRED',
  'MUSTER_NOT_CLOSED',
] as const;
export type KnownApiError = (typeof KNOWN_API_ERRORS)[number];

export const SENSITIVE_CHANGES = [
  'OPERATES_24_7',
  'DWELL_REDUCED',
  'ACCURACY_LOOSENED',
  'GEOFENCE_ENLARGED',
  'GEOFENCE_MOVED',
] as const;
export type SensitiveChange = (typeof SENSITIVE_CHANGES)[number];

export function errorCode(error: unknown): KnownApiError {
  const code = error instanceof ApiError ? error.code : 'UNKNOWN';
  return (KNOWN_API_ERRORS as readonly string[]).includes(code)
    ? (code as KnownApiError)
    : 'UNKNOWN';
}

/** i18n key for any thrown API error (never shows raw server text to the user). */
export function errorMessageKey(error: unknown): `apiErrors.${KnownApiError}` {
  return `apiErrors.${errorCode(error)}`;
}

/** Sensitive changes the server listed in SENSITIVE_CHANGE_REQUIRES_CONFIRMATION: A,B. */
export function sensitiveChangesOf(error: unknown): SensitiveChange[] | null {
  if (!(error instanceof ApiError) || error.code !== 'SENSITIVE_CHANGE_REQUIRES_CONFIRMATION') {
    return null;
  }
  return (error.detail ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part): part is SensitiveChange =>
      (SENSITIVE_CHANGES as readonly string[]).includes(part),
    );
}
