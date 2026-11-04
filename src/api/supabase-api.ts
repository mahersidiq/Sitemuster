import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';

import {
  AddressResolveResponseSchema,
  AddressSearchResponseSchema,
  BulkApproveResultSchema,
  DeviceActivateResponseSchema,
  DeviceRenewResponseSchema,
  IngestOperationsResponseSchema,
  OrientationSessionSchema,
  parseBroadcastPayload,
  projectTopic,
  type DeviceActivateRequest,
  type IngestOperationsRequest,
  type Locale,
  type ProjectStatus,
} from '@sitemuster/shared';

import { TrackingPlanSchema } from '../tracking/plan';

import {
  ApiError,
  type BulkResult,
  type CorrectableSession,
  type CrewMember,
  type ForemanProject,
  type KioskRegistration,
  type OpenVisit,
  type CreateProjectInput,
  type EmergencyContact,
  type JoinInput,
  type ManagedWorkerInput,
  type MyEnrollment,
  type Notice,
  type OrientationPreview,
  type OrientationSessionSummary,
  type PrintedBadge,
  type ProjectChannelListener,
  type ProjectDashboard,
  type ProjectMap,
  type RosterEntry,
  type WorkforceMember,
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

  // ---------------------------------------------------------------- Milestone 05

  /** RPCs that report code failures as `{ error }` (so rate limits keep counting) — rethrown here. */
  private async rpcOrError<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const data = await this.rpc<T & { error?: string }>(fn, args);
    if (data && typeof data === 'object' && typeof data.error === 'string')
      throw new ApiError(data.error);
    return data;
  }

  async startOrientation(projectId: string, idempotencyKey: string) {
    const data = (await this.invoke('orientation-session', {
      action: 'START',
      project_id: projectId,
      idempotency_key: idempotencyKey,
    })) as { session?: unknown };
    return OrientationSessionSchema.parse(data.session);
  }

  async getOrientationSession(sessionId: string) {
    return OrientationSessionSchema.parse(
      await this.rpc('get_orientation_session', { p_session_id: sessionId }),
    );
  }

  listOrientationSessions(projectId: string) {
    return this.rpc<OrientationSessionSummary[]>('list_orientation_sessions', {
      p_project_id: projectId,
    });
  }

  async closeOrientation(projectId: string, sessionId: string) {
    await this.invoke('orientation-session', {
      action: 'CLOSE',
      project_id: projectId,
      session_id: sessionId,
    });
  }

  previewOrientation(code: string, locale: Locale) {
    return this.rpcOrError<OrientationPreview>('preview_orientation', {
      p_code: code,
      p_locale: locale,
    });
  }

  completeOrientation(input: JoinInput) {
    return this.rpcOrError<{
      enrollment_id: string;
      enrollment_status: MyEnrollment['enrollment_status'];
    }>('complete_orientation', {
      p_join_token: input.joinToken,
      p_locale: input.locale,
      p_legal_name: input.legalName,
      p_company_id: input.companyId,
      p_company_name: input.companyId ? null : input.companyName,
      p_trade: input.trade,
      p_emergency_name: input.emergencyName,
      p_emergency_phone: input.emergencyPhone,
      p_emergency_relationship: input.emergencyRelationship,
      p_notice_version_id: input.noticeVersionId,
      p_accept: input.accept,
    });
  }

  myEnrollments() {
    return this.rpc<MyEnrollment[]>('my_enrollments');
  }

  getMyEmergencyContact() {
    return this.rpc<EmergencyContact | null>('get_my_emergency_contact');
  }

  async updateMyEmergencyContact(contact: EmergencyContact) {
    await this.rpc('update_my_emergency_contact', {
      p_name: contact.name,
      p_phone: contact.phone,
      p_relationship: contact.relationship,
    });
  }

  listEnrollments(projectId: string) {
    return this.rpc<RosterEntry[]>('list_project_enrollments', { p_project_id: projectId });
  }

  async bulkApprove(projectId: string, enrollmentIds: string[]): Promise<BulkResult[]> {
    const data = (await this.invoke('enrollment-bulk-approve', {
      project_id: projectId,
      enrollment_ids: enrollmentIds,
    })) as { results?: unknown };
    return BulkApproveResultSchema.array().parse(data.results);
  }

  confirmEmployer(projectId: string, enrollmentIds: string[], decision: 'VERIFIED' | 'REJECTED') {
    return this.rpc<BulkResult[]>('bulk_confirm_employer', {
      p_project_id: projectId,
      p_enrollment_ids: enrollmentIds,
      p_decision: decision,
    });
  }

  async decideEnrollment(enrollmentId: string, decision: 'REJECTED' | 'REVOKED', reason: string) {
    await this.rpc('decide_enrollment', {
      p_enrollment_id: enrollmentId,
      p_decision: decision,
      p_reason: reason,
    });
  }

  getProjectNotice(projectId: string, locale: Locale) {
    return this.rpc<{ notice: Notice; notice_acceptable: boolean }>('get_project_notice', {
      p_project_id: projectId,
      p_locale: locale,
    });
  }

  createManagedWorker(input: ManagedWorkerInput) {
    return this.rpc<{ worker_id: string; enrollment_id: string }>('create_managed_worker', {
      p_project_id: input.projectId,
      p_legal_name: input.legalName,
      p_company_id: input.companyId,
      p_company_name: input.companyId ? null : input.companyName,
      p_trade: input.trade,
      p_emergency_name: input.emergencyName,
      p_emergency_phone: input.emergencyPhone,
      p_emergency_relationship: input.emergencyRelationship,
      p_locale: input.locale,
      p_notice_version_id: input.noticeVersionId,
      p_acknowledged: input.acknowledged,
      p_idempotency_key: input.idempotencyKey,
    });
  }

  issuePrintedBadge(projectId: string, workerId: string) {
    return this.rpc<PrintedBadge>('issue_printed_badge', {
      p_project_id: projectId,
      p_worker_id: workerId,
    });
  }

  async revokePrintedBadge(projectId: string, badgeId: string, reason: string) {
    await this.rpc('revoke_printed_badge', {
      p_project_id: projectId,
      p_badge_id: badgeId,
      p_reason: reason,
    });
  }

  async activateDevice(input: DeviceActivateRequest) {
    return DeviceActivateResponseSchema.parse(await this.invoke('device-activate', input));
  }

  async getTrackingPlan(appVersion: string) {
    return TrackingPlanSchema.parse(
      await this.rpc<unknown>('my_tracking_plan', { p_app_version: appVersion }),
    );
  }

  async revokeMyDevice() {
    await this.rpc('revoke_my_device', {});
  }

  async renewDeviceWithSession(appVersion: string) {
    return DeviceRenewResponseSchema.parse(
      await this.invoke('device-renew', { app_version: appVersion }),
    );
  }

  async registerKiosk(projectId: string, devicePublicId: string) {
    return this.rpc<KioskRegistration>('register_kiosk', {
      p_project_id: projectId,
      p_device_public_id: devicePublicId,
    });
  }

  async ingestOperations(request: IngestOperationsRequest) {
    return IngestOperationsResponseSchema.parse(await this.invoke('ingest-operations', request));
  }

  async myForemanProjects() {
    return this.rpc<ForemanProject[]>('my_foreman_projects');
  }

  async foremanCrew(projectId: string, companyId: string) {
    return this.rpc<CrewMember[]>('foreman_crew', {
      p_project_id: projectId,
      p_company_id: companyId,
    });
  }

  async openVisitorVisits(projectId: string) {
    return this.rpc<OpenVisit[]>('open_visitor_visits', { p_project_id: projectId });
  }

  async workerAttendanceSessions(projectId: string, workerId: string) {
    return this.rpc<CorrectableSession[]>('worker_attendance_sessions', {
      p_project_id: projectId,
      p_worker_id: workerId,
    });
  }

  async projectDashboard(projectId: string) {
    return this.rpc<ProjectDashboard>('project_dashboard', { p_project_id: projectId });
  }

  async workforceRoster(projectId: string) {
    return this.rpc<WorkforceMember[]>('workforce_roster', { p_project_id: projectId });
  }

  async projectMap(projectId: string) {
    return this.rpc<ProjectMap>('project_map', { p_project_id: projectId });
  }

  subscribeProject(projectId: string, listener: ProjectChannelListener): () => void {
    return subscribeProjectChannel(this.client, projectId, listener);
  }
}

