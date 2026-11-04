/**
 * Canonical enums mirrored by the database (docs/spec/04, 05, 11, 12).
 * Every value here must match the PostgreSQL enum of the same meaning.
 */

export const ATTENDANCE_SOURCES = [
  'GEOFENCE',
  'KIOSK_DYNAMIC_BADGE',
  'KIOSK_PRINTED_BADGE',
  'FOREMAN',
  'MANUAL',
] as const;
export type AttendanceSource = (typeof ATTENDANCE_SOURCES)[number];

/** Visitors are tracked separately and never counted in workforce labor totals. */
export const VISITOR_SOURCES = ['VISITOR_KIOSK'] as const;
export type VisitorSource = (typeof VISITOR_SOURCES)[number];

export const PRESENCE_STATES = [
  'ARRIVING',
  'ONSITE_ESTIMATED',
  'UNSCHEDULED_PENDING',
  'PRESENCE_UNKNOWN',
  'DEPARTURE_PENDING',
  'OFFSITE',
  'UNRESOLVED',
] as const;
export type PresenceState = (typeof PRESENCE_STATES)[number];

export const MONITORING_STATES = [
  'NOT_ARMED',
  'ARMED',
  'PERMISSION_BLOCKED',
  'MONITORING_UNAVAILABLE',
  'TRACKING_LIMITED',
  'DEVICE_UNKNOWN',
] as const;
export type MonitoringState = (typeof MONITORING_STATES)[number];

export const ENROLLMENT_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'REVOKED'] as const;
export type EnrollmentStatus = (typeof ENROLLMENT_STATUSES)[number];

export const EMPLOYER_STATUSES = ['PENDING_CONFIRMATION', 'VERIFIED', 'REJECTED'] as const;
export type EmployerStatus = (typeof EMPLOYER_STATUSES)[number];

export const PROJECT_STATUSES = ['DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const ORGANIZATION_ROLES = ['OWNER', 'ADMIN'] as const;
export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];

export const PROJECT_STAFF_ROLES = ['PM', 'SUPER', 'SAFETY', 'ATTENDANT'] as const;
export type ProjectStaffRole = (typeof PROJECT_STAFF_ROLES)[number];

export const SUBCONTRACTOR_MEMBER_ROLES = ['WORKER', 'FOREMAN'] as const;
export type SubcontractorMemberRole = (typeof SUBCONTRACTOR_MEMBER_ROLES)[number];

export const ATTENDANCE_DIRECTIONS = ['ENTRY', 'EXIT', 'VERIFY', 'CORRECT'] as const;
export type AttendanceDirection = (typeof ATTENDANCE_DIRECTIONS)[number];

export const BADGE_KINDS = ['DYNAMIC_APP', 'PRINTED'] as const;
export type BadgeKind = (typeof BADGE_KINDS)[number];

export const MUSTER_MEMBER_STATUSES = [
  'UNACCOUNTED',
  'SELF_REPORTED_SAFE',
  'VERIFIED_ACCOUNTED',
  'STATUS_UNKNOWN',
] as const;
export type MusterMemberStatus = (typeof MUSTER_MEMBER_STATUSES)[number];

export const REPORT_STATUSES = [
  'PENDING_CONFIRMATION',
  'CONFIRMED',
  'DISPUTED',
  'CORRECTION_REQUESTED',
  'NOT_CONFIRMED',
  'SUPERSEDED',
] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const REPORT_CONFIRMATION_ACTIONS = ['CONFIRM', 'DISPUTE', 'SUBMIT_CORRECTION'] as const;
export type ReportConfirmationAction = (typeof REPORT_CONFIRMATION_ACTIONS)[number];

export const TERMINAL_RESULTS = ['accepted', 'duplicate', 'rejected'] as const;
export type TerminalResult = (typeof TERMINAL_RESULTS)[number];

