-- Milestone 02 · Row level security policies and explicit grants.
--
-- Model: clients (role `authenticated`) get SELECT only, on explicitly granted columns, filtered
-- by the policies below. No INSERT/UPDATE/DELETE is granted on any table: every mutation goes
-- through audited security-definer functions or Edge Functions (spec 05: "client must never
-- write role, consent approval, authoritative sessions, event outcomes or location tables").
-- `anon` gets nothing. `service_role` gets no table privileges either: Edge Functions call
-- specific functions with server-derived scope (decision #39), never broad table access.

-- ---------------------------------------------------------------------------------------------
-- Enable RLS everywhere (public and app_private)
-- ---------------------------------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select n.nspname, c.relname
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname in ('public', 'app_private')
       and c.relkind in ('r', 'p')
  loop
    execute format('alter table %I.%I enable row level security', r.nspname, r.relname);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Remove every implicit privilege, then grant precisely.
-- ---------------------------------------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated, service_role;
revoke all on all tables in schema app_private from anon, authenticated, service_role;
revoke all on all sequences in schema public from anon, authenticated, service_role;
revoke all on all functions in schema public from public, anon, authenticated, service_role;
revoke all on all functions in schema app_private from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Policies (SELECT only)
-- ---------------------------------------------------------------------------------------------

create policy organizations_select on public.organizations
  for select to authenticated using (app_private.can_view_organization(id));

create policy organization_members_select on public.organization_members
  for select to authenticated
  using (user_id = (select app_private.current_uid()) or app_private.can_manage_organization(organization_id));

create policy organization_invitations_select on public.organization_invitations
  for select to authenticated using (app_private.can_manage_organization(organization_id));

create policy projects_select on public.projects
  for select to authenticated using (app_private.can_view_project(id));

create policy config_versions_select on public.project_tracking_config_versions
  for select to authenticated using (app_private.can_view_project(project_id));

create policy work_windows_select on public.project_work_windows
  for select to authenticated using (app_private.can_view_config_version(config_version_id));

create policy geofences_select on public.project_geofences
  for select to authenticated using (app_private.can_view_project(project_id));

create policy project_staff_select on public.project_staff
  for select to authenticated
  using (
    user_id = (select app_private.current_uid())
    or app_private.is_project_staff(project_id)
    or app_private.can_manage_organization(app_private.project_organization(project_id))
  );

create policy worker_profiles_select on public.worker_profiles
  for select to authenticated
  using (
    id = (select app_private.current_worker_id())
    or app_private.staff_can_view_worker(id)
    or app_private.foreman_can_view_worker_any(id)
  );

create policy emergency_contacts_select on public.emergency_contacts
  for select to authenticated
  using (
    worker_profile_id = (select app_private.current_worker_id())
    or app_private.can_view_emergency_contacts_of(worker_profile_id)
  );

create policy subcontractor_companies_select on public.subcontractor_companies
  for select to authenticated using (app_private.can_view_company(id));

create policy project_subcontractors_select on public.project_subcontractors
  for select to authenticated
  using (
    app_private.can_view_roster(project_id)
    or app_private.is_foreman_of_company_on_project(subcontractor_id, project_id)
  );

create policy subcontractor_members_select on public.subcontractor_members
  for select to authenticated using (app_private.can_view_company_member(company_id, worker_profile_id));

create policy foreman_grants_select on public.foreman_project_grants
  for select to authenticated
  using (foreman_profile_id = (select app_private.current_worker_id()) or app_private.can_view_roster(project_id));

create policy legal_notices_select on public.legal_notice_versions
  for select to authenticated
  using (
    app_private.tenant_access_allowed()
    and (project_id is null or app_private.can_view_project(project_id))
  );

create policy orientation_sessions_select on public.orientation_sessions
  for select to authenticated using (app_private.can_view_roster(project_id));

create policy orientation_records_select on public.orientation_records
  for select to authenticated
  using (worker_profile_id = (select app_private.current_worker_id()) or app_private.can_view_roster(project_id));

create policy worker_enrollments_select on public.worker_enrollments
  for select to authenticated
  using (
    worker_id = (select app_private.current_worker_id())
    or app_private.can_view_roster(project_id)
    or (subcontractor_id is not null and app_private.is_foreman_of_company_on_project(subcontractor_id, project_id))
  );

create policy tracking_consents_select on public.tracking_consents
  for select to authenticated
  using (worker_id = (select app_private.current_worker_id()) or app_private.can_view_roster(project_id));

create policy device_installations_select on public.device_installations
  for select to authenticated
  using (worker_id = (select app_private.current_worker_id()) or app_private.staff_can_view_worker(worker_id));

create policy device_bindings_select on public.device_project_bindings
  for select to authenticated
  using (app_private.owns_device(device_id) or app_private.can_view_roster(project_id));

create policy kiosk_devices_select on public.kiosk_devices
  for select to authenticated using (app_private.can_view_roster(project_id));

create policy worker_badges_select on public.worker_badges
  for select to authenticated
  using (worker_id = (select app_private.current_worker_id()) or app_private.staff_can_view_worker(worker_id));

create policy latest_positions_select on public.latest_onsite_positions
  for select to authenticated
  using (
    worker_id = (select app_private.current_worker_id())
    or app_private.can_view_locations(project_id)
    or (app_private.foreman_has_grant(project_id, 'locations')
        and app_private.foreman_can_see_worker(project_id, worker_id))
  );

create policy attendance_sessions_select on public.attendance_sessions
  for select to authenticated
  using (
    worker_id = (select app_private.current_worker_id())
    or app_private.can_view_roster(project_id)
    or app_private.foreman_can_see_worker(project_id, worker_id)
  );

create policy attendance_events_select on public.attendance_events
  for select to authenticated
  using (
    worker_id = (select app_private.current_worker_id())
    or app_private.can_view_roster(project_id)
    or app_private.foreman_can_see_worker(project_id, worker_id)
  );

create policy presence_states_select on public.presence_states
  for select to authenticated
  using (
    worker_id = (select app_private.current_worker_id())
    or app_private.can_view_roster(project_id)
    or app_private.foreman_can_see_worker(project_id, worker_id)
  );

create policy attendance_corrections_select on public.attendance_corrections
  for select to authenticated
  using (
    worker_id = (select app_private.current_worker_id())
    or (requested_by = (select app_private.current_uid()) and app_private.tenant_access_allowed())
    or app_private.can_view_roster(project_id)
    or app_private.foreman_can_see_worker(project_id, worker_id)
  );

create policy visitor_records_select on public.visitor_records
  for select to authenticated using (app_private.can_view_roster(project_id));

create policy visitor_visits_select on public.visitor_visits
  for select to authenticated using (app_private.can_view_roster(project_id));

create policy daily_reports_select on public.daily_company_reports
  for select to authenticated
  using (
    app_private.can_view_roster(project_id)
    or app_private.is_foreman_of_company_on_project(subcontractor_id, project_id)
  );

create policy report_confirmations_select on public.report_confirmations
  for select to authenticated using (app_private.can_view_report(report_id));

create policy muster_events_select on public.muster_events
  for select to authenticated using (app_private.can_view_muster(id));

create policy muster_members_select on public.muster_snapshot_members
  for select to authenticated using (app_private.can_view_muster_member(id));

create policy muster_responses_select on public.muster_responses
  for select to authenticated using (app_private.can_view_muster_member(snapshot_member_id));

-- app_private tables: RLS enabled with NO policies and no grants (server functions only).

-- ---------------------------------------------------------------------------------------------
-- Column-level SELECT grants for `authenticated` (sensitive columns are never granted)
-- ---------------------------------------------------------------------------------------------
grant select on public.organizations to authenticated;
grant select on public.organization_members to authenticated;
grant select (id, organization_id, project_id, target_email, target_phone, role, project_role,
              expires_at, revoked_at, used_at, invited_by, created_at)
  on public.organization_invitations to authenticated;
grant select on public.projects to authenticated;
grant select on public.project_tracking_config_versions to authenticated;
grant select on public.project_work_windows to authenticated;
grant select on public.project_geofences to authenticated;
grant select on public.project_staff to authenticated;
-- Phone, email and the auth link of a worker are never readable through the table; a worker reads
-- their own contact details through an owner-only function (Milestone 03).
grant select (id, legal_name, primary_language, managed_identity, pseudonym_label, deleted_at, created_at, updated_at)
  on public.worker_profiles to authenticated;
grant select on public.emergency_contacts to authenticated;
grant select (id, canonical_name, default_trade, verified_status, verified_at, created_at, updated_at)
  on public.subcontractor_companies to authenticated;
grant select on public.project_subcontractors to authenticated;
grant select on public.subcontractor_members to authenticated;
grant select on public.foreman_project_grants to authenticated;
grant select on public.legal_notice_versions to authenticated;
grant select (id, project_id, started_by, starts_at, expires_at, status, revoked_at, closed_at, created_at)
  on public.orientation_sessions to authenticated;
grant select on public.orientation_records to authenticated;
grant select on public.worker_enrollments to authenticated;
grant select on public.tracking_consents to authenticated;
grant select (id, worker_id, platform, app_version, active, activated_at, deactivated_at, replaced_by, created_at)
  on public.device_installations to authenticated;
grant select on public.device_project_bindings to authenticated;
grant select on public.kiosk_devices to authenticated;
grant select (id, worker_id, badge_kind, active, issued_by, issued_at, revoked_at)
  on public.worker_badges to authenticated;
grant select on public.latest_onsite_positions to authenticated;
grant select on public.attendance_sessions to authenticated;
grant select on public.attendance_events to authenticated;
grant select on public.presence_states to authenticated;
grant select on public.attendance_corrections to authenticated;
grant select on public.visitor_records to authenticated;
grant select on public.visitor_visits to authenticated;
grant select on public.daily_company_reports to authenticated;
grant select on public.report_confirmations to authenticated;
grant select on public.muster_events to authenticated;
grant select on public.muster_snapshot_members to authenticated;
grant select on public.muster_responses to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Helper predicates are callable by `authenticated` because RLS policies run as the caller.
-- app_private is not exposed by the Data API, so these are not reachable as RPC endpoints.
-- ---------------------------------------------------------------------------------------------
grant execute on function
  app_private.current_uid(),
  app_private.is_aal2(),
  app_private.is_platform_operator(),
  app_private.tenant_access_allowed(),
  app_private.current_worker_id(),
  app_private.project_organization(uuid),
  app_private.is_org_owner(uuid),
  app_private.is_org_admin(uuid),
  app_private.has_project_role(uuid, public.project_staff_role[]),
  app_private.can_manage_organization(uuid),
  app_private.can_view_roster(uuid),
  app_private.can_view_locations(uuid),
  app_private.has_emergency_role(uuid),
  app_private.foreman_company_ids(uuid),
  app_private.is_foreman_on_project(uuid),
  app_private.is_foreman_of_company_on_project(uuid, uuid),
  app_private.foreman_can_see_worker(uuid, uuid),
  app_private.foreman_has_grant(uuid, text),
  app_private.can_operate_kiosk(uuid),
  app_private.is_enrolled_worker(uuid),
  app_private.can_view_project(uuid),
  app_private.can_view_organization(uuid),
  app_private.is_project_staff(uuid),
  app_private.can_view_config_version(uuid),
  app_private.staff_can_view_worker(uuid),
  app_private.foreman_can_view_worker_any(uuid),
  app_private.can_view_emergency_contacts_of(uuid),
  app_private.can_view_company(uuid),
  app_private.is_foreman_of_company(uuid),
  app_private.can_view_company_member(uuid, uuid),
  app_private.owns_device(uuid),
  app_private.can_view_report(uuid),
  app_private.muster_project(uuid),
  app_private.can_view_muster_member(uuid),
  app_private.can_view_muster(uuid),
  app_private.can_receive_project_broadcast(uuid),
  app_private.project_id_from_topic(text)
to authenticated;
