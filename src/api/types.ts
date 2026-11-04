import type {
  BroadcastMessage,
  DailyReportsResponse,
  DeviceActivateRequest,
  DeviceActivateResponse,
  DeviceRenewResponse,
  IngestOperationsRequest,
  IngestOperationsResponse,
  Locale,
  ProjectStaffRole,
  ProjectStatus,
  AccountDeleteResponse,
  MusterCloseResponse,
  MusterCounts,
  MusterStartResponse,
  ReportConfirmRequest,
  ReportConfirmResponse,
  SessionRecord,
  WorkWindow,
  WorkWindowInput,
} from '@sitemuster/shared';

import type { TrackingPlan } from '../tracking/plan';

export interface ProjectSummary {
  id: string;
  organization_id: string;
  organization_name: string;
  name: string;
  project_number: string | null;
  status: ProjectStatus;
  address: string | null;
  iana_timezone: string;
  config_version: number | null;
  radius_m: number | null;
  operates_24_7: boolean | null;
}

export interface ProjectSettings {
  geofence_radius_m: number;
  exit_hysteresis_m: number;
  entry_dwell_seconds: number;
  max_horizontal_accuracy_m: number;
  operates_24_7: boolean;
  work_windows: WorkWindow[];
  [key: string]: unknown;
}

export interface ProjectDetail {
  project: {
    id: string;
    organization_id: string;
    name: string;
    project_number: string | null;
    address: string | null;
    iana_timezone: string;
    status: ProjectStatus;
  };
  config: {
    version_id: string;
    version_number: number;
    effective_at: string;
    settings: ProjectSettings;
    sha256: string;
    center_lat: number;
    center_lng: number;
    radius_m: number;
    exit_hysteresis_m: number;
  };
  versions: { version_number: number; effective_at: string; reason: string | null }[];
  staff: {
    id: string;
    user_id: string;
    role: ProjectStaffRole;
    emergency_designated: boolean;
    email: string | null;
  }[];
  invitations: { id: string; email: string; role: ProjectStaffRole; expires_at: string }[];
  permissions: {
    can_configure: boolean;
    can_assign_staff: boolean;
    can_run_orientation?: boolean;
    can_view_roster?: boolean;
    /** Milestone 08 fallback screens (the server re-checks every operation). */
    can_operate_kiosk?: boolean;
    can_run_visitor_desk?: boolean;
    can_correct_attendance?: boolean;
  };
}

export interface SiteCheck {
  overlaps: { project_id: string; name: string; distance_m: number }[];
  similar_names: { project_id: string; name: string }[];
}

export interface SiteConfigInput {
  centerLat: number;
  centerLng: number;
  radiusM: number;
  operates24x7: boolean;
  workWindows: WorkWindowInput[];
  entryDwellSeconds: number;
  maxHorizontalAccuracyM: number;
}

export interface CreateProjectInput extends SiteConfigInput {
  organizationId: string;
  name: string;
  projectNumber: string;
  address: string;
  ianaTimezone: string;
  idempotencyKey: string;
}

export interface OrganizationSummary {
  id: string;
  name: string;
}

export interface InviteStaffInput {
  projectId: string;
  email: string;
  role: ProjectStaffRole;
  emergencyDesignated: boolean;
  canConfigureProject: boolean;
  canAssignStaff: boolean;
  canApproveCorrections: boolean;
}

export interface MyInvitation {
  invitation_id: string;
  organization_id: string;
  organization_name: string;
  project_id: string | null;
  project_name: string | null;
  org_role: 'OWNER' | 'ADMIN' | null;
  project_role: ProjectStaffRole | null;
  expires_at: string;
}

export interface AddressCandidate {
  placeId: string;
  primaryText: string;
  secondaryText: string;
}

export interface AddressSearchResult {
  /** `development_fake` only ever comes from a development backend (production fails closed). */
  provider: 'google' | 'development_fake';
  candidates: AddressCandidate[];
}

export interface ResolvedPlace {
  placeId: string;
  formattedAddress: string;
  lat: number;
  lng: number;
  attribution: string;
  provider: 'google' | 'development_fake';
}

export type ReviewStatus = 'DRAFT_REQUIRES_HUMAN_REVIEW' | 'REVIEWED' | 'APPROVED' | 'RETIRED';
export type EnrollmentStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'REVOKED';
export type EmployerStatus = 'PENDING_CONFIRMATION' | 'VERIFIED' | 'REJECTED';

