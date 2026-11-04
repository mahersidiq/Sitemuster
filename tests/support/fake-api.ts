import { randomUUID } from 'node:crypto';

import {
  normalizeWorkWindows,
  TRACKING_DEFAULTS,
  type DeviceActivateRequest,
  type DeviceActivateResponse,
  type BroadcastMessage,
  type DeviceRenewResponse,
  type IngestOperationsRequest,
  type IngestOperationsResponse,
  type Locale,
  type OperationChildResult,
  type OperationResult,
  type ProjectStaffRole,
  type ProjectStatus,
  type DailyReportsResponse,
  type ReportConfirmRequest,
  type ReportConfirmResponse,
  type ReportView,
  type WorkWindow,
} from '@sitemuster/shared';

import type { Access } from '../../src/auth/access';
import {
  ApiError,
  type BulkResult,
  type CorrectableSession,
  type CrewMember,
  type EmergencyContact,
  type ForemanProject,
  type KioskRegistration,
  type OpenVisit,
  type EnrollmentStatus,
  type EmployerStatus,
  type JoinInput,
  type ManagedWorkerInput,
  type MyEnrollment,
  type Notice,
  type OrientationPreview,
  type OrientationSessionInfo,
  type OrientationSessionSummary,
  type PrintedBadge,
  type RosterEntry,
  type CreateProjectInput,
  type InviteStaffInput,
  type MyInvitation,
  type OrganizationSummary,
  type ProjectDetail,
  type ProjectSummary,
  type SiteCheck,
  type SiteConfigInput,
  type SiteMusterApi,
  type AttendanceSourceCode,
  type ChannelStatus,
  type MapMarker,
  type ProjectChannelListener,
  type ProjectDashboard,
  type ProjectMap,
  type RosterPresence,
  type TrackingHealth,
  type WorkforceMember,
  type CorrectionRequestInput,
  type CorrectionRequestRow,
  type ForemanKioskGrant,
  type ForemanMusterSummary,
  type MusterBoard,
  type MusterMemberRow,
  type MusterReportView,
  type MyAttendance,
  type MyMuster,
  type ProjectMusters,
} from '../../src/api/types';
import { isValidTimeZone } from '../../src/projects/format';
import type { TrackingPlan } from '../../src/tracking/plan';
import { NEXT_STATUSES, STATUSES_NEEDING_REASON } from '../../src/projects/lifecycle';

/**
 * Typed in-memory double of the SiteMuster data API for Jest screen flows. It mirrors the
 * server rules that screens depend on (bounds, schedule validation, sensitive-change
 * confirmation, lifecycle, idempotency, delegation). The real rules are proven against Postgres
 * in supabase/tests/database/020_projects_config.test.sql.
 */
interface Version {
  id: string;
  number: number;
  effectiveAt: string;
  reason: string | null;
  centerLat: number;
  centerLng: number;
  radiusM: number;
  operates24x7: boolean;
  windows: WorkWindow[];
  dwell: number;
  accuracy: number;
  idempotencyKey: string;
}

interface Project {
  id: string;
  organizationId: string;
  name: string;
  number: string | null;
  address: string | null;
  timeZone: string;
  status: ProjectStatus;
  idempotencyKey: string;
  versions: Version[];
  staff: {
    id: string;
    userId: string;
    email: string;
    role: ProjectStaffRole;
    emergency: boolean;
  }[];
}

interface Invitation {
  id: string;
  organizationId: string;
  projectId: string | null;
  email: string;
  orgRole: 'ADMIN' | null;
  projectRole: ProjectStaffRole | null;
  emergency: boolean;
  used: boolean;
  revoked: boolean;
}

/**
 * One signed-in user's view of a shared fake server. Pass another world as `shared` to model a
 * second user (e.g. an invitee) on the same data.
 */
interface FakeSession extends OrientationSessionInfo {
  open: boolean;
  completed: number;
}

interface FakeWorker {
  id: string;
  userId: string | null;
  legalName: string;
  managed: boolean;
  emergency: EmergencyContact | null;
}

interface FakeEnrollment {
  id: string;
  projectId: string;
  workerId: string;
  companyId: string;
  trade: string | null;
  status: EnrollmentStatus;
  employer: EmployerStatus;
  consent: 'DIGITAL' | 'SUPERVISED';
  oriented: boolean;
}

/** Deterministic notice per language (draft, like the real seeded drafts). */
export const FAKE_NOTICES: Record<Locale, Notice> = {
  'en-US': {
    id: '33333333-0000-4000-8000-0000000000e1',
    document_id: 'WORKER_LOCATION_DISCLOSURE_EN_V1',
    version: 1,
    locale: 'en-US',
    review_status: 'DRAFT_REQUIRES_HUMAN_REVIEW',
    content: 'DRAFT notice: this project keeps an estimated attendance record.',
    content_hash: 'e'.repeat(64),
  },
  'es-US': {
    id: '33333333-0000-4000-8000-0000000000e2',
    document_id: 'WORKER_LOCATION_DISCLOSURE_ES_V1',
    version: 1,
    locale: 'es-US',
    review_status: 'DRAFT_REQUIRES_HUMAN_REVIEW',
    content: 'Aviso BORRADOR: este proyecto lleva un registro estimado de asistencia.',
    content_hash: 'f'.repeat(64),
  },
};

/** One muster of the fake server (Milestone 11). */
export interface FakeMuster {
  id: string;
  projectId: string;
  label: string;
  status: 'ACTIVE' | 'CLOSED';
  startedAt: string;
  endedAt: string | null;
  note: string | null;
  members: MusterMemberRow[];
  amendments: MusterReportView['amendments'];
  idempotencyKeys: Set<string>;
}

/** 32-byte rotating secret used by fake sessions (base64url). */
export const FAKE_ROTATING_SECRET = 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA';
export const FAKE_BADGE_SECRET = 'ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8';

/**
 * One signed-in user's view of a shared fake server. Pass another world as `shared` to model a
 * second user (e.g. an invitee) on the same data.
 */
export class FakeWorld {
  readonly orgs: { id: string; name: string; idempotencyKey: string }[];
  readonly projects: Project[];
  readonly invitations: Invitation[];
  readonly sessions: FakeSession[];
  readonly workers: FakeWorker[];
  readonly enrollments: FakeEnrollment[];
  readonly companies: { id: string; name: string; projectId: string }[];
  readonly printedBadges: { id: string; workerId: string; active: boolean }[];
  readonly joinPasses: Map<string, { sessionId: string; userId: string }>;
  readonly calls: string[] = [];
  device: DeviceActivateResponse | null = null;
  trackingPlan: TrackingPlan | null = null;
  // Milestone 08 fake server state.
  readonly kiosks: KioskRegistration[] = [];
  foremanProjects: ForemanProject[] = [];
  readonly crews = new Map<string, CrewMember[]>();
  readonly visits: OpenVisit[] = [];
  readonly correctable = new Map<string, CorrectableSession[]>();
  /** Badge payloads the fake server resolves to a worker on sync (each accepted once). */
  readonly badgeWorkers = new Map<string, string>();
  readonly operationReceipts = new Map<string, OperationResult>();
  readonly redeemedBadges = new Set<string>();
  /** Airplane mode for the outbox: ingestOperations fails with NETWORK. */
  operationsOffline = false;
  // Milestone 09 fake server state: live presence per enrollment, map markers, project channels.
  readonly presence = new Map<string, FakePresence>();
  readonly markers = new Map<string, MapMarker[]>();
  readonly channels = new Map<string, Set<ProjectChannelListener>>();
  /** What a new project subscription reports once it is authorized. */
  channelMode: ChannelStatus = 'SUBSCRIBED';
  /** No signal on the staff phone: dashboard, roster and map reads fail with NETWORK. */
  readsOffline = false;
  // Milestone 10 fake server state (views as the server functions return them), shared by
  // every signed-in user of the same fake server.
  readonly reports: ReportView[];
  /** Local dates whose project day has not ended yet (list answers day_open). */
  readonly openDays: Set<string>;
  readonly answers: ReportConfirmRequest[];
  readonly attendance: Map<string, MyAttendance>;
  readonly correctionRequests: CorrectionRequestRow[];
  readonly kioskGrants: Map<string, ForemanKioskGrant[]>;
  /** Milestone 11: musters of the fake server (board rows as the server returns them). */
  readonly musters: FakeMuster[];
  /** Phones registered for muster alerts (Expo tokens). */
  readonly pushTokens: { userId: string; token: string }[];
  /** Simulated push outage: starting a muster still works, alerts fail. */
  pushOutage = false;
  /** The fake server clock for report deadlines. */
  now = Date.parse('2026-11-04T15:00:00Z');
  private broadcastVersion = 0;

  constructor(
    public access: Access,
    public email: string,
    shared?: FakeWorld,
  ) {
    this.orgs = shared?.orgs ?? [];
    this.projects = shared?.projects ?? [];
    this.invitations = shared?.invitations ?? [];
    this.sessions = shared?.sessions ?? [];
    this.workers = shared?.workers ?? [];
    this.enrollments = shared?.enrollments ?? [];
    this.companies = shared?.companies ?? [];
    this.printedBadges = shared?.printedBadges ?? [];
    this.joinPasses = shared?.joinPasses ?? new Map();
    this.reports = shared?.reports ?? [];
    this.openDays = shared?.openDays ?? new Set();
    this.answers = shared?.answers ?? [];
    this.attendance = shared?.attendance ?? new Map();
    this.correctionRequests = shared?.correctionRequests ?? [];
    this.kioskGrants = shared?.kioskGrants ?? new Map();
    this.musters = shared?.musters ?? [];
    this.pushTokens = shared?.pushTokens ?? [];
  }

  /** Test helper: a worker (with or without an app account) enrolled in a project. */
  addEnrollment(
    projectId: string,
    legalName: string,
    status: EnrollmentStatus = 'PENDING',
    userId: string | null = null,
  ): FakeEnrollment {
    const worker: FakeWorker = {
      id: randomUUID(),
      userId,
      legalName,
      managed: userId === null,
      emergency: null,
    };
    this.workers.push(worker);
    const company = this.companies.find((c) => c.projectId === projectId) ?? {
      id: randomUUID(),
      name: 'Acme Concrete',
      projectId,
    };
    if (!this.companies.includes(company)) this.companies.push(company);
    const enrollment: FakeEnrollment = {
      id: randomUUID(),
      projectId,
      workerId: worker.id,
      companyId: company.id,
      trade: 'Concrete',
      status,
      employer: 'PENDING_CONFIRMATION',
      consent: userId ? 'DIGITAL' : 'SUPERVISED',
      oriented: true,
    };
    this.enrollments.push(enrollment);
    return enrollment;
  }

  addOrganization(name: string, role: 'OWNER' | 'ADMIN' = 'OWNER'): string {
    const id = randomUUID();
    this.orgs.push({ id, name, idempotencyKey: randomUUID() });
    this.access = {
      ...this.access,
      org_roles: [...this.access.org_roles, { organization_id: id, role }],
    };
    return id;
  }

