import type {
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
  permissions: { can_configure: boolean; can_assign_staff: boolean };
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
