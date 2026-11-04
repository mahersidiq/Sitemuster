-- Milestone 02 · Row-level security helper predicates (docs/spec/02-roles-permissions.md).
--
-- All helpers are SECURITY DEFINER with an empty search_path, derive identity ONLY from the
-- verified JWT (auth.uid(), aal claim) and never trust a client-supplied role.
--   * Staff predicates (O/P/S/H and attendants) require MFA: JWT `aal = aal2` (decision #3).
--   * Org OWNERs see all of their organization's projects; org ADMINs see a project only when
--     assigned to it through project_staff (least privilege; decision #53).
--   * Platform operators never receive tenant data through RLS (decision #32).

create function app_private.current_uid()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$ select auth.uid() $$;

create function app_private.is_aal2()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$ select coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2' $$;

create function app_private.is_platform_operator()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app_private.platform_operators o where o.user_id = auth.uid() and o.active
  )
$$;

-- Any tenant-data access requires an authenticated, non-operator caller.
create function app_private.tenant_access_allowed()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$ select auth.uid() is not null and not app_private.is_platform_operator() $$;

create function app_private.current_worker_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select w.id
    from public.worker_profiles w
   where w.auth_user_id = auth.uid()
     and w.deleted_at is null
     and app_private.tenant_access_allowed()
$$;

create function app_private.project_organization(p_project uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$ select p.organization_id from public.projects p where p.id = p_project $$;

create function app_private.is_org_owner(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app_private.tenant_access_allowed() and exists (
    select 1 from public.organization_members m
     where m.organization_id = p_org and m.user_id = auth.uid()
       and m.role = 'OWNER' and m.membership_status = 'ACTIVE'
  )
$$;

create function app_private.is_org_admin(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app_private.tenant_access_allowed() and exists (
    select 1 from public.organization_members m
     where m.organization_id = p_org and m.user_id = auth.uid()
       and m.role in ('OWNER', 'ADMIN') and m.membership_status = 'ACTIVE'
  )
$$;

create function app_private.has_project_role(p_project uuid, p_roles public.project_staff_role[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app_private.tenant_access_allowed() and exists (
    select 1 from public.project_staff s
     where s.project_id = p_project and s.user_id = auth.uid()
       and s.status = 'ACTIVE' and s.role = any (p_roles)
  )
$$;

create function app_private.can_manage_organization(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$ select app_private.is_aal2() and app_private.is_org_admin(p_org) $$;

-- Any assigned staff member (PM/SUPER/SAFETY/ATTENDANT) or the org OWNER, with MFA.
create function app_private.can_view_roster(p_project uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app_private.is_aal2() and (
    app_private.is_org_owner(app_private.project_organization(p_project))
    or app_private.has_project_role(p_project, array['PM', 'SUPER', 'SAFETY', 'ATTENDANT']::public.project_staff_role[])
  )
$$;

-- Exact/latest onsite location: assigned PM/SUPER/SAFETY or org OWNER, with MFA (never operator).
create function app_private.can_view_locations(p_project uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app_private.is_aal2() and (
    app_private.is_org_owner(app_private.project_organization(p_project))
    or app_private.has_project_role(p_project, array['PM', 'SUPER', 'SAFETY']::public.project_staff_role[])
  )
$$;

-- Designated emergency role: SAFETY, or any assigned staff row explicitly emergency_designated.
-- Governs emergency contacts and starting/closing a muster.
create function app_private.has_emergency_role(p_project uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app_private.is_aal2() and app_private.tenant_access_allowed() and exists (
    select 1 from public.project_staff s
     where s.project_id = p_project and s.user_id = auth.uid() and s.status = 'ACTIVE'
       and (s.role = 'SAFETY' or s.emergency_designated)
  )
$$;

-- Companies (approved on the project) where the caller is a verified, currently valid FOREMAN.
create function app_private.foreman_company_ids(p_project uuid)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.company_id
    from public.subcontractor_members m
    join public.project_subcontractors ps
      on ps.subcontractor_id = m.company_id and ps.project_id = p_project and ps.status = 'APPROVED'
   where m.worker_profile_id = app_private.current_worker_id()
     and m.role = 'FOREMAN'
     and m.verification_status = 'VERIFIED'
     and m.valid_from <= now()
     and (m.valid_until is null or m.valid_until > now())
$$;

create function app_private.is_foreman_on_project(p_project uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$ select exists (select 1 from app_private.foreman_company_ids(p_project)) $$;

create function app_private.is_foreman_of_company_on_project(p_company uuid, p_project uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$ select p_company in (select app_private.foreman_company_ids(p_project)) $$;

-- "Own employees": workers enrolled on the project through one of the foreman's companies.
create function app_private.foreman_can_see_worker(p_project uuid, p_worker uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.worker_enrollments e
     where e.project_id = p_project and e.worker_id = p_worker
       and e.subcontractor_id in (select app_private.foreman_company_ids(p_project))
  )
$$;

create function app_private.foreman_has_grant(p_project uuid, p_grant text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.foreman_project_grants g
     where g.project_id = p_project
       and g.foreman_profile_id = app_private.current_worker_id()
       and g.revoked_at is null
       and g.subcontractor_id in (select app_private.foreman_company_ids(p_project))
       and case p_grant
             when 'locations' then g.can_view_locations
             when 'emergency_contacts' then g.can_view_emergency_contacts
             when 'kiosk' then g.can_operate_kiosk
             else false
           end
  )
$$;

create function app_private.can_operate_kiosk(p_project uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (app_private.is_aal2() and app_private.has_project_role(p_project, array['ATTENDANT']::public.project_staff_role[]))
      or app_private.foreman_has_grant(p_project, 'kiosk')
$$;

create function app_private.is_enrolled_worker(p_project uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.worker_enrollments e
     where e.project_id = p_project and e.worker_id = app_private.current_worker_id()
  )
$$;

create function app_private.can_view_project(p_project uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app_private.can_view_roster(p_project)
      or app_private.is_enrolled_worker(p_project)
      or app_private.is_foreman_on_project(p_project)
$$;

create function app_private.can_view_organization(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (app_private.is_aal2() and app_private.is_org_admin(p_org))
      or exists (
        select 1 from public.projects p
         where p.organization_id = p_org and app_private.can_view_project(p.id)
      )
$$;

create function app_private.is_project_staff(p_project uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app_private.is_aal2()
     and app_private.has_project_role(p_project, array['PM', 'SUPER', 'SAFETY', 'ATTENDANT']::public.project_staff_role[])
$$;

create function app_private.can_view_config_version(p_version uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.project_tracking_config_versions v
     where v.id = p_version and app_private.can_view_project(v.project_id)
  )
$$;

-- Staff can see a worker who is enrolled (any status) on a project whose roster they can view.
create function app_private.staff_can_view_worker(p_worker uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.worker_enrollments e
     where e.worker_id = p_worker and app_private.can_view_roster(e.project_id)
  )
$$;

create function app_private.foreman_can_view_worker_any(p_worker uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.worker_enrollments e
     where e.worker_id = p_worker and app_private.foreman_can_see_worker(e.project_id, p_worker)
  )
$$;

-- Emergency contacts: designated emergency staff on a project where the worker is APPROVED, or a
-- foreman with an explicit emergency-contact delegation for their own crew.
create function app_private.can_view_emergency_contacts_of(p_worker uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.worker_enrollments e
     where e.worker_id = p_worker
       and e.enrollment_status = 'APPROVED'
       and (
         app_private.has_emergency_role(e.project_id)
         or (app_private.foreman_has_grant(e.project_id, 'emergency_contacts')
             and app_private.foreman_can_see_worker(e.project_id, p_worker))
       )
  )
$$;

create function app_private.can_view_company(p_company uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
           select 1 from public.subcontractor_members m
            where m.company_id = p_company and m.worker_profile_id = app_private.current_worker_id()
         )
      or exists (
           select 1 from public.project_subcontractors ps
            where ps.subcontractor_id = p_company and app_private.can_view_roster(ps.project_id)
         )
$$;

create function app_private.is_foreman_of_company(p_company uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.subcontractor_members m
     where m.company_id = p_company
       and m.worker_profile_id = app_private.current_worker_id()
       and m.role = 'FOREMAN' and m.verification_status = 'VERIFIED'
       and m.valid_from <= now() and (m.valid_until is null or m.valid_until > now())
  )
$$;

create function app_private.can_view_company_member(p_company uuid, p_worker uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_worker = app_private.current_worker_id()
      or app_private.is_foreman_of_company(p_company)
      or exists (
           select 1 from public.worker_enrollments e
            where e.worker_id = p_worker and e.subcontractor_id = p_company
              and app_private.can_view_roster(e.project_id)
         )
$$;

create function app_private.owns_device(p_device uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.device_installations d
     where d.id = p_device and d.worker_id = app_private.current_worker_id()
  )
$$;

create function app_private.can_view_report(p_report uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.daily_company_reports r
     where r.id = p_report
       and (app_private.can_view_roster(r.project_id)
            or app_private.is_foreman_of_company_on_project(r.subcontractor_id, r.project_id))
  )
$$;

create function app_private.muster_project(p_muster uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$ select m.project_id from public.muster_events m where m.id = p_muster $$;

create function app_private.can_view_muster_member(p_member uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.muster_snapshot_members sm
     where sm.id = p_member
       and (
         app_private.can_view_roster(app_private.muster_project(sm.muster_id))
         or (sm.worker_id is not null and sm.worker_id = app_private.current_worker_id())
         or (sm.worker_id is not null
             and app_private.foreman_can_see_worker(app_private.muster_project(sm.muster_id), sm.worker_id))
       )
  )
$$;

create function app_private.can_view_muster(p_muster uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app_private.can_view_roster(app_private.muster_project(p_muster))
      or exists (
           select 1 from public.muster_snapshot_members sm
            where sm.muster_id = p_muster and app_private.can_view_muster_member(sm.id)
         )
$$;

-- Realtime: only staff and explicitly permitted company members (foremen) of that project.
create function app_private.can_receive_project_broadcast(p_project uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_project is not null
     and (app_private.can_view_roster(p_project) or app_private.is_foreman_on_project(p_project))
$$;

create function app_private.project_id_from_topic(p_topic text)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select case
           when p_topic ~ '^project:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           then substr(p_topic, 9)::uuid
         end
$$;