  /** Test helper (Milestone 09): what the server currently knows about one enrolled worker. */
  setPresence(enrollmentId: string, presence: Partial<FakePresence>): void {
    this.presence.set(enrollmentId, {
      ...DEFAULT_PRESENCE,
      ...this.presence.get(enrollmentId),
      ...presence,
    });
  }

  /** Test helper: the database sends a private Broadcast for this project (ids and counts only). */
  emitBroadcast(projectId: string, type: BroadcastMessage['type'] = 'WORKFORCE_CHANGED'): void {
    this.broadcastVersion += 1;
    const approved = this.enrollments.filter(
      (e) => e.projectId === projectId && e.status === 'APPROVED',
    );
    const message: BroadcastMessage = {
      schema_version: 1,
      type,
      project_id: projectId,
      aggregate_version: this.broadcastVersion,
      counts: {
        estimated_onsite: approved.filter((e) => this.presence.get(e.id)?.counted).length,
        presence_unknown: approved.filter(
          (e) => this.presence.get(e.id)?.presence === 'PRESENCE_UNKNOWN',
        ).length,
        approved_roster: approved.length,
        visitors_onsite: this.visits.length,
      },
      changed_ids: [],
      occurred_at: new Date().toISOString(),
    };
    for (const listener of this.channels.get(projectId) ?? []) listener.onMessage(message);
  }

  /** Test helper: the channel connects, drops or is refused (e.g. access revoked). */
  setChannelStatus(projectId: string, status: ChannelStatus): void {
    for (const listener of this.channels.get(projectId) ?? []) listener.onStatus(status);
  }
}

export interface FakePresence {
  presence: RosterPresence;
  counted: boolean;
  source: AttendanceSourceCode | null;
  witnessed: boolean;
  arrivedAt: string | null;
  lastSeenAt: string | null;
  needsReview: boolean;
  tracking: TrackingHealth;
}

