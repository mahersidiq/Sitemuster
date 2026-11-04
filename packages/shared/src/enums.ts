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
  'NOT_CONFIRMED',
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
