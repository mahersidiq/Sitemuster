import type { SupabaseClient } from '@supabase/supabase-js';

import {
  AddressResolveResponseSchema,
  AddressSearchResponseSchema,
  type Locale,
  type ProjectStatus,
} from '@sitemuster/shared';

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
} from './types';

/** Converts a PostgREST/Functions error into a stable machine code (never a fake success). */
export function toApiError(
  error: { message?: string; code?: string; status?: number; name?: string } | null,
): ApiError {
  if (!error) return new ApiError('UNKNOWN');
  // Server functions raise stable machine codes ("CODE" or "CODE: detail").
  const match = /^([A-Z][A-Z0-9_]+)(?::\s*(.*))?$/.exec(error.message ?? '');
  if (match?.[1]) return new ApiError(match[1], match[2] ?? null);
  if (
    error.name === 'FunctionsFetchError' ||
    error.name === 'TypeError' ||
    /fetch|network/i.test(error.message ?? '')
  ) {
    return new ApiError('NETWORK');
  }
  if (error.code === 'PGRST301' || error.code === 'PGRST302')
    return new ApiError('UNAUTHENTICATED');
  if (error.code === '42501') return new ApiError('FORBIDDEN');
  return new ApiError('UNKNOWN');
}

export class SupabaseSiteMusterApi implements SiteMusterApi {
  constructor(private readonly client: SupabaseClient) {}

  private async rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
    const { data, error } = await this.client.rpc(fn, args);
    if (error) throw toApiError(error);
    return data as T;
  }

  createOrganization(input: {
    name: string;
    address: string;
    businessEmail: string;
    phone: string;
    idempotencyKey: string;
  }) {
    return this.rpc<string>('create_organization', {
      p_name: input.name,
      p_idempotency_key: input.idempotencyKey,
      p_address: input.address || null,
      p_business_email: input.businessEmail || null,
      p_phone: input.phone || null,
    });
  }

  async listOrganizations(): Promise<OrganizationSummary[]> {
    // RLS limits this to organizations the caller belongs to or works in (server-enforced).
    const { data, error } = await this.client
      .from('organizations')
      .select('id, name')
      .order('name');
    if (error) throw toApiError(error);
    return (data ?? []) as OrganizationSummary[];
  }

  listProjects() {
    return this.rpc<ProjectSummary[]>('list_my_projects');
  }

  getProject(projectId: string) {
    return this.rpc<ProjectDetail>('get_project_detail', { p_project_id: projectId });
  }

  checkSite(input: {
    organizationId: string;
    name: string;
    centerLat: number;
    centerLng: number;
    radiusM: number;
    excludeProjectId?: string;
  }) {
    return this.rpc<SiteCheck>('check_project_site', {
      p_organization_id: input.organizationId,
      p_name: input.name,
      p_center_lat: input.centerLat,
      p_center_lng: input.centerLng,
      p_radius_m: input.radiusM,
      p_exclude_project: input.excludeProjectId ?? null,
    });
  }

  createProject(input: CreateProjectInput) {
    return this.rpc<string>('create_project', {
      p_organization_id: input.organizationId,
      p_name: input.name,
      p_project_number: input.projectNumber,
      p_address: input.address,
      p_center_lat: input.centerLat,
      p_center_lng: input.centerLng,
      p_iana_timezone: input.ianaTimezone,
      p_radius_m: input.radiusM,
      p_operates_24_7: input.operates24x7,
      p_work_windows: input.workWindows,
      p_idempotency_key: input.idempotencyKey,
      p_entry_dwell_seconds: input.entryDwellSeconds,
      p_max_horizontal_accuracy_m: input.maxHorizontalAccuracyM,
    });
  }

  updateConfig(
    input: SiteConfigInput & {
      projectId: string;
      reason: string;
      confirmSensitive: boolean;
      idempotencyKey: string;
    },
  ) {
    return this.rpc<string>('update_project_config', {
      p_project_id: input.projectId,
      p_center_lat: input.centerLat,
      p_center_lng: input.centerLng,
      p_radius_m: input.radiusM,
      p_operates_24_7: input.operates24x7,
      p_work_windows: input.workWindows,
      p_entry_dwell_seconds: input.entryDwellSeconds,
      p_max_horizontal_accuracy_m: input.maxHorizontalAccuracyM,
      p_reason: input.reason,
      p_confirm_sensitive: input.confirmSensitive,
      p_idempotency_key: input.idempotencyKey,
    });
  }

  async setStatus(projectId: string, status: ProjectStatus, reason: string | null) {
    await this.rpc('set_project_status', {
      p_project_id: projectId,
      p_status: status,
      p_reason: reason,
    });
  }

  inviteStaff(input: InviteStaffInput) {
    return this.rpc<string>('invite_project_staff', {
      p_project_id: input.projectId,
      p_email: input.email,
      p_role: input.role,
      p_emergency_designated: input.emergencyDesignated,
      p_can_configure_project: input.canConfigureProject,
      p_can_assign_staff: input.canAssignStaff,
      p_can_approve_corrections: input.canApproveCorrections,
    });
  }

  inviteOrgAdmin(organizationId: string, email: string) {
    return this.rpc<string>('invite_org_admin', {
      p_organization_id: organizationId,
      p_email: email,
    });
  }

  async revokeInvitation(invitationId: string) {
    await this.rpc('revoke_invitation', { p_invitation_id: invitationId });
  }

  async removeStaff(staffId: string, reason: string) {
    await this.rpc('remove_project_staff', { p_staff_id: staffId, p_reason: reason });
  }

  myInvitations() {
    return this.rpc<MyInvitation[]>('list_my_invitations');
  }

  async acceptInvitation(invitationId: string) {
    await this.rpc('accept_invitation', { p_invitation_id: invitationId });
  }

  private async invoke(fn: string, body: Record<string, unknown>): Promise<unknown> {
    const { data, error } = await this.client.functions.invoke(fn, { body });
    if (error) {
      const context = (error as { context?: Response }).context;
      if (context && typeof context.json === 'function') {
        const payload = (await context.json().catch(() => null)) as {
          error?: { code?: string };
        } | null;
        if (payload?.error?.code) throw new ApiError(payload.error.code);
      }
      throw toApiError(error);
    }
    return data;
  }

  async searchAddress(query: string, sessionToken: string, locale: Locale) {
    const parsed = AddressSearchResponseSchema.parse(
      await this.invoke('address-search', { query, session_token: sessionToken, locale }),
    );
    return {
      provider: parsed.provider,
      candidates: parsed.candidates.map((c) => ({
        placeId: c.place_id,
        primaryText: c.primary_text,
        secondaryText: c.secondary_text,
      })),
    };
  }

  async resolveAddress(placeId: string, sessionToken: string, locale: Locale) {
    const parsed = AddressResolveResponseSchema.parse(
      await this.invoke('address-resolve', {
        place_id: placeId,
        session_token: sessionToken,
        locale,
      }),
    );
    return {
      placeId: parsed.place_id,
      formattedAddress: parsed.formatted_address,
      lat: parsed.lat,
      lng: parsed.lng,
      attribution: parsed.attribution,
      provider: parsed.provider,
    };
  }
}