export interface Notice {
  id: string;
  document_id: string;
  version: number;
  locale: Locale;
  review_status: ReviewStatus;
  content: string;
  content_hash: string;
}

export interface OrientationSessionInfo {
  session_id: string;
  project_id: string;
  starts_at: string;
  expires_at: string;
  rotating_secret: string;
  static_code: string;
}

export interface OrientationSessionSummary {
  session_id: string;
  starts_at: string;
  expires_at: string;
  open: boolean;
  completed_count: number;
}

export interface OrientationPreview {
  /** Pass bound to this person and session; lets them finish after the QR has rotated. */
  join_token: string;
  session_id: string;
  project_id: string;
  project_name: string;
  organization_name: string;
  session_expires_at: string;
  notice: Notice;
  notice_acceptable: boolean;
  companies: { id: string; name: string }[];
  profile: { legal_name: string; primary_language: Locale } | null;
  existing_enrollment: {
    enrollment_status: EnrollmentStatus;
    employer_status: EmployerStatus;
  } | null;
}

export interface WorkerDetailsInput {
  legalName: string;
  companyId: string | null;
  companyName: string;
  trade: string;
  emergencyName: string;
  emergencyPhone: string;
  emergencyRelationship: string;
}

export interface JoinInput extends WorkerDetailsInput {
  /** The join pass from previewOrientation (never the scanned QR, which rotates every minute). */
  joinToken: string;
  locale: Locale;
  noticeVersionId: string;
  accept: boolean;
}

export interface ManagedWorkerInput extends WorkerDetailsInput {
  projectId: string;
  locale: Locale;
  noticeVersionId: string;
  acknowledged: boolean;
  idempotencyKey: string;
}

export interface MyEnrollment {
  enrollment_id: string;
  project_id: string;
  project_name: string;
  organization_name: string;
  project_status: ProjectStatus;
  iana_timezone: string;
  enrollment_status: EnrollmentStatus;
  employer_status: EmployerStatus;
  company_name: string | null;
  trade: string | null;
  orientation_completed_at: string | null;
}

export interface RosterEntry {
  enrollment_id: string;
  worker_id: string;
  legal_name: string;
  managed_identity: boolean;
  company_id: string | null;
  company_name: string | null;
  trade: string | null;
  enrollment_status: EnrollmentStatus;
  employer_status: EmployerStatus;
  orientation_completed_at: string | null;
  consent_method: 'DIGITAL' | 'SUPERVISED' | null;
  printed_badge_active: boolean;
  created_at: string;
}

export interface BulkResult {
  enrollment_id: string;
  result: string;
}

export interface EmergencyContact {
  name: string;
  phone: string;
  relationship: string | null;
}

export interface PrintedBadge {
  badge_id: string;
  code: string;
  issued_at: string;
}

/** Typed API used by screens (Supabase implementation in production; typed double in tests). */
export interface SiteMusterApi {
  createOrganization(input: {
    name: string;
    address: string;
    businessEmail: string;
    phone: string;
    idempotencyKey: string;
  }): Promise<string>;
  listOrganizations(): Promise<OrganizationSummary[]>;
  listProjects(): Promise<ProjectSummary[]>;
  getProject(projectId: string): Promise<ProjectDetail>;
  checkSite(input: {
    organizationId: string;
    name: string;
    centerLat: number;
    centerLng: number;
    radiusM: number;
    excludeProjectId?: string;
  }): Promise<SiteCheck>;
  createProject(input: CreateProjectInput): Promise<string>;
  updateConfig(
    input: SiteConfigInput & {
      projectId: string;
      reason: string;
      confirmSensitive: boolean;
      idempotencyKey: string;
    },
  ): Promise<string>;
  setStatus(projectId: string, status: ProjectStatus, reason: string | null): Promise<void>;
  inviteStaff(input: InviteStaffInput): Promise<string>;
  inviteOrgAdmin(organizationId: string, email: string): Promise<string>;
  revokeInvitation(invitationId: string): Promise<void>;
  removeStaff(staffId: string, reason: string): Promise<void>;
  myInvitations(): Promise<MyInvitation[]>;
  acceptInvitation(invitationId: string): Promise<void>;
  searchAddress(query: string, sessionToken: string, locale: Locale): Promise<AddressSearchResult>;
  resolveAddress(placeId: string, sessionToken: string, locale: Locale): Promise<ResolvedPlace>;