export const LEGAL_REVIEW_STATUSES = [
  'DRAFT_REQUIRES_HUMAN_REVIEW',
  'REVIEWED',
  'APPROVED',
  'RETIRED',
] as const;
export type LegalReviewStatus = (typeof LEGAL_REVIEW_STATUSES)[number];

export const ORG_STATUSES = ['ACTIVE', 'SUSPENDED', 'CLOSED'] as const;
export const MEMBERSHIP_STATUSES = ['ACTIVE', 'REVOKED'] as const;
export const COMPANY_VERIFICATION_STATUSES = ['PENDING', 'VERIFIED', 'REJECTED'] as const;
export const PROJECT_COMPANY_STATUSES = ['PENDING', 'APPROVED', 'REMOVED'] as const;
export const MEMBER_VERIFICATION_STATUSES = ['PENDING', 'VERIFIED', 'REJECTED', 'REVOKED'] as const;
export const CONSENT_METHODS = ['DIGITAL', 'SUPERVISED'] as const;
export const LEGAL_DOCUMENT_TYPES = [
  'WORKER_LOCATION_DISCLOSURE',
  'GC_CUSTOM_NOTICE',
  'ACCOUNT_DELETION_RETENTION',
  'MUSTER_SAFETY_LIMITATIONS',
] as const;
export const ORIENTATION_SESSION_STATUSES = ['OPEN', 'CLOSED', 'EXPIRED', 'REVOKED'] as const;
export const ORIENTATION_INVITE_KINDS = ['ROTATING', 'STATIC'] as const;
export const DEVICE_PLATFORMS = ['IOS', 'ANDROID'] as const;
export const KIOSK_STATUSES = ['ACTIVE', 'REVOKED'] as const;
export const ATTENDANCE_VERIFICATION_STATUSES = [
  'PROVISIONAL',
  'SYSTEM_CONFIRMED',
  'WITNESSED',
  'REVIEW_REQUIRED',
  'DISPUTED',
  'CORRECTED',
] as const;
export const EVIDENCE_CONFIDENCE_LEVELS = ['LOW', 'MEDIUM', 'HIGH'] as const;
export const SESSION_STATUSES = [
  'OPEN',
  'PENDING_APPROVAL',
  'UNRESOLVED',
  'CLOSED',
  'VOID',
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];
export const CORRECTION_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'] as const;
export const CORRECTION_CHANNELS = ['WORKER_REQUEST', 'FOREMAN_REQUEST', 'STAFF_MANUAL'] as const;
export const QUALIFICATION_STATES = [
  'QUALIFIED',
  'POOR_ACCURACY',
  'CLOCK_SKEW_REVIEW',
  'LATE_REVIEW',
  'MOCK_FLAGGED',
  'NOT_APPLICABLE',
] as const;
export const VISITOR_IDENTITY_STATUSES = ['UNVERIFIED', 'ID_CHECKED'] as const;
export const VISITOR_VISIT_STATUSES = ['OPEN', 'CLOSED', 'UNRESOLVED'] as const;
export const MUSTER_STATUSES = ['ACTIVE', 'CLOSED'] as const;
export const MUSTER_RESPONSE_ACTIONS = [
  'SELF_REPORT',
  'PHYSICAL_VERIFICATION',
  'STATUS_UPDATE',
] as const;
export const MUSTER_CHANNELS = [
  'APP',
  'NOTIFICATION_ACTION',
  'KIOSK',
  'FOREMAN',
  'SAFETY_STAFF',
] as const;
export const PLATFORM_OPERATOR_ACTIONS = [
  'ORG_LOOKUP',
  'REVOKE_DEVICE_CREDENTIAL',
  'RESEND_INVITE',
  'HEALTH_CHECK',
] as const;
export const AUDIT_ACTOR_TYPES = [
  'USER',
  'DEVICE',
  'KIOSK',
  'SYSTEM',
  'PLATFORM_OPERATOR',
] as const;
