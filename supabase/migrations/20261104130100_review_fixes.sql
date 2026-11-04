-- Fixes from the automated review of merged pull requests #2 and #4 (decision #76).

-- ---------------------------------------------------------------------------------------------
-- 1. Platform operators never keep delegated-PM powers (tenant_access_allowed on every branch).
-- ---------------------------------------------------------------------------------------------
create or replace function app_private.can_configure_project(p_project uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app_private.is_aal2() and app_private.tenant_access_allowed() and (
    app_private.is_org_admin(app_private.project_organization(p_project))
    or app_private.has_project_role(p_project, array['SUPER']::public.project_staff_role[])
    or exists (
      select 1 from public.project_staff s
       where s.project_id = p_project and s.user_id = auth.uid() and s.status = 'ACTIVE'
         and s.role = 'PM' and s.can_configure_project
    )
  )
$$;

create or replace function app_private.can_assign_staff(p_project uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app_private.is_aal2() and app_private.tenant_access_allowed() and (
    app_private.is_org_admin(app_private.project_organization(p_project))
    or exists (
      select 1 from public.project_staff s
       where s.project_id = p_project and s.user_id = auth.uid() and s.status = 'ACTIVE'
         and s.role = 'PM' and s.can_assign_staff
    )
  )
$$;

-- ---------------------------------------------------------------------------------------------
-- 2. Delegated PMs cannot hand out roles with implicit powers.
-- ---------------------------------------------------------------------------------------------
create or replace function public.invite_project_staff(
  p_project_id uuid,
  p_email text,
  p_role public.project_staff_role,
  p_emergency_designated boolean default false,
  p_can_configure_project boolean default false,
  p_can_assign_staff boolean default false,
  p_can_approve_corrections boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_org uuid := app_private.project_organization(p_project_id);
  v_email text := lower(btrim(p_email));
  v_id uuid;
begin
  if v_uid is null or not app_private.can_assign_staff(p_project_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' then
    raise exception 'INVALID_EMAIL' using errcode = '22023';
  end if;
  -- Elevated delegations may only be granted by an organization owner/admin (decision #65).
  -- SUPER (configures the project) and SAFETY (emergency role) carry implicit powers, so only an
  -- organization owner/admin may grant them, exactly like the explicit flags (decision #76).
  if (p_emergency_designated or p_can_configure_project or p_can_assign_staff or p_can_approve_corrections
      or p_role in ('SUPER', 'SAFETY'))
     and not app_private.is_org_admin(v_org) then
    raise exception 'DELEGATION_REQUIRES_ORG_ADMIN' using errcode = '42501';
  end if;
  if (select status from public.projects where id = p_project_id) = 'ARCHIVED' then
    raise exception 'PROJECT_CLOSED' using errcode = '22023';
  end if;
  insert into public.organization_invitations
    (organization_id, project_id, target_email, project_role, expires_at, token_hash, invited_by,
     emergency_designated, can_configure_project, can_assign_staff, can_approve_corrections)
  values (v_org, p_project_id, v_email, p_role, now() + interval '7 days',
          extensions.digest(extensions.gen_random_bytes(32), 'sha256'), v_uid,
          coalesce(p_emergency_designated, false), coalesce(p_can_configure_project, false),
          coalesce(p_can_assign_staff, false), coalesce(p_can_approve_corrections, false))
  returning id into v_id;
  perform app_private.write_audit('USER', v_uid, 'staff.invited', v_org, p_project_id, 'invitation', v_id, null,
                                  jsonb_build_object('role', p_role));
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 3. Foreman grants cover only workers of the company that carries the grant.
-- ---------------------------------------------------------------------------------------------
create function app_private.foreman_grant_covers_worker(p_project uuid, p_worker uuid, p_grant text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.worker_enrollments e
      join public.foreman_project_grants g
        on g.project_id = e.project_id and g.subcontractor_id = e.subcontractor_id
     where e.project_id = p_project
       and e.worker_id = p_worker
       and e.subcontractor_id in (select app_private.foreman_company_ids(p_project))
       and g.foreman_profile_id = app_private.current_worker_id()
       and g.revoked_at is null
       and case p_grant
             when 'locations' then g.can_view_locations
             when 'emergency_contacts' then g.can_view_emergency_contacts
             else false
           end
  )
$$;
revoke all on function app_private.foreman_grant_covers_worker(uuid, uuid, text) from public, anon, service_role;
grant execute on function app_private.foreman_grant_covers_worker(uuid, uuid, text) to authenticated;

drop policy latest_positions_select on public.latest_onsite_positions;
create policy latest_positions_select on public.latest_onsite_positions
  for select to authenticated
  using (
    worker_id = (select app_private.current_worker_id())
    or app_private.can_view_locations(project_id)
    or app_private.foreman_grant_covers_worker(project_id, worker_id, 'locations')
  );

create or replace function app_private.can_view_emergency_contacts_of(p_worker uuid)
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
         or app_private.foreman_grant_covers_worker(e.project_id, p_worker, 'emergency_contacts')
       )
  )
$$;

-- ---------------------------------------------------------------------------------------------
-- 4. Last-owner protection is serialized per organization (concurrent removals cannot both pass).
-- ---------------------------------------------------------------------------------------------
create or replace function app_private.protect_last_owner()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_remaining integer;
begin
  if old.role <> 'OWNER' or old.membership_status <> 'ACTIVE' then
    return coalesce(new, old);
  end if;
  if tg_op = 'UPDATE' and new.role = 'OWNER' and new.membership_status = 'ACTIVE' then
    return new;
  end if;
  -- Organization itself being deleted (cascade): nothing to protect.
  if not exists (select 1 from public.organizations where id = old.organization_id) then
    return coalesce(new, old);
  end if;
  -- Lock the organization row first: a second concurrent owner removal waits here and then
  -- counts with a fresh snapshot that includes the first removal.
  perform 1 from public.organizations where id = old.organization_id for update;
  select count(*) into v_remaining
    from public.organization_members
   where organization_id = old.organization_id
     and role = 'OWNER'
     and membership_status = 'ACTIVE'
     and id <> old.id;
  if v_remaining = 0 then
    raise exception 'an organization must keep at least one active owner' using errcode = '23514';
  end if;
  return coalesce(new, old);
end;
$$;