  // Milestone 05 — orientation, approval, badges
  startOrientation(projectId: string, idempotencyKey: string): Promise<OrientationSessionInfo>;
  getOrientationSession(sessionId: string): Promise<OrientationSessionInfo>;
  listOrientationSessions(projectId: string): Promise<OrientationSessionSummary[]>;
  closeOrientation(projectId: string, sessionId: string): Promise<void>;
  previewOrientation(code: string, locale: Locale): Promise<OrientationPreview>;
  completeOrientation(
    input: JoinInput,
  ): Promise<{ enrollment_id: string; enrollment_status: EnrollmentStatus }>;
  myEnrollments(): Promise<MyEnrollment[]>;
  getMyEmergencyContact(): Promise<EmergencyContact | null>;
  updateMyEmergencyContact(contact: EmergencyContact): Promise<void>;
  listEnrollments(projectId: string): Promise<RosterEntry[]>;
  bulkApprove(projectId: string, enrollmentIds: string[]): Promise<BulkResult[]>;
  confirmEmployer(
    projectId: string,
    enrollmentIds: string[],
    decision: 'VERIFIED' | 'REJECTED',
  ): Promise<BulkResult[]>;
  decideEnrollment(
    enrollmentId: string,
    decision: 'REJECTED' | 'REVOKED',
    reason: string,
  ): Promise<void>;
  getProjectNotice(
    projectId: string,
    locale: Locale,
  ): Promise<{ notice: Notice; notice_acceptable: boolean }>;
  createManagedWorker(
    input: ManagedWorkerInput,
  ): Promise<{ worker_id: string; enrollment_id: string }>;
  issuePrintedBadge(projectId: string, workerId: string): Promise<PrintedBadge>;
  revokePrintedBadge(projectId: string, badgeId: string, reason: string): Promise<void>;
  activateDevice(input: DeviceActivateRequest): Promise<DeviceActivateResponse>;
  /** Milestone 07: this phone's tracking plan (own data only, decision #89). */
  getTrackingPlan(appVersion: string): Promise<TrackingPlan>;
  /** Sign-out: revoke this worker's phone and its upload secrets (docs/spec/03). */
  revokeMyDevice(): Promise<void>;
  /** Foreground renewal with the signed-in session (also after expiry; decision #44). */
  renewDeviceWithSession(appVersion: string): Promise<DeviceRenewResponse>;
  // Milestone 08: kiosk, foreman, manual and visitor fallbacks (the server re-checks each one).
  /** This phone as an attended kiosk of the project (attendant with MFA, or foreman grant). */
  registerKiosk(projectId: string, devicePublicId: string): Promise<KioskRegistration>;
  /** The operational outbox upload; throws ApiError (NETWORK, UNAUTHENTICATED, RATE_LIMITED…). */
  ingestOperations(request: IngestOperationsRequest): Promise<IngestOperationsResponse>;
  myForemanProjects(): Promise<ForemanProject[]>;
  foremanCrew(projectId: string, companyId: string): Promise<CrewMember[]>;
  openVisitorVisits(projectId: string): Promise<OpenVisit[]>;
  workerAttendanceSessions(projectId: string, workerId: string): Promise<CorrectableSession[]>;
  // Milestone 09: dashboard, roster and map (the server authorizes each read).
  projectDashboard(projectId: string): Promise<ProjectDashboard>;
  workforceRoster(projectId: string): Promise<WorkforceMember[]>;
  /** Location roles only (owner, PM, superintendent, safety manager with MFA). */
  projectMap(projectId: string): Promise<ProjectMap>;
  /**
   * The private Broadcast channel `project:{uuid}` (decision #19). Messages only say "something
   * changed"; screens refetch authorized rows. Returns the unsubscribe function.
   */
  subscribeProject(projectId: string, listener: ProjectChannelListener): () => void;
  // Milestone 10: daily company reports, foreman answers, own hours and correction requests.
  /** Staff and the company's foreman; generates missing reports for an ended project-local day. */
  listReports(projectId: string, localDate: string): Promise<DailyReportsResponse>;
  /** The signed-in foreman's reports still open for an answer (across projects). */
  pendingReports(): Promise<DailyReportsResponse>;
  /** Owner, PM or superintendent with MFA: a new version after corrections. */
  reissueReport(input: {
    projectId: string;
    companyId: string;
    localDate: string;
    reason: string;
  }): Promise<DailyReportsResponse>;
  /** CONFIRM, DISPUTE or SUBMIT_CORRECTION, once per version (the company's foreman only). */
  answerReport(request: ReportConfirmRequest): Promise<ReportConfirmResponse>;
  /** The worker's own sessions and correction requests on one project (never anyone else's). */
  myAttendance(projectId: string, from: string, to: string): Promise<MyAttendance>;
  requestCorrection(
    input: CorrectionRequestInput,
  ): Promise<{ request_id: string; duplicate: boolean }>;
  correctionRequests(projectId: string): Promise<CorrectionRequestRow[]>;
  rejectCorrectionRequest(requestId: string, reason: string): Promise<void>;
  foremanKioskGrants(projectId: string): Promise<ForemanKioskGrant[]>;
  setForemanKioskGrant(input: {
    projectId: string;
    companyId: string;
    foremanProfileId: string;
    enabled: boolean;
    reason: string;
  }): Promise<void>;
  // Milestone 11: Active Muster Mode (supplemental, not a certified life-safety system).
  /** The designated safety role; push never blocks the start. */
  startMuster(input: {
    projectId: string;
    label: string;
    idempotencyKey: string;
    separate?: boolean;
  }): Promise<MusterStartResponse>;
  closeMuster(input: {
    musterId: string;
    note: string;
    acknowledgeIncomplete: boolean;
  }): Promise<MusterCloseResponse>;
  projectMusters(projectId: string): Promise<ProjectMusters>;
  musterBoard(musterId: string): Promise<MusterBoard>;
  /** The signed-in worker's own rows in active musters. */
  myActiveMusters(): Promise<MyMuster[]>;
  foremanActiveMusters(): Promise<ForemanMusterSummary[]>;
  /** The foreman's own companies' workers only. */
  foremanMuster(musterId: string): Promise<MusterBoard>;
  musterReport(musterId: string): Promise<MusterReportView>;
  amendMuster(input: {
    musterId: string;
    memberId: string | null;
    note: string;
    eventUuid: string;
  }): Promise<void>;
  /** This phone's Expo push token for muster alerts (own account only). */
  registerPushToken(input: {
    installationId: string;
    token: string;
    platform: 'IOS' | 'ANDROID';
  }): Promise<void>;
  /** Sign-out: this person's alerts stop on this phone. */
  revokeMyPushTokens(installationId: string): Promise<void>;
  // Milestone 12: privacy (location per project, renewal, account deletion) and legal texts.
  myConsents(): Promise<MyConsent[]>;
  setLocationConsent(projectId: string, enabled: boolean): Promise<void>;
  renewConsent(projectId: string, noticeId: string): Promise<void>;
  legalDocument(type: GlobalLegalDocument, locale: Locale): Promise<Notice>;
  /** Needs a sign-in from the last 15 minutes (and the authenticator when enrolled). */
  deleteAccount(): Promise<AccountDeleteResponse>;
}

