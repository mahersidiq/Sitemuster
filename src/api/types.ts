import type {
  DeviceActivateRequest,
  DeviceActivateResponse,
  Locale,
  ProjectStaffRole,
  ProjectStatus,
  WorkWindow,
  WorkWindowInput,
} from '@sitemuster/shared';

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
  code: string;
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
