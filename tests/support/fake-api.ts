import { randomUUID } from 'node:crypto';

import {
  normalizeWorkWindows,
  TRACKING_DEFAULTS,
  type Locale,
  type ProjectStaffRole,
  type ProjectStatus,
  type WorkWindow,
} from '@sitemuster/shared';

import type { Access } from '../../src/auth/access';
import {
  ApiError,
  type CreateProjectInput,
  type InviteStaffInput,
  type MyInvitation,
  type OrganizationSummary,
  type ProjectDetail,
  type ProjectSummary,
  type SiteCheck,
  type SiteConfigInput,
  type SiteMusterApi,
} from '../../src/api/types';
import { isValidTimeZone } from '../../src/projects/format';
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
export class FakeWorld {
  readonly orgs: { id: string; name: string; idempotencyKey: string }[];
  readonly projects: Project[];
  readonly invitations: Invitation[];
  readonly calls: string[] = [];

  constructor(
    public access: Access,
    public email: string,
    shared?: FakeWorld,
  ) {
    this.orgs = shared?.orgs ?? [];
    this.projects = shared?.projects ?? [];
    this.invitations = shared?.invitations ?? [];
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
}

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
      permissions: { can_configure: this.canConfigure(p), can_assign_staff: canAssign },
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
}