/**
 * Private Broadcast for one project (decision #19). The database authorizes the join through the
 * `realtime.messages` policy; a refused join reports DENIED and stops retrying. Messages are
 * validated against the strict contract and anything else is dropped.
 *
 * supabase-js returns the EXISTING channel object when one with the same topic is still known,
 * so a channel object is never shared: a new subscription creates its channel only after the
 * previous one for that topic has been removed (a quick re-join must not inherit a channel that
 * is being torn down).
 */
const removals = new WeakMap<SupabaseClient, Map<string, Promise<unknown>>>();

export function subscribeProjectChannel(
  client: SupabaseClient,
  projectId: string,
  listener: ProjectChannelListener,
): () => void {
  const topic = projectTopic(projectId);
  const pending = removals.get(client) ?? new Map<string, Promise<unknown>>();
  removals.set(client, pending);
  let closed = false;
  let channel: RealtimeChannel | null = null;

  void (pending.get(topic) ?? Promise.resolve())
    .then(() => client.realtime.setAuth())
    .catch(() => undefined) // no session: the join below is refused and reported
    .then(() => {
      if (closed) return;
      if (client.getChannels().some((c) => c.topic === `realtime:${topic}`)) {
        // Another live subscription to this project in the same client (never expected: the
        // app keeps one). Report it rather than silently sharing a channel object.
        console.warn('realtime: project channel already open');
        listener.onStatus('DISCONNECTED');
        return;
      }
      const current = client.channel(topic, { config: { private: true } });
      channel = current;
      current.on('broadcast', { event: '*' }, (message: { payload?: unknown }) => {
        const parsed = parseBroadcastPayload(message.payload);
        if (!closed && parsed && parsed.project_id === projectId) listener.onMessage(parsed);
      });
      current.subscribe((status, error) => {
        if (closed) return;
        if (status === 'SUBSCRIBED') listener.onStatus('SUBSCRIBED');
        else if (status === 'CHANNEL_ERROR' && isAuthorizationError(error)) {
          listener.onStatus('DENIED');
          unsubscribe();
        } else listener.onStatus('DISCONNECTED');
      });
    });

  function unsubscribe(): void {
    if (closed) return;
    closed = true;
    if (!channel) return;
    const removal: Promise<unknown> = client
      .removeChannel(channel)
      .catch(() => undefined)
      .finally(() => {
        if (pending.get(topic) === removal) pending.delete(topic);
      });
    pending.set(topic, removal);
  }
  return unsubscribe;
}

function isAuthorizationError(error: Error | undefined): boolean {
  return /unauthori[sz]ed|permission|forbidden|not allowed/i.test(error?.message ?? '');
}