// Milestone 12 — privacy.

export type GlobalLegalDocument = 'ACCOUNT_DELETION_RETENTION' | 'MUSTER_SAFETY_LIMITATIONS';

export interface MyConsent {
  project_id: string;
  project_name: string;
  consent_id: string;
  locale: Locale;
  method: 'DIGITAL' | 'SUPERVISED';
  accepted_at: string;
  notice_version_id: string;
  notice_version: number;
  /** Location tracking for this project (off when switched off or a renewal is needed). */
  location_enabled: boolean;
  renewal_required: boolean;
  /** The updated notice to accept when a renewal is needed. */
  renewal_notice: Notice | null;
}

// Milestone 11 — Active Muster Mode.

export type MusterMemberStatus =
  'UNACCOUNTED' | 'SELF_REPORTED_SAFE' | 'VERIFIED_ACCOUNTED' | 'STATUS_UNKNOWN';

export interface MusterMemberRow {
  member_id: string;
  kind: 'WORKER' | 'VISITOR';
  worker_id: string | null;
  visitor_id: string | null;
  name: string;
  company_id: string | null;
  company_name: string | null;
  organization: string | null;
  /** Where the person was at the start: ONSITE_*, PRESENCE_UNKNOWN, ROSTER_NOT_DETECTED, VISITOR… */
  source: string;
  last_detection_at: string | null;
  initial_status: MusterMemberStatus;
  status: MusterMemberStatus;
  push: 'SENT' | 'FAILED' | 'NO_DEVICE' | null;
  last_response: { action: string; channel: string; at: string } | null;
}