const DEFAULT_PRESENCE: FakePresence = {
  presence: 'NONE',
  counted: false,
  source: null,
  witnessed: false,
  arrivedAt: null,
  lastSeenAt: null,
  needsReview: false,
  tracking: 'NO_PHONE',
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function haversine(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const h =
    Math.sin(rad(bLat - aLat) / 2) ** 2 +
    Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(rad(bLng - aLng) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

function checkBounds(input: SiteConfigInput): WorkWindow[] {
  if (input.radiusM < 150 || input.radiusM > 2000) throw new ApiError('RADIUS_OUT_OF_BOUNDS');
  if (input.entryDwellSeconds < 300 || input.entryDwellSeconds > 3600) {
    throw new ApiError('DWELL_OUT_OF_BOUNDS');
  }
  if (input.maxHorizontalAccuracyM < 20 || input.maxHorizontalAccuracyM > 100) {
    throw new ApiError('ACCURACY_OUT_OF_BOUNDS');
  }
  const checked = normalizeWorkWindows(input.workWindows, input.operates24x7);
  if (!checked.ok) throw new ApiError(checked.error);
  return input.operates24x7 ? [] : checked.windows;
}

export class FakeSiteMusterApi implements SiteMusterApi {
  /** Next call fails with this code; `afterCommit` simulates a lost response after the write. */
  private failure: { code: string; afterCommit: boolean } | null = null;

  constructor(readonly world: FakeWorld) {}

  failNext(code: string, afterCommit = false) {
    this.failure = { code, afterCommit };
  }

  private before(name: string) {
    this.world.calls.push(name);
    if (this.failure && !this.failure.afterCommit) {
      const { code } = this.failure;
      this.failure = null;
      throw new ApiError(code);
    }
  }

  private after<T>(value: T): T {
    if (this.failure?.afterCommit) {
      const { code } = this.failure;
      this.failure = null;
      throw new ApiError(code);
    }
    return value;
  }

  private isOrgAdmin(organizationId: string) {
    return this.world.access.org_roles.some((r) => r.organization_id === organizationId);
  }

  private projectRole(projectId: string) {
    return this.world.access.project_roles.find((r) => r.project_id === projectId)?.role ?? null;
  }

  private project(projectId: string): Project {
    const project = this.world.projects.find((p) => p.id === projectId);
    if (!project) throw new ApiError('FORBIDDEN');
    if (!this.isOrgAdmin(project.organizationId) && !this.projectRole(projectId)) {
      throw new ApiError('FORBIDDEN');
    }
    return project;
  }

  private canConfigure(project: Project) {
    return this.isOrgAdmin(project.organizationId) || this.projectRole(project.id) === 'SUPER';
  }

  /** Test helper: a valid project as the signed-in org admin would create it. */
  seedProject(organizationId: string, overrides: Partial<CreateProjectInput> = {}) {
    return this.createProject({
      organizationId,
      name: 'Main Street Tower',
      projectNumber: 'MST-1',
      address: '100 Main St, Houston, TX',
      centerLat: 29.7604,
      centerLng: -95.3698,
      ianaTimezone: 'America/Chicago',
      radiusM: 150,
      operates24x7: false,
      workWindows: [1, 2, 3, 4, 5, 6].map((weekday) => ({
        weekday,
        local_start_time: '06:00',
        local_end_time: '18:00',
      })),
      entryDwellSeconds: 600,
      maxHorizontalAccuracyM: 75,
      idempotencyKey: randomUUID(),
      ...overrides,
    });
  }

  async createOrganization(input: {
    name: string;
    address: string;
    businessEmail: string;
    phone: string;
    idempotencyKey: string;
  }) {
    this.before('createOrganization');
    const existing = this.world.orgs.find((o) => o.idempotencyKey === input.idempotencyKey);
    if (existing) return this.after(existing.id);
    const id = this.world.addOrganization(input.name);
    const org = this.world.orgs.find((o) => o.id === id);
    if (org) org.idempotencyKey = input.idempotencyKey;
    return this.after(id);
  }

  async listOrganizations(): Promise<OrganizationSummary[]> {
    this.before('listOrganizations');
    return this.world.orgs
      .filter((o) => this.isOrgAdmin(o.id))
      .map(({ id, name }) => ({ id, name }));
  }

  async listProjects(): Promise<ProjectSummary[]> {
    this.before('listProjects');
    return this.world.projects
      .filter((p) => this.isOrgAdmin(p.organizationId) || this.projectRole(p.id))
      .map((p) => {
        const current = p.versions[p.versions.length - 1];
        return {
          id: p.id,
          organization_id: p.organizationId,
          organization_name: this.world.orgs.find((o) => o.id === p.organizationId)?.name ?? '',
          name: p.name,
          project_number: p.number,
          status: p.status,
          address: p.address,
          iana_timezone: p.timeZone,
          config_version: current?.number ?? null,
          radius_m: current?.radiusM ?? null,
          operates_24_7: current?.operates24x7 ?? null,
        };
      });
  }

  async getProject(projectId: string): Promise<ProjectDetail> {
    this.before('getProject');
    const p = this.project(projectId);
    const current = p.versions[p.versions.length - 1];
    if (!current) throw new ApiError('UNKNOWN');
    const canAssign = this.isOrgAdmin(p.organizationId);
    return {
      project: {
        id: p.id,
        organization_id: p.organizationId,
        name: p.name,
        project_number: p.number,
        address: p.address,
        iana_timezone: p.timeZone,
        status: p.status,
      },
      config: {
        version_id: current.id,
        version_number: current.number,
        effective_at: current.effectiveAt,
        settings: {
          geofence_radius_m: current.radiusM,
          exit_hysteresis_m: TRACKING_DEFAULTS.exit_hysteresis_m,
          entry_dwell_seconds: current.dwell,
          max_horizontal_accuracy_m: current.accuracy,
          operates_24_7: current.operates24x7,
          work_windows: current.windows,
        },
        sha256: 'f'.repeat(64),
        center_lat: current.centerLat,
        center_lng: current.centerLng,
        radius_m: current.radiusM,
        exit_hysteresis_m: TRACKING_DEFAULTS.exit_hysteresis_m,
      },
      versions: [...p.versions]
        .reverse()
        .map((v) => ({ version_number: v.number, effective_at: v.effectiveAt, reason: v.reason })),
      staff: p.staff.map((s) => ({
        id: s.id,
        user_id: s.userId,
        role: s.role,
        emergency_designated: s.emergency,
        email: s.email,
      })),
      invitations: canAssign
        ? this.world.invitations
            .filter((i) => i.projectId === p.id && !i.used && !i.revoked && i.projectRole)
            .map((i) => ({
              id: i.id,
              email: i.email,
              role: i.projectRole ?? 'SUPER',
              expires_at: '2026-11-11T12:00:00Z',
            }))
        : [],
      permissions: {
        can_configure: this.canConfigure(p),
        can_assign_staff: canAssign,
        can_run_orientation: this.canRunOrientation(p.id),
        can_view_roster: this.canViewRoster(p.id),
        can_operate_kiosk: this.projectRole(p.id) === 'ATTENDANT',
        can_run_visitor_desk: this.projectRole(p.id) === 'ATTENDANT',
        can_correct_attendance: this.canCorrectAttendance(p.id),
      },
    };
  }

  async checkSite(input: {
    organizationId: string;
    name: string;
    centerLat: number;
    centerLng: number;
    radiusM: number;
    excludeProjectId?: string;
  }): Promise<SiteCheck> {
    this.before('checkSite');
    if (!this.isOrgAdmin(input.organizationId)) throw new ApiError('FORBIDDEN');
    const mine = this.world.projects.filter(
      (p) => p.organizationId === input.organizationId && p.id !== input.excludeProjectId,
    );
    const overlaps = mine
      .filter((p) => p.status !== 'ARCHIVED')
      .flatMap((p) => {
        const v = p.versions[p.versions.length - 1];
        if (!v) return [];
        const distance = haversine(v.centerLat, v.centerLng, input.centerLat, input.centerLng);
        return distance <= v.radiusM + 50 + input.radiusM + 50
          ? [{ project_id: p.id, name: p.name, distance_m: Math.round(distance) }]
          : [];
      });
    const needle = input.name.trim().toLowerCase();
    const similar_names = mine
      .filter((p) => {
        const name = p.name.toLowerCase();
        return needle.length > 0 && (name.includes(needle) || needle.includes(name));
      })
      .map((p) => ({ project_id: p.id, name: p.name }));
    return { overlaps, similar_names };
  }

  async createProject(input: CreateProjectInput) {
    this.before('createProject');
    if (!this.isOrgAdmin(input.organizationId)) throw new ApiError('FORBIDDEN');
    const existing = this.world.projects.find(
      (p) => p.organizationId === input.organizationId && p.idempotencyKey === input.idempotencyKey,
    );
    if (existing) return this.after(existing.id);
    if (input.name.trim().length === 0) throw new ApiError('NAME_REQUIRED');
    if (!isValidTimeZone(input.ianaTimezone)) throw new ApiError('INVALID_TIMEZONE');
    const windows = checkBounds(input);
    const id = randomUUID();
    this.world.projects.push({
      id,
      organizationId: input.organizationId,
      name: input.name.trim(),
      number: input.projectNumber.trim() || null,
      address: input.address.trim() || null,
      timeZone: input.ianaTimezone,
      status: 'DRAFT',
      idempotencyKey: input.idempotencyKey,
      versions: [
        {
          id: randomUUID(),
          number: 1,
          effectiveAt: '2026-11-04T14:00:00Z',
          reason: 'Project created',
          centerLat: input.centerLat,
          centerLng: input.centerLng,
          radiusM: input.radiusM,
          operates24x7: input.operates24x7,
          windows,
          dwell: input.entryDwellSeconds,
          accuracy: input.maxHorizontalAccuracyM,
          idempotencyKey: input.idempotencyKey,
        },
      ],
      staff: [
        {
          id: randomUUID(),
          userId: this.world.access.user_id,
          email: this.world.email,
          role: 'PM',
          emergency: false,
        },
      ],
    });
    return this.after(id);
  }

  async updateConfig(
    input: SiteConfigInput & {
      projectId: string;
      reason: string;
      confirmSensitive: boolean;
      idempotencyKey: string;
    },
  ) {
    this.before('updateConfig');
    const p = this.project(input.projectId);
    if (!this.canConfigure(p)) throw new ApiError('FORBIDDEN');
    const replay = p.versions.find((v) => v.idempotencyKey === input.idempotencyKey);
    if (replay) return this.after(replay.id);
    if (p.status === 'COMPLETED' || p.status === 'ARCHIVED') throw new ApiError('PROJECT_CLOSED');
    const windows = checkBounds(input);
    const current = p.versions[p.versions.length - 1];
    if (!current) throw new ApiError('UNKNOWN');
    const sensitive: string[] = [];
    if (input.operates24x7 !== current.operates24x7) sensitive.push('OPERATES_24_7');
    if (input.entryDwellSeconds < current.dwell) sensitive.push('DWELL_REDUCED');
    if (input.maxHorizontalAccuracyM > current.accuracy) sensitive.push('ACCURACY_LOOSENED');
    if (input.radiusM > current.radiusM) sensitive.push('GEOFENCE_ENLARGED');
    if (haversine(current.centerLat, current.centerLng, input.centerLat, input.centerLng) > 1) {
      sensitive.push('GEOFENCE_MOVED');
    }
    if (sensitive.length > 0 && (!input.confirmSensitive || input.reason.trim().length < 3)) {
      throw new ApiError('SENSITIVE_CHANGE_REQUIRES_CONFIRMATION', sensitive.join(','));
    }
    if (input.reason.trim().length < 3) throw new ApiError('REASON_REQUIRED');
    const version: Version = {
      id: randomUUID(),
      number: current.number + 1,
      effectiveAt: '2026-11-04T15:00:00Z',
      reason: input.reason.trim(),
      centerLat: input.centerLat,
      centerLng: input.centerLng,
      radiusM: input.radiusM,
      operates24x7: input.operates24x7,
      windows,
      dwell: input.entryDwellSeconds,
      accuracy: input.maxHorizontalAccuracyM,
      idempotencyKey: input.idempotencyKey,
    };
    p.versions.push(version);
    return this.after(version.id);
  }

  async setStatus(projectId: string, status: ProjectStatus, reason: string | null) {
    this.before('setStatus');
    const p = this.project(projectId);
    if (!this.canConfigure(p)) throw new ApiError('FORBIDDEN');
    if (p.status === status) return;
    if (!NEXT_STATUSES[p.status].includes(status)) throw new ApiError('INVALID_STATUS_TRANSITION');
    if (STATUSES_NEEDING_REASON.includes(status) && (reason ?? '').trim().length < 3) {
      throw new ApiError('REASON_REQUIRED');
    }
    p.status = status;
  }

  async inviteStaff(input: InviteStaffInput) {
    this.before('inviteStaff');
    const p = this.project(input.projectId);
    if (!this.isOrgAdmin(p.organizationId)) throw new ApiError('FORBIDDEN');
    if (!EMAIL.test(input.email.trim().toLowerCase())) throw new ApiError('INVALID_EMAIL');
    const id = randomUUID();
    this.world.invitations.push({
      id,
      organizationId: p.organizationId,
      projectId: p.id,
      email: input.email.trim().toLowerCase(),
      orgRole: null,
      projectRole: input.role,
      emergency: input.emergencyDesignated,
      used: false,
      revoked: false,
    });
    return id;
  }

  async inviteOrgAdmin(organizationId: string, email: string) {
    this.before('inviteOrgAdmin');
    if (
      !this.world.access.org_roles.some(
        (r) => r.organization_id === organizationId && r.role === 'OWNER',
      )
    ) {
      throw new ApiError('FORBIDDEN');
    }
    if (!EMAIL.test(email)) throw new ApiError('INVALID_EMAIL');
    const id = randomUUID();
    this.world.invitations.push({
      id,
      organizationId,
      projectId: null,
      email,
      orgRole: 'ADMIN',
      projectRole: null,
      emergency: false,
      used: false,
      revoked: false,
    });
    return id;
  }

  async revokeInvitation(invitationId: string) {
    this.before('revokeInvitation');
    const invitation = this.world.invitations.find((i) => i.id === invitationId);
    if (!invitation || !this.isOrgAdmin(invitation.organizationId)) throw new ApiError('FORBIDDEN');
    invitation.revoked = true;
  }

  async removeStaff(staffId: string, reason: string) {
    this.before('removeStaff');
    if (reason.trim().length < 3) throw new ApiError('REASON_REQUIRED');
    for (const p of this.world.projects) {
      if (p.staff.some((s) => s.id === staffId)) {
        if (!this.isOrgAdmin(p.organizationId)) throw new ApiError('FORBIDDEN');
        p.staff = p.staff.filter((s) => s.id !== staffId);
      }
    }
  }

  async myInvitations(): Promise<MyInvitation[]> {
    this.before('myInvitations');
    return this.world.invitations
      .filter((i) => i.email === this.world.email && !i.used && !i.revoked)
      .map((i) => ({
        invitation_id: i.id,
        organization_id: i.organizationId,
        organization_name: this.world.orgs.find((o) => o.id === i.organizationId)?.name ?? '',
        project_id: i.projectId,
        project_name: this.world.projects.find((p) => p.id === i.projectId)?.name ?? null,
        org_role: i.orgRole,
        project_role: i.projectRole,
        expires_at: '2026-11-11T12:00:00Z',
      }));
  }

  async acceptInvitation(invitationId: string) {
    this.before('acceptInvitation');
    const invitation = this.world.invitations.find(
      (i) => i.id === invitationId && i.email === this.world.email,
    );
    if (!invitation) throw new ApiError('INVITATION_NOT_FOUND');
    if (invitation.used || invitation.revoked) throw new ApiError('INVITATION_NOT_ACTIVE');
    invitation.used = true;
    const { access } = this.world;
    if (invitation.projectId && invitation.projectRole) {
      const project = this.world.projects.find((p) => p.id === invitation.projectId);
      project?.staff.push({
        id: randomUUID(),
        userId: access.user_id,
        email: this.world.email,
        role: invitation.projectRole,
        emergency: invitation.emergency,
      });
      this.world.access = {
        ...access,
        project_roles: [
          ...access.project_roles,
          { project_id: invitation.projectId, role: invitation.projectRole },
        ],
      };
    } else {
      this.world.access = {
        ...access,
        org_roles: [
          ...access.org_roles,
          { organization_id: invitation.organizationId, role: 'ADMIN' },
        ],
      };
    }
  }

  async searchAddress(query: string, _sessionToken: string, _locale: Locale) {
    this.before('searchAddress');
    return {
      provider: 'development_fake' as const,
      candidates: [1, 2].map((n) => ({
        placeId: `dev-place-${n}-${query.trim().toLowerCase().replace(/\s+/g, '-')}`,
        primaryText: `${query.trim()} ${n}`,
        secondaryText: 'Development address (not real)',
      })),
    };
  }

  async resolveAddress(placeId: string, _sessionToken: string, _locale: Locale) {
    this.before('resolveAddress');
    return {
      placeId,
      formattedAddress: `Development address ${placeId.slice(-6)} (not real)`,
      lat: 29.7604,
      lng: -95.3698,
      attribution: 'Development fake (no provider)',
      provider: 'development_fake' as const,
    };
  }

  // ---------------------------------------------------------------- Milestone 05

  private canRunOrientation(projectId: string) {
    const project = this.world.projects.find((p) => p.id === projectId);
    if (!project) return false;
    const role = this.projectRole(projectId);
    return (
      this.isOrgAdmin(project.organizationId) ||
      role === 'PM' ||
      role === 'SUPER' ||
      role === 'SAFETY'
    );
  }

  private canViewRoster(projectId: string) {
    return this.canRunOrientation(projectId) || this.projectRole(projectId) === 'ATTENDANT';
  }

  /** Mirrors can_correct_attendance: the organization OWNER or assigned PM/SUPER (MFA). */
  private canCorrectAttendance(projectId: string) {
    const project = this.world.projects.find((p) => p.id === projectId);
    if (!project) return false;
    const role = this.projectRole(projectId);
    const owner = this.world.access.org_roles.some(
      (r) => r.organization_id === project.organizationId && r.role === 'OWNER',
    );
    return owner || role === 'PM' || role === 'SUPER';
  }

  private myWorker() {
    return this.world.workers.find((w) => w.userId === this.world.access.user_id) ?? null;
  }

  private sessionFromCode(code: string): FakeSession {
    const [kind, sessionId] = code.split('.');
    const session = this.world.sessions.find((s) => s.session_id === sessionId);
    if ((kind !== 'SMO1' && kind !== 'SMS1') || !session)
      throw new ApiError('ORIENTATION_CODE_INVALID');
    if (!session.open) throw new ApiError('ORIENTATION_SESSION_CLOSED');
    return session;
  }

  private checkDetails(input: {
    legalName: string;
    companyId: string | null;
    companyName: string;
    emergencyName: string;
    emergencyPhone: string;
  }) {
    if (!input.legalName.trim()) throw new ApiError('NAME_REQUIRED');
    if (!input.emergencyName.trim() || input.emergencyPhone.trim().length < 7) {
      throw new ApiError('EMERGENCY_CONTACT_REQUIRED');
    }
    if (!input.companyId && !input.companyName.trim()) throw new ApiError('COMPANY_REQUIRED');
  }

  private companyFor(projectId: string, companyId: string | null, companyName: string) {
    if (companyId) {
      const found = this.world.companies.find(
        (c) => c.id === companyId && c.projectId === projectId,
      );
      if (!found) throw new ApiError('COMPANY_NOT_ON_PROJECT');
      return found.id;
    }
    const existing = this.world.companies.find(
      (c) => c.projectId === projectId && c.name.toLowerCase() === companyName.trim().toLowerCase(),
    );
    if (existing) return existing.id;
    const created = { id: randomUUID(), name: companyName.trim(), projectId };
    this.world.companies.push(created);
    return created.id;
  }

  async startOrientation(projectId: string, _idempotencyKey: string) {
    this.before('startOrientation');
    if (!this.canRunOrientation(projectId)) throw new ApiError('FORBIDDEN');
    const project = this.world.projects.find((p) => p.id === projectId);
    if (project?.status !== 'ACTIVE') throw new ApiError('PROJECT_NOT_ACTIVE');
    for (const s of this.world.sessions) if (s.project_id === projectId) s.open = false;
    const session: FakeSession = {
      session_id: randomUUID(),
      project_id: projectId,
      starts_at: '2026-11-04T14:00:00Z',
      expires_at: '2026-11-04T16:00:00Z',
      rotating_secret: FAKE_ROTATING_SECRET,
      static_code: 'S'.repeat(43),
      open: true,
      completed: 0,
    };
    this.world.sessions.push(session);
    return this.after({ ...session });
  }

  async getOrientationSession(sessionId: string) {
    this.before('getOrientationSession');
    const session = this.world.sessions.find((s) => s.session_id === sessionId);
    if (!session || !this.canRunOrientation(session.project_id)) throw new ApiError('FORBIDDEN');
    if (!session.open) throw new ApiError('ORIENTATION_SESSION_CLOSED');
    return { ...session };
  }

  async listOrientationSessions(projectId: string): Promise<OrientationSessionSummary[]> {
    this.before('listOrientationSessions');
    if (!this.canRunOrientation(projectId)) throw new ApiError('FORBIDDEN');
    return this.world.sessions
      .filter((s) => s.project_id === projectId)
      .reverse()
      .map((s) => ({
        session_id: s.session_id,
        starts_at: s.starts_at,
        expires_at: s.expires_at,
        open: s.open,
        completed_count: s.completed,
      }));
  }

  async closeOrientation(projectId: string, sessionId: string) {
    this.before('closeOrientation');
    if (!this.canRunOrientation(projectId)) throw new ApiError('FORBIDDEN');
    const session = this.world.sessions.find((s) => s.session_id === sessionId);
    if (session) session.open = false;
  }

  async previewOrientation(code: string, locale: Locale): Promise<OrientationPreview> {
    this.before('previewOrientation');
    const session = this.sessionFromCode(code);
    const project = this.world.projects.find((p) => p.id === session.project_id);
    const worker = this.myWorker();
    const existing = worker
      ? this.world.enrollments.find(
          (e) =>
            e.workerId === worker.id &&
            e.projectId === session.project_id &&
            e.status !== 'REJECTED',
        )
      : undefined;
    const joinToken = randomUUID().replace(/-/g, '').padEnd(43, 'J');
    this.world.joinPasses.set(joinToken, {
      sessionId: session.session_id,
      userId: this.world.access.user_id,
    });
    return {
      join_token: joinToken,
      session_id: session.session_id,
      project_id: session.project_id,
      project_name: project?.name ?? '',
      organization_name: this.world.orgs.find((o) => o.id === project?.organizationId)?.name ?? '',
      session_expires_at: session.expires_at,
      notice: FAKE_NOTICES[locale],
      notice_acceptable: true,
      companies: this.world.companies
        .filter((c) => c.projectId === session.project_id)
        .map(({ id, name }) => ({ id, name })),
      profile: worker ? { legal_name: worker.legalName, primary_language: locale } : null,
      existing_enrollment: existing
        ? { enrollment_status: existing.status, employer_status: existing.employer }
        : null,
    };
  }

  async completeOrientation(input: JoinInput) {
    this.before('completeOrientation');
    const pass = this.world.joinPasses.get(input.joinToken);
    if (!pass || pass.userId !== this.world.access.user_id) {
      throw new ApiError('ORIENTATION_CODE_INVALID');
    }
    const session = this.world.sessions.find((s) => s.session_id === pass.sessionId);
    if (!session?.open) throw new ApiError('ORIENTATION_SESSION_CLOSED');
    this.checkDetails(input);
    if (FAKE_NOTICES[input.locale].id !== input.noticeVersionId)
      throw new ApiError('NOTICE_OUTDATED');
    if (!input.accept) throw new ApiError('CONSENT_REQUIRED');
    let worker = this.myWorker();
    if (!worker) {
      worker = {
        id: randomUUID(),
        userId: this.world.access.user_id,
        legalName: input.legalName,
        managed: false,
        emergency: null,
      };
      this.world.workers.push(worker);
      this.world.access = { ...this.world.access, worker_profile_id: worker.id };
    }
    worker.legalName = input.legalName.trim();
    worker.emergency = {
      name: input.emergencyName.trim(),
      phone: input.emergencyPhone.trim(),
      relationship: input.emergencyRelationship.trim() || null,
    };
    const companyId = this.companyFor(session.project_id, input.companyId, input.companyName);
    session.completed += 1;
    let enrollment = this.world.enrollments.find(
      (e) =>
        e.workerId === worker.id &&
        e.projectId === session.project_id &&
        (e.status === 'PENDING' || e.status === 'APPROVED'),
    );
    if (!enrollment) {
      enrollment = {
        id: randomUUID(),
        projectId: session.project_id,
        workerId: worker.id,
        companyId,
        trade: input.trade.trim() || null,
        status: 'PENDING',
        employer: 'PENDING_CONFIRMATION',
        consent: 'DIGITAL',
        oriented: true,
      };
      this.world.enrollments.push(enrollment);
    }
    return this.after({ enrollment_id: enrollment.id, enrollment_status: enrollment.status });
  }

  async myEnrollments(): Promise<MyEnrollment[]> {
    this.before('myEnrollments');
    const worker = this.myWorker();
    if (!worker) return [];
    return this.world.enrollments
      .filter((e) => e.workerId === worker.id)
      .map((e) => {
        const project = this.world.projects.find((p) => p.id === e.projectId);
        return {
          enrollment_id: e.id,
          project_id: e.projectId,
          project_name: project?.name ?? '',
          organization_name:
            this.world.orgs.find((o) => o.id === project?.organizationId)?.name ?? '',
          project_status: project?.status ?? 'ACTIVE',
          iana_timezone: project?.timeZone ?? 'America/Chicago',
          enrollment_status: e.status,
          employer_status: e.employer,
          company_name: this.world.companies.find((c) => c.id === e.companyId)?.name ?? null,
          trade: e.trade,
          orientation_completed_at: '2026-11-04T14:30:00Z',
        };
      });
  }

  async getMyEmergencyContact() {
    this.before('getMyEmergencyContact');
    return this.myWorker()?.emergency ?? null;
  }

  async updateMyEmergencyContact(contact: EmergencyContact) {
    this.before('updateMyEmergencyContact');
    const worker = this.myWorker();
    if (!worker) throw new ApiError('WORKER_PROFILE_REQUIRED');
    if (!contact.name.trim() || contact.phone.trim().length < 7)
      throw new ApiError('EMERGENCY_CONTACT_REQUIRED');
    worker.emergency = { ...contact };
  }

  async listEnrollments(projectId: string): Promise<RosterEntry[]> {
    this.before('listEnrollments');
    if (!this.canViewRoster(projectId)) throw new ApiError('FORBIDDEN');
    return this.world.enrollments
      .filter((e) => e.projectId === projectId)
      .map((e) => {
        const worker = this.world.workers.find((w) => w.id === e.workerId);
        return {
          enrollment_id: e.id,
          worker_id: e.workerId,
          legal_name: worker?.legalName ?? '',
          managed_identity: worker?.managed ?? false,
          company_id: e.companyId,
          company_name: this.world.companies.find((c) => c.id === e.companyId)?.name ?? null,
          trade: e.trade,
          enrollment_status: e.status,
          employer_status: e.employer,
          orientation_completed_at: '2026-11-04T14:30:00Z',
          consent_method: e.consent,
          printed_badge_active: this.world.printedBadges.some(
            (b) => b.workerId === e.workerId && b.active,
          ),
          created_at: '2026-11-04T14:30:00Z',
        };
      });
  }

  async bulkApprove(projectId: string, enrollmentIds: string[]): Promise<BulkResult[]> {
    this.before('bulkApprove');
    if (!this.canRunOrientation(projectId)) throw new ApiError('FORBIDDEN');
    if (enrollmentIds.length > 100) throw new ApiError('TOO_MANY_ENROLLMENTS');
    return [...new Set(enrollmentIds)].map((id) => {
      const e = this.world.enrollments.find((x) => x.id === id && x.projectId === projectId);
      if (!e) return { enrollment_id: id, result: 'NOT_FOUND' };
      if (e.status === 'APPROVED') return { enrollment_id: id, result: 'ALREADY_APPROVED' };
      if (e.status !== 'PENDING') return { enrollment_id: id, result: 'NOT_PENDING' };
      if (!e.oriented) return { enrollment_id: id, result: 'ORIENTATION_MISSING' };
      e.status = 'APPROVED';
      return { enrollment_id: id, result: 'APPROVED' };
    });
  }

  async confirmEmployer(
    projectId: string,
    enrollmentIds: string[],
    decision: 'VERIFIED' | 'REJECTED',
  ) {
    this.before('confirmEmployer');
    if (!this.canRunOrientation(projectId)) throw new ApiError('FORBIDDEN');
    return enrollmentIds.map((id) => {
      const e = this.world.enrollments.find((x) => x.id === id && x.projectId === projectId);
      if (!e) return { enrollment_id: id, result: 'NOT_FOUND' };
      if (e.employer === decision) return { enrollment_id: id, result: 'UNCHANGED' };
      e.employer = decision;
      return { enrollment_id: id, result: decision };
    });
  }

  async decideEnrollment(enrollmentId: string, decision: 'REJECTED' | 'REVOKED', reason: string) {
    this.before('decideEnrollment');
    const e = this.world.enrollments.find((x) => x.id === enrollmentId);
    if (!e || !this.canRunOrientation(e.projectId)) throw new ApiError('FORBIDDEN');
    if (reason.trim().length < 3) throw new ApiError('REASON_REQUIRED');
    if (decision === 'REJECTED' && e.status === 'PENDING') e.status = 'REJECTED';
    else if (decision === 'REVOKED' && e.status === 'APPROVED') e.status = 'REVOKED';
    else throw new ApiError('INVALID_DECISION');
  }

  async getProjectNotice(projectId: string, locale: Locale) {
    this.before('getProjectNotice');
    if (!this.canViewRoster(projectId)) throw new ApiError('FORBIDDEN');
    return { notice: FAKE_NOTICES[locale], notice_acceptable: true };
  }

  async createManagedWorker(input: ManagedWorkerInput) {
    this.before('createManagedWorker');
    if (!this.canViewRoster(input.projectId)) throw new ApiError('FORBIDDEN');
    this.checkDetails(input);
    if (FAKE_NOTICES[input.locale].id !== input.noticeVersionId)
      throw new ApiError('NOTICE_OUTDATED');
    if (!input.acknowledged) throw new ApiError('CONSENT_REQUIRED');
    const companyId = this.companyFor(input.projectId, input.companyId, input.companyName);
    const worker: FakeWorker = {
      id: randomUUID(),
      userId: null,
      legalName: input.legalName.trim(),
      managed: true,
      emergency: {
        name: input.emergencyName,
        phone: input.emergencyPhone,
        relationship: input.emergencyRelationship || null,
      },
    };
    this.world.workers.push(worker);
    const enrollment: FakeEnrollment = {
      id: randomUUID(),
      projectId: input.projectId,
      workerId: worker.id,
      companyId,
      trade: input.trade.trim() || null,
      status: 'PENDING',
      employer: 'PENDING_CONFIRMATION',
      consent: 'SUPERVISED',
      oriented: true,
    };
    this.world.enrollments.push(enrollment);
    return { worker_id: worker.id, enrollment_id: enrollment.id };
  }

  async issuePrintedBadge(projectId: string, workerId: string): Promise<PrintedBadge> {
    this.before('issuePrintedBadge');
    if (!this.canViewRoster(projectId)) throw new ApiError('FORBIDDEN');
    if (
      !this.world.enrollments.some(
        (e) => e.projectId === projectId && e.workerId === workerId && e.status === 'APPROVED',
      )
    ) {
      throw new ApiError('ENROLLMENT_NOT_APPROVED');
    }
    for (const b of this.world.printedBadges) if (b.workerId === workerId) b.active = false;
    const badge = { id: randomUUID(), workerId, active: true };
    this.world.printedBadges.push(badge);
    return {
      badge_id: badge.id,
      code: `SMP1.${'P'.repeat(32)}`,
      issued_at: '2026-11-04T15:00:00Z',
    };
  }

  async revokePrintedBadge(projectId: string, badgeId: string, reason: string) {
    this.before('revokePrintedBadge');
    if (!this.canViewRoster(projectId)) throw new ApiError('FORBIDDEN');
    if (reason.trim().length < 3) throw new ApiError('REASON_REQUIRED');
    const badge = this.world.printedBadges.find((b) => b.id === badgeId);
    if (badge) badge.active = false;
  }

  async activateDevice(_input: DeviceActivateRequest): Promise<DeviceActivateResponse> {
    this.before('activateDevice');
    if (!this.myWorker()) throw new ApiError('WORKER_PROFILE_REQUIRED');
    const previous = this.world.device?.device_id ?? null;
    this.world.device = {
      schema_version: 1,
      request_id: randomUUID(),
      device_id: randomUUID(),
      replaced_device_id: previous,
      badge_secret: FAKE_BADGE_SECRET,
      upload_token: 'T'.repeat(43),
      upload_expires_at: '2026-12-04T00:00:00Z',
    };
    return this.world.device;
  }

  async getTrackingPlan(_appVersion: string): Promise<TrackingPlan> {
    this.before('getTrackingPlan');
    if (!this.myWorker()) throw new ApiError('WORKER_PROFILE_REQUIRED');
    return (
      this.world.trackingPlan ?? {
        device_id: this.world.device?.device_id ?? null,
        platform: this.world.device ? 'IOS' : null,
        credential: { status: this.world.device ? 'OK' : 'NONE', expires_at: null },
        coordinates_allowed: true,
        projects: [],
        not_monitored: [],
      }
    );
  }

  async revokeMyDevice(): Promise<void> {
    this.before('revokeMyDevice');
    this.world.device = null;
  }

  // ---------------------------------------------------------------- Milestone 08

  async registerKiosk(projectId: string, devicePublicId: string): Promise<KioskRegistration> {
    this.before('registerKiosk');
    if (this.projectRole(projectId) !== 'ATTENDANT') throw new ApiError('FORBIDDEN');
    const existing = this.world.kiosks.find((k) => k.project_id === projectId);
    if (existing) return existing;
    const kiosk: KioskRegistration = {
      kiosk_device_id: randomUUID(),
      project_id: projectId,
      status: 'ACTIVE',
    };
    void devicePublicId;
    this.world.kiosks.push(kiosk);
    return kiosk;
  }

  async ingestOperations(request: IngestOperationsRequest): Promise<IngestOperationsResponse> {
    this.before('ingestOperations');
    if (this.world.operationsOffline) throw new ApiError('NETWORK');
    const results: OperationResult[] = request.events.map((event) => {
      const previous = this.world.operationReceipts.get(event.event_uuid);
      if (previous) {
        return {
          ...previous,
          status: 'duplicate',
          ...(previous.status === 'duplicate' ? {} : { original_status: previous.status }),
        };
      }
      const result = this.fakeOperation(event);
      this.world.operationReceipts.set(event.event_uuid, result);
      return result;
    });
    return { schema_version: 1, request_id: randomUUID(), results };
  }

  private fakeOperation(event: IngestOperationsRequest['events'][number]): OperationResult {
    const base = { event_uuid: event.event_uuid };
    switch (event.operation_type) {
      case 'KIOSK_ENTRY':
      case 'KIOSK_EXIT': {
        const workerId = this.world.badgeWorkers.get(event.payload.badge_payload);
        if (!workerId) return { ...base, status: 'rejected', reason: 'BADGE_INVALID' };
        if (this.world.redeemedBadges.has(event.payload.badge_payload)) {
          return { ...base, status: 'rejected', reason: 'BADGE_REPLAY' };
        }
        this.world.redeemedBadges.add(event.payload.badge_payload);
        return { ...base, status: 'accepted', reason: null, worker_id: workerId };
      }
      case 'FOREMAN_BULK_ENTRY':
      case 'FOREMAN_BULK_EXIT': {
        const crew = this.world.crews.get(`${event.project_id}|${event.payload.subcontractor_id}`);
        if (!crew) return { ...base, status: 'rejected', reason: 'COMPANY_NOT_AUTHORIZED' };
        const children: OperationChildResult[] = event.payload.worker_ids.map((workerId) => ({
          worker_id: workerId,
          child_event_uuid: randomUUID(),
          status: crew.some((m) => m.worker_id === workerId) ? 'accepted' : 'rejected',
          reason: crew.some((m) => m.worker_id === workerId) ? null : 'WORKER_NOT_IN_COMPANY',
        }));
        const rejected = children.filter((c) => c.status === 'rejected').length;
        return {
          ...base,
          status: rejected === children.length ? 'rejected' : 'accepted',
          reason: rejected === 0 ? null : 'SOME_WORKERS_REJECTED',
          children,
        };
      }
      case 'MANUAL_ATTENDANCE_CORRECTION': {
        if (!this.canCorrectAttendance(event.project_id)) {
          return { ...base, status: 'rejected', reason: 'FORBIDDEN' };
        }
        // Approving a correction request: the change and the approval are one (Milestone 10).
        const requestId = event.payload.request_id;
        if (requestId) {
          const request = this.world.correctionRequests.find((r) => r.request_id === requestId);
          if (!request || request.worker_id !== event.payload.worker_id) {
            return { ...base, status: 'rejected', reason: 'REQUEST_NOT_FOUND' };
          }
          if (request.status !== 'PENDING') {
            return { ...base, status: 'rejected', reason: 'REQUEST_ALREADY_DECIDED' };
          }
          request.status = 'APPROVED';
          request.decided_at = new Date(this.world.now).toISOString();
        }
        return { ...base, status: 'accepted', reason: null };
      }
      case 'VISITOR_ENTRY': {
        this.world.visits.push({
          visit_id: event.event_uuid,
          visitor_id: event.payload.visitor_id ?? event.event_uuid,
          name: event.payload.name ?? '',
          organization: event.payload.organization ?? null,
          host_user_id: event.payload.host_user_id,
          purpose: event.payload.purpose,
          checked_in_at: event.observed_at,
          status: 'OPEN',
        });
        return { ...base, status: 'accepted', reason: null };
      }
      case 'VISITOR_EXIT': {
        const index = this.world.visits.findIndex((v) => v.visitor_id === event.payload.visitor_id);
        if (index < 0) return { ...base, status: 'rejected', reason: 'VISIT_NOT_FOUND' };
        this.world.visits.splice(index, 1);
        return { ...base, status: 'accepted', reason: null };
      }
      case 'MUSTER_SELF_REPORT':
      case 'MUSTER_PHYSICAL_VERIFY':
        return this.fakeMusterOperation(event);
      default:
        return { ...base, status: 'rejected', reason: 'OPERATION_NOT_SUPPORTED' };
    }
  }

  async myForemanProjects(): Promise<ForemanProject[]> {
    this.before('myForemanProjects');
    return this.world.foremanProjects;
  }

  async foremanCrew(projectId: string, companyId: string): Promise<CrewMember[]> {
    this.before('foremanCrew');
    const crew = this.world.crews.get(`${projectId}|${companyId}`);
    if (!crew) throw new ApiError('FORBIDDEN');
    return crew;
  }

  async openVisitorVisits(projectId: string): Promise<OpenVisit[]> {
    this.before('openVisitorVisits');
    if (!this.canViewRoster(projectId)) throw new ApiError('FORBIDDEN');
    return this.world.visits;
  }

  async workerAttendanceSessions(
    projectId: string,
    workerId: string,
  ): Promise<CorrectableSession[]> {
    this.before('workerAttendanceSessions');
    if (!this.canCorrectAttendance(projectId)) throw new ApiError('FORBIDDEN');
    return this.world.correctable.get(`${projectId}|${workerId}`) ?? [];
  }

  // ---------------------------------------------------------------- Milestone 09

  /** Mirrors can_view_locations: the organization OWNER or assigned PM/SUPER/SAFETY (MFA). */
  private canViewLocations(projectId: string) {
    const project = this.world.projects.find((p) => p.id === projectId);
    if (!project) return false;
    const role = this.projectRole(projectId);
    const owner = this.world.access.org_roles.some(
      (r) => r.organization_id === project.organizationId && r.role === 'OWNER',
    );
    return owner || role === 'PM' || role === 'SUPER' || role === 'SAFETY';
  }

  private members(projectId: string): WorkforceMember[] {
    return this.world.enrollments
      .filter((e) => e.projectId === projectId && e.status === 'APPROVED')
      .map((e) => {
        const worker = this.world.workers.find((w) => w.id === e.workerId);
        const p = { ...DEFAULT_PRESENCE, ...this.world.presence.get(e.id) };
        return {
          worker_id: e.workerId,
          enrollment_id: e.id,
          legal_name: worker?.legalName ?? '',
          managed_identity: worker?.managed ?? false,
          company_id: e.companyId,
          company_name: this.world.companies.find((c) => c.id === e.companyId)?.name ?? null,
          trade: e.trade,
          employer_status: e.employer,
          presence: p.presence,
          counted: p.counted,
          source: p.source,
          witnessed: p.witnessed,
          arrived_at: p.arrivedAt,
          last_seen_at: p.lastSeenAt,
          session_status: p.counted ? 'OPEN' : null,
          needs_review: p.needsReview,
          tracking: p.tracking,
        };
      })
      .sort(
        (a, b) => Number(b.counted) - Number(a.counted) || a.legal_name.localeCompare(b.legal_name),
      );
  }

  async projectDashboard(projectId: string): Promise<ProjectDashboard> {
    this.before('projectDashboard');
    if (this.world.readsOffline) throw new ApiError('NETWORK');
    if (!this.canViewRoster(projectId)) throw new ApiError('FORBIDDEN');
    const p = this.project(projectId);
    const members = this.members(projectId);
    const counted = members.filter((m) => m.counted);
    const bySource: ProjectDashboard['counts']['onsite_by_source'] = {};
    for (const m of counted) if (m.source) bySource[m.source] = (bySource[m.source] ?? 0) + 1;
    const group = <K extends string | null>(key: (m: WorkforceMember) => K) => {
      const map = new Map<K, WorkforceMember[]>();
      for (const m of members) map.set(key(m), [...(map.get(key(m)) ?? []), m]);
      return [...map.entries()];
    };
    const now = new Date().toISOString();
    return this.after({
      project: { id: p.id, name: p.name, status: p.status, iana_timezone: p.timeZone },
      counts: {
        approved_roster: members.length,
        estimated_onsite: counted.length,
        onsite_by_source: bySource,
        manually_verified: counted.filter((m) => m.witnessed).length,
        presence_unknown: members.filter((m) => m.presence === 'PRESENCE_UNKNOWN').length,
        arriving: members.filter((m) => m.presence === 'ARRIVING').length,
        unscheduled_pending: members.filter((m) => m.presence === 'UNSCHEDULED_PENDING').length,
        departure_pending: members.filter((m) => m.presence === 'DEPARTURE_PENDING').length,
        unresolved_sessions: members.filter((m) => m.needs_review).length,
        visitors_onsite: this.world.visits.filter((v) => v.status === 'OPEN').length,
        visitors_unresolved: this.world.visits.filter((v) => v.status === 'UNRESOLVED').length,
        evaluated_at: now,
      },
      today: {
        local_date: now.slice(0, 10),
        arrivals: members.filter((m) => m.arrived_at).length,
        departures: 0,
      },
      companies: group((m) => m.company_id).map(([companyId, rows]) => ({
        company_id: companyId,
        company_name: rows[0]?.company_name ?? null,
        approved: rows.length,
        estimated_onsite: rows.filter((m) => m.counted).length,
        manually_verified: rows.filter((m) => m.counted && m.witnessed).length,
        presence_unknown: rows.filter((m) => m.presence === 'PRESENCE_UNKNOWN').length,
      })),
      trades: group((m) => m.trade).map(([trade, rows]) => ({
        trade,
        approved: rows.length,
        estimated_onsite: rows.filter((m) => m.counted).length,
      })),
      approvals: {
        pending_enrollments: this.world.enrollments.filter(
          (e) => e.projectId === projectId && e.status === 'PENDING',
        ).length,
        employer_pending: members.filter((m) => m.employer_status === 'PENDING_CONFIRMATION')
          .length,
      },
      can_view_map: this.canViewLocations(projectId),
      evaluated_at: now,
    });
  }

  async workforceRoster(projectId: string): Promise<WorkforceMember[]> {
    this.before('workforceRoster');
    if (this.world.readsOffline) throw new ApiError('NETWORK');
    if (!this.canViewRoster(projectId)) throw new ApiError('FORBIDDEN');
    return this.after(this.members(projectId));
  }

  async projectMap(projectId: string): Promise<ProjectMap> {
    this.before('projectMap');
    if (this.world.readsOffline) throw new ApiError('NETWORK');
    if (!this.canViewLocations(projectId)) throw new ApiError('FORBIDDEN');
    const version = this.project(projectId).versions.at(-1);
    return this.after({
      site: version
        ? {
            center_lat: version.centerLat,
            center_lng: version.centerLng,
            radius_m: version.radiusM,
            exit_hysteresis_m: 50,
          }
        : null,
      fresh_seconds: 600,
      // Like project_map: only workers whose enrollment is still approved.
      markers: (this.world.markers.get(projectId) ?? []).filter((marker) =>
        this.world.enrollments.some(
          (e) =>
            e.projectId === projectId && e.workerId === marker.worker_id && e.status === 'APPROVED',
        ),
      ),
      evaluated_at: new Date().toISOString(),
    });
  }

  subscribeProject(projectId: string, listener: ProjectChannelListener): () => void {
    this.world.calls.push('subscribeProject');
    const listeners = this.world.channels.get(projectId) ?? new Set<ProjectChannelListener>();
    listeners.add(listener);
    this.world.channels.set(projectId, listeners);
    let active = true;
    const authorized = this.canViewRoster(projectId);
    // Like Realtime, the join answers asynchronously.
    setTimeout(() => {
      if (active) listener.onStatus(authorized ? this.world.channelMode : 'DENIED');
    }, 0);
    return () => {
      active = false;
      listeners.delete(listener);
    };
  }

  // ---------------------------------------------------------------- Milestone 10

  private foremanCompanies(projectId: string): string[] {
    return this.world.foremanProjects
      .filter((p) => p.project_id === projectId)
      .map((p) => p.company_id);
  }

  /** The newest version per company, status as readers see it (overdue = NOT_CONFIRMED). */
  private reportViews(filter: (r: ReportView) => boolean): ReportView[] {
    const latest = new Map<string, ReportView>();
    for (const report of this.world.reports.filter(filter)) {
      const key = `${report.project_id}|${report.company_id}|${report.local_date}`;
      const seen = latest.get(key);
      if (!seen || seen.version < report.version) latest.set(key, report);
    }
    return [...latest.values()].map((report) => {
      const overdue =
        report.status === 'PENDING_CONFIRMATION' && Date.parse(report.due_at) <= this.world.now;
      const status = overdue ? 'NOT_CONFIRMED' : report.status;
      const history = this.world.reports.filter(
        (r) =>
          r.project_id === report.project_id &&
          r.company_id === report.company_id &&
          r.local_date === report.local_date,
      );
      return {
        ...report,
        status,
        can_answer:
          status === 'PENDING_CONFIRMATION' &&
          this.foremanCompanies(report.project_id).includes(report.company_id),
        earlier_versions: history
          .filter((r) => r.version < report.version)
          .sort((a, b) => a.version - b.version)
          .map((r) => ({ version: r.version, status: r.status })),
      };
    });
  }

  private reportsResponse(reports: ReportView[], dayOpen = false): DailyReportsResponse {
    return { schema_version: 1, request_id: randomUUID(), day_open: dayOpen, reports };
  }

  async listReports(projectId: string, localDate: string): Promise<DailyReportsResponse> {
    this.before('listReports');
    if (this.world.readsOffline) throw new ApiError('NETWORK');
    const staff = this.canViewRoster(projectId);
    const companies = this.foremanCompanies(projectId);
    if (!staff && companies.length === 0) throw new ApiError('FORBIDDEN');
    return this.reportsResponse(
      this.reportViews(
        (r) =>
          r.project_id === projectId &&
          r.local_date === localDate &&
          (staff || companies.includes(r.company_id)),
      ),
      this.world.openDays.has(localDate),
    );
  }

  async pendingReports(): Promise<DailyReportsResponse> {
    this.before('pendingReports');
    if (this.world.readsOffline) throw new ApiError('NETWORK');
    return this.reportsResponse(
      this.reportViews((r) => this.foremanCompanies(r.project_id).includes(r.company_id)).filter(
        (r) => r.status === 'PENDING_CONFIRMATION',
      ),
    );
  }

  async reissueReport(input: {
    projectId: string;
    companyId: string;
    localDate: string;
    reason: string;
  }): Promise<DailyReportsResponse> {
    this.before('reissueReport');
    if (!this.canCorrectAttendance(input.projectId)) throw new ApiError('FORBIDDEN');
    if (input.reason.trim().length < 3) throw new ApiError('INVALID_REQUEST');
    const history = this.world.reports.filter(
      (r) =>
        r.project_id === input.projectId &&
        r.company_id === input.companyId &&
        r.local_date === input.localDate,
    );
    const latest = history.sort((a, b) => b.version - a.version)[0];
    if (!latest) throw new ApiError('NOT_FOUND');
    latest.status = 'SUPERSEDED';
    this.world.reports.push({
      ...latest,
      report_id: randomUUID(),
      version: latest.version + 1,
      status: 'PENDING_CONFIRMATION',
      due_at: new Date(this.world.now + 86_400_000).toISOString(),
      generated_at: new Date(this.world.now).toISOString(),
    });
    return this.after(await this.listReports(input.projectId, input.localDate));
  }

  async answerReport(request: ReportConfirmRequest): Promise<ReportConfirmResponse> {
    this.before('answerReport');
    const report = this.world.reports.find((r) => r.report_id === request.report_id);
    if (!report || !this.foremanCompanies(report.project_id).includes(report.company_id)) {
      throw new ApiError('FORBIDDEN');
    }
    const duplicate = this.world.answers.find((a) => a.event_uuid === request.event_uuid);
    if (duplicate) {
      return {
        schema_version: 1,
        request_id: randomUUID(),
        report_id: report.report_id,
        version: report.version,
        status: report.status,
        duplicate: true,
      };
    }
    if (report.version !== request.version || report.status === 'SUPERSEDED') {
      throw new ApiError('REPORT_VERSION_STALE');
    }
    if (report.status === 'PENDING_CONFIRMATION' && Date.parse(report.due_at) <= this.world.now) {
      report.status = 'NOT_CONFIRMED';
      throw new ApiError('REPORT_DEADLINE_PASSED');
    }
    if (report.status !== 'PENDING_CONFIRMATION') throw new ApiError('REPORT_ALREADY_ANSWERED');
    if (request.action !== 'CONFIRM' && !request.reason) throw new ApiError('REASON_REQUIRED');
    this.world.answers.push(request);
    report.status =
      request.action === 'CONFIRM'
        ? 'CONFIRMED'
        : request.action === 'DISPUTE'
          ? 'DISPUTED'
          : 'CORRECTION_REQUESTED';
    report.answers = [
      ...report.answers,
      {
        version: report.version,
        action: request.action,
        comment: request.reason,
        created_at: new Date(this.world.now).toISOString(),
      },
    ];
    for (const proposal of request.proposed) {
      const worker = this.world.workers.find((w) => w.id === proposal.worker_id);
      this.world.correctionRequests.push({
        request_id: randomUUID(),
        worker_id: proposal.worker_id,
        worker_name: worker?.legalName ?? report.worker_names[proposal.worker_id] ?? '',
        company_name: report.company_name,
        channel: 'FOREMAN_REQUEST',
        session_id: proposal.session_id,
        original: {},
        proposed: {
          proposed_start_at: proposal.proposed_start_at,
          proposed_end_at: proposal.proposed_end_at,
          note: proposal.note,
        },
        reason: request.reason ?? '',
        status: 'PENDING',
        decision_reason: null,
        created_at: new Date(this.world.now).toISOString(),
        decided_at: null,
      });
    }
    return this.after({
      schema_version: 1,
      request_id: randomUUID(),
      report_id: report.report_id,
      version: report.version,
      status: report.status,
      duplicate: false,
    });
  }

  async myAttendance(projectId: string, _from: string, _to: string): Promise<MyAttendance> {
    this.before('myAttendance');
    if (this.world.readsOffline) throw new ApiError('NETWORK');
    const mine = this.world.attendance.get(projectId);
    if (!mine) throw new ApiError('FORBIDDEN');
    // A fresh answer each time, like the server (never the stored object itself).
    return { ...mine, sessions: [...mine.sessions], requests: [...mine.requests] };
  }

  async requestCorrection(input: CorrectionRequestInput) {
    this.before('requestCorrection');
    const mine = this.world.attendance.get(input.projectId);
    if (!mine) throw new ApiError('FORBIDDEN');
    const seen = this.world.correctionRequests.find((r) => r.request_id === input.eventUuid);
    if (seen) return { request_id: seen.request_id, duplicate: true };
    if (input.reason.trim().length < 3) throw new ApiError('REASON_REQUIRED');
    const request = {
      request_id: input.eventUuid,
      session_id: input.sessionId,
      status: 'PENDING' as const,
      reason: input.reason.trim(),
      proposed: { proposed_start_at: input.proposedStartAt, proposed_end_at: input.proposedEndAt },
      decision_reason: null,
      created_at: new Date(this.world.now).toISOString(),
    };
    mine.requests = [request, ...mine.requests];
    this.world.correctionRequests.push({
      ...request,
      worker_id: this.myWorker()?.id ?? '',
      worker_name: this.myWorker()?.legalName ?? '',
      company_name: null,
      channel: 'WORKER_REQUEST',
      original: {},
      decided_at: null,
    });
    return this.after({ request_id: request.request_id, duplicate: false });
  }

  async correctionRequests(projectId: string): Promise<CorrectionRequestRow[]> {
    this.before('correctionRequests');
    if (!this.canCorrectAttendance(projectId)) throw new ApiError('FORBIDDEN');
    return this.world.correctionRequests.map((request) => ({ ...request }));
  }

  async rejectCorrectionRequest(requestId: string, reason: string): Promise<void> {
    this.before('rejectCorrectionRequest');
    const request = this.world.correctionRequests.find((r) => r.request_id === requestId);
    if (!request) throw new ApiError('FORBIDDEN');
    if (request.status !== 'PENDING') throw new ApiError('REQUEST_ALREADY_DECIDED');
    if (reason.trim().length < 3) throw new ApiError('REASON_REQUIRED');
    request.status = 'REJECTED';
    request.decision_reason = reason.trim();
    request.decided_at = new Date(this.world.now).toISOString();
    this.after(undefined);
  }

  async foremanKioskGrants(projectId: string): Promise<ForemanKioskGrant[]> {
    this.before('foremanKioskGrants');
    if (!this.canCorrectAttendance(projectId)) throw new ApiError('FORBIDDEN');
    return (this.world.kioskGrants.get(projectId) ?? []).map((grant) => ({ ...grant }));
  }

  async setForemanKioskGrant(input: {
    projectId: string;
    companyId: string;
    foremanProfileId: string;
    enabled: boolean;
    reason: string;
  }): Promise<void> {
    this.before('setForemanKioskGrant');
    if (!this.canCorrectAttendance(input.projectId)) throw new ApiError('FORBIDDEN');
    if (input.reason.trim().length < 3) throw new ApiError('REASON_REQUIRED');
    const grant = (this.world.kioskGrants.get(input.projectId) ?? []).find(
      (g) => g.foreman_profile_id === input.foremanProfileId && g.company_id === input.companyId,
    );
    if (!grant) throw new ApiError('FOREMAN_NOT_FOUND');
    grant.can_operate_kiosk = input.enabled;
    this.after(undefined);
  }

  // ---------------------------------------------------------------- Milestone 11

  /** Mirrors can_command_muster: an assigned SAFETY role (emergency designation, decision #53). */
  private canCommandMuster(projectId: string) {
    return this.projectRole(projectId) === 'SAFETY';
  }

  private muster(musterId: string): FakeMuster {
    const muster = this.world.musters.find((m) => m.id === musterId);
    if (!muster) throw new ApiError('FORBIDDEN');
    return muster;
  }

  private musterCounts(muster: FakeMuster) {
    const workers = muster.members.filter((m) => m.kind === 'WORKER');
    const visitors = muster.members.filter((m) => m.kind === 'VISITOR');
    const count = (rows: MusterMemberRow[], status: string) =>
      rows.filter((m) => m.status === status).length;
    return {
      workers: {
        total: workers.length,
        verified: count(workers, 'VERIFIED_ACCOUNTED'),
        self_reported: count(workers, 'SELF_REPORTED_SAFE'),
        unknown: count(workers, 'STATUS_UNKNOWN'),
        unaccounted: count(workers, 'UNACCOUNTED'),
        detected_at_start: workers.filter((m) => m.source.startsWith('ONSITE')).length,
      },
      visitors: {
        total: visitors.length,
        verified: count(visitors, 'VERIFIED_ACCOUNTED'),
        unaccounted: visitors.length - count(visitors, 'VERIFIED_ACCOUNTED'),
      },
    };
  }

  private fakeMusterOperation(event: IngestOperationsRequest['events'][number]): OperationResult {
    const base = { event_uuid: event.event_uuid };
    if (
      event.operation_type !== 'MUSTER_SELF_REPORT' &&
      event.operation_type !== 'MUSTER_PHYSICAL_VERIFY'
    ) {
      return { ...base, status: 'rejected', reason: 'OPERATION_NOT_SUPPORTED' };
    }
    const payload = event.payload;
    const muster = this.world.musters.find((m) => m.id === payload.muster_id);
    if (!muster) return { ...base, status: 'rejected', reason: 'NOT_IN_MUSTER' };
    if (muster.status === 'CLOSED') return { ...base, status: 'rejected', reason: 'MUSTER_CLOSED' };
    let member: MusterMemberRow | undefined;
    if (event.operation_type === 'MUSTER_SELF_REPORT') {
      const me = this.myWorker();
      member = muster.members.find((m) => m.worker_id === me?.id);
      if (!member) return { ...base, status: 'rejected', reason: 'FORBIDDEN' };
      if (member.status !== 'VERIFIED_ACCOUNTED') member.status = 'SELF_REPORTED_SAFE';
      member.last_response = {
        action: 'SELF_REPORT',
        channel: payload.channel ?? 'APP',
        at: event.observed_at,
      };
      return {
        ...base,
        status: 'accepted',
        reason: null,
        ...(member.worker_id ? { worker_id: member.worker_id } : {}),
      };
    }
    if (payload.badge_payload) {
      const workerId = this.world.badgeWorkers.get(payload.badge_payload);
      member = muster.members.find((m) => m.worker_id === workerId);
    } else {
      member = muster.members.find((m) => m.member_id === payload.snapshot_member_id);
      const foreman = this.world.foremanProjects.some(
        (p) => p.project_id === muster.projectId && p.company_id === member?.company_id,
      );
      const allowed =
        this.canCommandMuster(muster.projectId) ||
        foreman ||
        (member?.kind === 'VISITOR' && this.projectRole(muster.projectId) === 'ATTENDANT');
      if (member && !allowed) return { ...base, status: 'rejected', reason: 'FORBIDDEN' };
    }
    if (!member) return { ...base, status: 'rejected', reason: 'NOT_IN_MUSTER' };
    member.status = 'VERIFIED_ACCOUNTED';
    member.last_response = {
      action: 'PHYSICAL_VERIFICATION',
      channel: payload.badge_payload ? 'KIOSK' : 'SAFETY_STAFF',
      at: event.observed_at,
    };
    return {
      ...base,
      status: 'accepted',
      reason: null,
      ...(member.worker_id ? { worker_id: member.worker_id } : {}),
    };
  }

  /** Test helper: a muster as the server would freeze it (approved roster + open visits). */
  seedMuster(projectId: string, label = 'Fire alarm'): FakeMuster {
    const members: MusterMemberRow[] = this.world.enrollments
      .filter((e) => e.projectId === projectId && e.status === 'APPROVED')
      .map((e) => {
        const worker = this.world.workers.find((w) => w.id === e.workerId);
        return {
          member_id: randomUUID(),
          kind: 'WORKER' as const,
          worker_id: e.workerId,
          visitor_id: null,
          name: worker?.legalName ?? '',
          company_id: e.companyId,
          company_name: this.world.companies.find((c) => c.id === e.companyId)?.name ?? null,
          organization: null,
          source: this.world.presence.get(e.id)?.counted
            ? 'ONSITE_GEOFENCE'
            : 'ROSTER_NOT_DETECTED',
          last_detection_at: null,
          initial_status: 'UNACCOUNTED' as const,
          status: 'UNACCOUNTED' as const,
          push: this.world.pushTokens.some((t) => t.userId === worker?.userId)
            ? ('SENT' as const)
            : ('NO_DEVICE' as const),
          last_response: null,
        };
      });
    for (const visit of this.world.visits) {
      members.push({
        member_id: randomUUID(),
        kind: 'VISITOR',
        worker_id: null,
        visitor_id: visit.visitor_id,
        name: visit.name,
        company_id: null,
        company_name: null,
        organization: visit.organization,
        source: 'VISITOR',
        last_detection_at: visit.checked_in_at,
        initial_status: 'UNACCOUNTED',
        status: 'UNACCOUNTED',
        push: null,
        last_response: null,
      });
    }
    const muster: FakeMuster = {
      id: randomUUID(),
      projectId,
      label,
      status: 'ACTIVE',
      startedAt: new Date(this.world.now).toISOString(),
      endedAt: null,
      note: null,
      members,
      amendments: [],
      idempotencyKeys: new Set(),
    };
    this.world.musters.push(muster);
    return muster;
  }

  async startMuster(input: {
    projectId: string;
    label: string;
    idempotencyKey: string;
    separate?: boolean;
  }) {
    this.before('startMuster');
    if (!this.canCommandMuster(input.projectId)) throw new ApiError('FORBIDDEN');
    if (!input.label.trim()) throw new ApiError('LABEL_REQUIRED');
    const byKey = this.world.musters.find((m) => m.idempotencyKeys.has(input.idempotencyKey));
    const active = this.world.musters.find(
      (m) => m.projectId === input.projectId && m.status === 'ACTIVE',
    );
    const reused = byKey ?? (input.separate ? undefined : active);
    if (reused) {
      return {
        schema_version: 1 as const,
        request_id: randomUUID(),
        muster_id: reused.id,
        created: false,
        duplicate: Boolean(byKey),
        already_active: !byKey,
        push: null,
      };
    }
    const muster = this.seedMuster(input.projectId, input.label.trim());
    muster.idempotencyKeys.add(input.idempotencyKey);
    const targets = muster.members.filter((m) => m.push === 'SENT').length;
    if (this.world.pushOutage) {
      for (const m of muster.members) if (m.push === 'SENT') m.push = 'FAILED';
    }
    return this.after({
      schema_version: 1 as const,
      request_id: randomUUID(),
      muster_id: muster.id,
      created: true,
      duplicate: false,
      already_active: false,
      push: {
        provider: 'development-fake' as const,
        targets,
        sent: this.world.pushOutage ? 0 : targets,
        failed: this.world.pushOutage ? targets : 0,
      },
    });
  }

  async closeMuster(input: { musterId: string; note: string; acknowledgeIncomplete: boolean }) {
    this.before('closeMuster');
    const muster = this.muster(input.musterId);
    if (!this.canCommandMuster(muster.projectId)) throw new ApiError('FORBIDDEN');
    const digest = 'd'.repeat(64);
    if (muster.status === 'CLOSED') {
      return {
        schema_version: 1 as const,
        request_id: randomUUID(),
        muster_id: muster.id,
        duplicate: true,
        digest,
        counts: this.musterCounts(muster),
      };
    }
    if (input.note.trim().length < 3) throw new ApiError('REASON_REQUIRED');
    const unresolved = muster.members.some(
      (m) => m.status === 'UNACCOUNTED' || m.status === 'STATUS_UNKNOWN',
    );
    if (unresolved && !input.acknowledgeIncomplete)
      throw new ApiError('ACKNOWLEDGE_INCOMPLETE_REQUIRED');
    muster.status = 'CLOSED';
    muster.endedAt = new Date(this.world.now).toISOString();
    muster.note = input.note.trim();
    return this.after({
      schema_version: 1 as const,
      request_id: randomUUID(),
      muster_id: muster.id,
      duplicate: false,
      digest,
      counts: this.musterCounts(muster),
    });
  }

  async projectMusters(projectId: string): Promise<ProjectMusters> {
    this.before('projectMusters');
    if (this.world.readsOffline) throw new ApiError('NETWORK');
    if (!this.canViewRoster(projectId)) throw new ApiError('FORBIDDEN');
    return {
      can_command: this.canCommandMuster(projectId),
      musters: this.world.musters
        .filter((m) => m.projectId === projectId)
        .map((m) => ({
          muster_id: m.id,
          incident_label: m.label,
          status: m.status,
          started_at: m.startedAt,
          ended_at: m.endedAt,
          counts: this.musterCounts(m),
        })),
    };
  }

  private boardOf(muster: FakeMuster, members: MusterMemberRow[]): MusterBoard {
    const companies = new Map<string, MusterMemberRow[]>();
    for (const m of muster.members.filter((x) => x.kind === 'WORKER')) {
      companies.set(m.company_id ?? '', [...(companies.get(m.company_id ?? '') ?? []), m]);
    }
    return {
      muster_id: muster.id,
      project_id: muster.projectId,
      project_name: this.world.projects.find((p) => p.id === muster.projectId)?.name ?? '',
      incident_label: muster.label,
      status: muster.status,
      started_at: muster.startedAt,
      ended_at: muster.endedAt,
      evaluated_at: new Date(this.world.now).toISOString(),
      can_command: this.canCommandMuster(muster.projectId),
      can_verify_visitors:
        this.canCommandMuster(muster.projectId) ||
        this.projectRole(muster.projectId) === 'ATTENDANT',
      counts: this.musterCounts(muster),
      companies: [...companies.entries()].map(([id, rows]) => ({
        company_id: id || null,
        company_name: rows[0]?.company_name ?? null,
        total: rows.length,
        verified: rows.filter((r) => r.status === 'VERIFIED_ACCOUNTED').length,
        self_reported: rows.filter((r) => r.status === 'SELF_REPORTED_SAFE').length,
        unknown: rows.filter((r) => r.status === 'STATUS_UNKNOWN').length,
        unaccounted: rows.filter((r) => r.status === 'UNACCOUNTED').length,
      })),
      push: {
        sent: muster.members.filter((m) => m.push === 'SENT').length,
        failed: muster.members.filter((m) => m.push === 'FAILED').length,
        no_device: muster.members.filter((m) => m.push === 'NO_DEVICE').length,
      },
      members: members.map((m) => ({ ...m })),
    };
  }

  async musterBoard(musterId: string): Promise<MusterBoard> {
    this.before('musterBoard');
    if (this.world.readsOffline) throw new ApiError('NETWORK');
    const muster = this.muster(musterId);
    if (!this.canViewRoster(muster.projectId)) throw new ApiError('FORBIDDEN');
    return this.boardOf(muster, muster.members);
  }

  async myActiveMusters(): Promise<MyMuster[]> {
    this.before('myActiveMusters');
    if (this.world.readsOffline) throw new ApiError('NETWORK');
    const me = this.myWorker();
    return this.world.musters.flatMap((m) => {
      const member =
        m.status === 'ACTIVE' ? m.members.find((x) => x.worker_id === me?.id) : undefined;
      return member
        ? [
            {
              muster_id: m.id,
              project_id: m.projectId,
              project_name: this.world.projects.find((p) => p.id === m.projectId)?.name ?? '',
              incident_label: m.label,
              started_at: m.startedAt,
              member_id: member.member_id,
              status: member.status,
              self_reported:
                member.last_response?.action === 'SELF_REPORT' ||
                member.status === 'SELF_REPORTED_SAFE',
            },
          ]
        : [];
    });
  }

  async foremanActiveMusters(): Promise<ForemanMusterSummary[]> {
    this.before('foremanActiveMusters');
    return this.world.musters
      .filter(
        (m) =>
          m.status === 'ACTIVE' &&
          this.world.foremanProjects.some((p) => p.project_id === m.projectId),
      )
      .map((m) => ({
        muster_id: m.id,
        project_id: m.projectId,
        project_name: this.world.projects.find((p) => p.id === m.projectId)?.name ?? '',
        incident_label: m.label,
        started_at: m.startedAt,
      }));
  }

  async foremanMuster(musterId: string): Promise<MusterBoard> {
    this.before('foremanMuster');
    const muster = this.muster(musterId);
    const companies = this.world.foremanProjects
      .filter((p) => p.project_id === muster.projectId)
      .map((p) => p.company_id);
    if (companies.length === 0) throw new ApiError('FORBIDDEN');
    const board = this.boardOf(
      muster,
      muster.members.filter((m) => m.kind === 'WORKER' && companies.includes(m.company_id ?? '')),
    );
    return {
      ...board,
      counts: undefined,
      companies: undefined,
      push: undefined,
      can_command: undefined,
      can_verify_visitors: undefined,
    };
  }

  async musterReport(musterId: string): Promise<MusterReportView> {
    this.before('musterReport');
    const muster = this.muster(musterId);
    if (!this.canViewRoster(muster.projectId)) throw new ApiError('FORBIDDEN');
    if (muster.status !== 'CLOSED') throw new ApiError('MUSTER_NOT_CLOSED');
    return {
      report: {
        notice: 'SUPPLEMENTAL_NOT_LIFE_SAFETY',
        incident_label: muster.label,
        project_name: this.world.projects.find((p) => p.id === muster.projectId)?.name ?? '',
        started_at: muster.startedAt,
        started_by: 'safety@example.test',
        ended_at: muster.endedAt ?? '',
        ended_by: 'safety@example.test',
        closing_note: muster.note ?? '',
        acknowledged_incomplete: true,
        snapshot_digest: 'e'.repeat(64),
        counts: this.musterCounts(muster),
        members: muster.members.map((m) => ({
          member_id: m.member_id,
          kind: m.kind,
          name: m.name,
          company_name: m.company_name,
          organization: m.organization,
          source: m.source,
          initial_status: m.initial_status,
          final_status: m.status,
          push: m.push,
          responses: m.last_response ? [{ ...m.last_response, responder: null }] : [],
        })),
        push: {
          sent: muster.members.filter((m) => m.push === 'SENT').length,
          failed: muster.members.filter((m) => m.push === 'FAILED').length,
          no_device: muster.members.filter((m) => m.push === 'NO_DEVICE').length,
          not_attempted: 0,
        },
      },
      digest: 'd'.repeat(64),
      can_amend: this.canCommandMuster(muster.projectId),
      amendments: muster.amendments.map((a) => ({ ...a })),
    };
  }

  async amendMuster(input: {
    musterId: string;
    memberId: string | null;
    note: string;
    eventUuid: string;
  }) {
    this.before('amendMuster');
    const muster = this.muster(input.musterId);
    if (!this.canCommandMuster(muster.projectId)) throw new ApiError('FORBIDDEN');
    if (muster.status !== 'CLOSED') throw new ApiError('MUSTER_NOT_CLOSED');
    if (input.note.trim().length < 3) throw new ApiError('REASON_REQUIRED');
    muster.amendments.push({
      kind: 'CORRECTION',
      action: null,
      channel: null,
      observed_at: new Date(this.world.now).toISOString(),
      note: input.note.trim(),
      member_name: muster.members.find((m) => m.member_id === input.memberId)?.name ?? null,
      actor: 'safety@example.test',
      digest: 'f'.repeat(64),
    });
    this.after(undefined);
  }

  async registerPushToken(input: {
    installationId: string;
    token: string;
    platform: 'IOS' | 'ANDROID';
  }) {
    this.before('registerPushToken');
    if (!/^Expo(nent)?PushToken\[/.test(input.token)) throw new ApiError('PUSH_TOKEN_INVALID');
    const userId = this.world.access.user_id;
    const index = this.world.pushTokens.findIndex((t) => t.userId === userId);
    if (index >= 0) this.world.pushTokens.splice(index, 1);
    this.world.pushTokens.push({ userId, token: input.token });
    this.after(undefined);
  }

  async revokeMyPushTokens(_installationId: string) {
    this.before('revokeMyPushTokens');
    const userId = this.world.access.user_id;
    for (let i = this.world.pushTokens.length - 1; i >= 0; i -= 1) {
      if (this.world.pushTokens[i]?.userId === userId) this.world.pushTokens.splice(i, 1);
    }
    this.after(undefined);
  }

  async renewDeviceWithSession(_appVersion: string): Promise<DeviceRenewResponse> {
    this.before('renewDeviceWithSession');
    if (!this.world.device) throw new ApiError('NO_DEVICE');
    return {
      schema_version: 1,
      request_id: randomUUID(),
      device_id: this.world.device.device_id,
      upload_token: FAKE_BADGE_SECRET,
      upload_expires_at: '2026-12-04T00:00:00Z',
      renew_after: '2026-11-27T00:00:00Z',
      access_token: FAKE_BADGE_SECRET,
      refresh_token: FAKE_BADGE_SECRET,
      expires: Math.floor(Date.parse('2026-11-27T00:00:00Z') / 1000),
    };
  }
}
