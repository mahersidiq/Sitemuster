-- Milestone 02 · Enumerations. Values mirror packages/shared/src/enums.ts exactly
-- (tests/integration/db-enum-parity.test.ts enforces the mirror).

create type public.locale_code as enum ('en-US', 'es-US');
create type public.org_role as enum ('OWNER', 'ADMIN');
create type public.org_status as enum ('ACTIVE', 'SUSPENDED', 'CLOSED');
create type public.membership_status as enum ('ACTIVE', 'REVOKED');
create type public.project_status as enum ('DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED');
create type public.project_staff_role as enum ('PM', 'SUPER', 'SAFETY', 'ATTENDANT');
create type public.company_verification_status as enum ('PENDING', 'VERIFIED', 'REJECTED');
create type public.project_company_status as enum ('PENDING', 'APPROVED', 'REMOVED');
create type public.subcontractor_member_role as enum ('WORKER', 'FOREMAN');
create type public.member_verification_status as enum ('PENDING', 'VERIFIED', 'REJECTED', 'REVOKED');
create type public.enrollment_status as enum ('PENDING', 'APPROVED', 'REJECTED', 'REVOKED');
create type public.employer_status as enum ('PENDING_CONFIRMATION', 'VERIFIED', 'REJECTED');
create type public.consent_method as enum ('DIGITAL', 'SUPERVISED');
create type public.legal_review_status as enum ('DRAFT_REQUIRES_HUMAN_REVIEW', 'REVIEWED', 'APPROVED', 'RETIRED');
create type public.legal_document_type as enum (
  'WORKER_LOCATION_DISCLOSURE', 'GC_CUSTOM_NOTICE', 'ACCOUNT_DELETION_RETENTION', 'MUSTER_SAFETY_LIMITATIONS'
);
create type public.orientation_session_status as enum ('OPEN', 'CLOSED', 'EXPIRED', 'REVOKED');
create type public.orientation_invite_kind as enum ('ROTATING', 'STATIC');
create type public.device_platform as enum ('IOS', 'ANDROID');
create type public.kiosk_status as enum ('ACTIVE', 'REVOKED');
create type public.badge_kind as enum ('DYNAMIC_APP', 'PRINTED');
create type public.attendance_source as enum (
  'GEOFENCE', 'KIOSK_DYNAMIC_BADGE', 'KIOSK_PRINTED_BADGE', 'FOREMAN', 'MANUAL'
);
create type public.attendance_direction as enum ('ENTRY', 'EXIT', 'VERIFY', 'CORRECT');
create type public.attendance_verification as enum (
  'PROVISIONAL', 'SYSTEM_CONFIRMED', 'WITNESSED', 'REVIEW_REQUIRED', 'DISPUTED', 'CORRECTED'
);
create type public.evidence_confidence as enum ('LOW', 'MEDIUM', 'HIGH');
create type public.presence_state as enum (
  'ARRIVING', 'ONSITE_ESTIMATED', 'UNSCHEDULED_PENDING', 'PRESENCE_UNKNOWN',
  'DEPARTURE_PENDING', 'OFFSITE', 'UNRESOLVED'
);
create type public.session_status as enum ('OPEN', 'PENDING_APPROVAL', 'UNRESOLVED', 'CLOSED', 'VOID');
create type public.correction_status as enum ('PENDING', 'APPROVED', 'REJECTED');
create type public.correction_channel as enum ('WORKER_REQUEST', 'FOREMAN_REQUEST', 'STAFF_MANUAL');
create type public.qualification_state as enum (
  'QUALIFIED', 'POOR_ACCURACY', 'CLOCK_SKEW_REVIEW', 'LATE_REVIEW', 'MOCK_FLAGGED', 'NOT_APPLICABLE'
);
create type public.terminal_result as enum ('accepted', 'duplicate', 'rejected');
create type public.visitor_identity_status as enum ('UNVERIFIED', 'ID_CHECKED');
create type public.visitor_visit_status as enum ('OPEN', 'CLOSED', 'UNRESOLVED');
create type public.report_status as enum (
  'PENDING_CONFIRMATION', 'CONFIRMED', 'DISPUTED', 'CORRECTION_REQUESTED', 'NOT_CONFIRMED', 'SUPERSEDED'
);
create type public.report_action as enum ('CONFIRM', 'DISPUTE', 'SUBMIT_CORRECTION');
create type public.muster_status as enum ('ACTIVE', 'CLOSED');
create type public.muster_member_status as enum (
  'UNACCOUNTED', 'SELF_REPORTED_SAFE', 'VERIFIED_ACCOUNTED', 'STATUS_UNKNOWN'
);
create type public.muster_response_action as enum ('SELF_REPORT', 'PHYSICAL_VERIFICATION', 'STATUS_UPDATE');
create type public.muster_channel as enum ('APP', 'NOTIFICATION_ACTION', 'KIOSK', 'FOREMAN', 'SAFETY_STAFF');
create type public.platform_operator_action as enum (
  'ORG_LOOKUP', 'REVOKE_DEVICE_CREDENTIAL', 'RESEND_INVITE', 'HEALTH_CHECK'
);
create type public.audit_actor_type as enum ('USER', 'DEVICE', 'KIOSK', 'SYSTEM', 'PLATFORM_OPERATOR');