export interface MusterBoard {
  muster_id: string;
  project_id: string;
  project_name: string;
  incident_label: string;
  status: 'ACTIVE' | 'CLOSED';
  started_at: string;
  ended_at?: string | null;
  evaluated_at: string;
  can_command?: boolean;
  can_verify_visitors?: boolean;
  counts?: MusterCounts;
  companies?: {
    company_id: string | null;
    company_name: string | null;
    total: number;
    verified: number;
    self_reported: number;
    unknown: number;
    unaccounted: number;
  }[];
  push?: { sent: number; failed: number; no_device: number };
  members: MusterMemberRow[];
}

export interface ProjectMusters {
  can_command: boolean;
  musters: {
    muster_id: string;
    incident_label: string;
    status: 'ACTIVE' | 'CLOSED';
    started_at: string;
    ended_at: string | null;
    counts: MusterCounts;
  }[];
}

export interface MyMuster {
  muster_id: string;
  project_id: string;
  project_name: string;
  incident_label: string;
  started_at: string;
  member_id: string;
  status: MusterMemberStatus;
  self_reported: boolean;
}

export interface ForemanMusterSummary {
  muster_id: string;
  project_id: string;
  project_name: string;
  incident_label: string;
  started_at: string;
}

export interface MusterReportView {
  report: {
    notice: string;
    incident_label: string;
    project_name: string;
    started_at: string;
    started_by: string | null;
    ended_at: string;
    ended_by: string | null;
    closing_note: string;
    acknowledged_incomplete: boolean;
    snapshot_digest: string | null;
    counts: MusterCounts;
    members: {
      /** The person's row on the frozen list (a correction can name it). */
      member_id: string;
      kind: 'WORKER' | 'VISITOR';
      name: string;
      company_name: string | null;
      organization: string | null;
      source: string;
      initial_status: MusterMemberStatus;
      final_status: MusterMemberStatus;
      push: string | null;
      responses: { action: string; channel: string; at: string; responder: string | null }[];
    }[];
    push: { sent: number; failed: number; no_device: number; not_attempted: number };
  };
  digest: string;
  can_amend: boolean;
  amendments: {
    kind: 'LATE_RESPONSE' | 'CORRECTION';
    action: string | null;
    channel: string | null;
    observed_at: string;
    note: string | null;
    member_name: string | null;
    actor: string | null;
    digest: string;
  }[];
}

// Milestone 10 — reports are ESTIMATES of onsite presence: never payroll or a guaranteed headcount.

export interface MyAttendance {
  project: { id: string; name: string; time_zone: string };
  configs: { config_version_id: string; presence_unknown_seconds: number }[];
  /** The worker's own sessions (shared SessionRecord shape). */
  sessions: SessionRecord[];
  requests: {
    request_id: string;
    session_id: string | null;
    status: 'PENDING' | 'APPROVED' | 'REJECTED';
    reason: string;
    proposed: { proposed_start_at: string | null; proposed_end_at: string | null };
    decision_reason: string | null;
    created_at: string;
  }[];
}

export interface CorrectionRequestInput {
  projectId: string;
  sessionId: string | null;
  proposedStartAt: string | null;
  proposedEndAt: string | null;
  reason: string;
  eventUuid: string;
}

export interface CorrectionRequestRow {
  request_id: string;
  worker_id: string;
  worker_name: string;
  company_name: string | null;
  channel: 'WORKER_REQUEST' | 'FOREMAN_REQUEST';
  session_id: string | null;
  original: { start_at?: string; end_at?: string | null; status?: string };
  proposed: {
    proposed_start_at?: string | null;
    proposed_end_at?: string | null;
    note?: string | null;
  };
  reason: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  decision_reason: string | null;
  created_at: string;
  decided_at: string | null;
}

export interface ForemanKioskGrant {
  foreman_profile_id: string;
  name: string;
  company_id: string;
  company_name: string;
  can_operate_kiosk: boolean;
}

export interface KioskRegistration {
  kiosk_device_id: string;
  project_id: string;
  status: 'ACTIVE' | 'REVOKED';
}

export interface ForemanProject {
  project_id: string;
  project_name: string;
  project_status: ProjectStatus;
  company_id: string;
  company_name: string;
  kiosk_grant: boolean;
}

export interface CrewMember {
  worker_id: string;
  name: string;
  trade: string | null;
  employer_status: string;
}

export interface OpenVisit {
  visit_id: string;
  visitor_id: string;
  name: string;
  organization: string | null;
  host_user_id: string | null;
  purpose: string;
  checked_in_at: string;
  status: 'OPEN' | 'UNRESOLVED';
}

// Milestone 09 — dashboard, roster and map (all estimates; never a verified headcount).

export type AttendanceSourceCode =
  'GEOFENCE' | 'KIOSK_DYNAMIC_BADGE' | 'KIOSK_PRINTED_BADGE' | 'FOREMAN' | 'MANUAL';

export interface ProjectCounts {
  approved_roster: number;
  estimated_onsite: number;
  onsite_by_source: Partial<Record<AttendanceSourceCode, number>>;
  manually_verified: number;
  presence_unknown: number;
  arriving: number;
  unscheduled_pending: number;
  departure_pending: number;
  unresolved_sessions: number;
  visitors_onsite: number;
  visitors_unresolved: number;
  evaluated_at: string;
}

export interface ProjectDashboard {
  project: { id: string; name: string; status: ProjectStatus; iana_timezone: string };
  counts: ProjectCounts;
  today: { local_date: string; arrivals: number; departures: number };
  companies: {
    company_id: string | null;
    company_name: string | null;
    approved: number;
    estimated_onsite: number;
    manually_verified: number;
    presence_unknown: number;
  }[];
  trades: { trade: string | null; approved: number; estimated_onsite: number }[];
  approvals: { pending_enrollments: number; employer_pending: number };
  can_view_map: boolean;
  evaluated_at: string;
}

export type RosterPresence =
  | 'ARRIVING'
  | 'ONSITE_ESTIMATED'
  | 'UNSCHEDULED_PENDING'
  | 'PRESENCE_UNKNOWN'
  | 'DEPARTURE_PENDING'
  | 'OFFSITE'
  | 'UNRESOLVED'
  | 'NONE';

export type TrackingHealth =
  | 'ACTIVE'
  | 'NO_PHONE'
  | 'NOT_MONITORED'
  | 'MONITORING_UNAVAILABLE'
  | 'CREDENTIAL_EXPIRING'
  | 'CREDENTIAL_EXPIRED';

export interface WorkforceMember {
  worker_id: string;
  enrollment_id: string;
  legal_name: string;
  managed_identity: boolean;
  company_id: string | null;
  company_name: string | null;
  trade: string | null;
  employer_status: EmployerStatus;
  presence: RosterPresence;
  counted: boolean;
  source: AttendanceSourceCode | null;
  witnessed: boolean;
  arrived_at: string | null;
  last_seen_at: string | null;
  session_status: string | null;
  needs_review: boolean;
  tracking: TrackingHealth;
}

export interface MapMarker {
  worker_id: string;
  legal_name: string;
  company_name: string | null;
  /** Rounded to about 11 m on the server; shown with its accuracy circle. */
  lat: number;
  lng: number;
  accuracy_m: number;
  observed_at: string;
  expires_at: string;
  /** Fresh when the server answered; the phone re-checks against the clock (useMarkerAges). */
  fresh: boolean;
}

export interface ProjectMap {
  site: {
    center_lat: number;
    center_lng: number;
    radius_m: number;
    exit_hysteresis_m: number;
  } | null;
  fresh_seconds: number;
  markers: MapMarker[];
  evaluated_at: string;
}

/** Status of the private project channel as screens show it. */
export type ChannelStatus = 'SUBSCRIBED' | 'DISCONNECTED' | 'DENIED';

export interface ProjectChannelListener {
  onMessage(message: BroadcastMessage): void;
  onStatus(status: ChannelStatus): void;
}

export interface CorrectableSession {
  session_id: string;
  start_at: string;
  end_at: string | null;
  status: string;
  start_source: string;
  end_source: string | null;
}

/** Machine error code from the server (raise exception 'CODE[: detail]') or transport. */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly detail: string | null = null,
  ) {
    super(code);
    this.name = 'ApiError';
  }
}
