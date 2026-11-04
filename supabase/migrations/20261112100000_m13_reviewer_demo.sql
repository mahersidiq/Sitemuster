-- Milestone 13 · Server-gated synthetic reviewer demo (docs/spec/09 "Reviewer/demo mode",
-- docs/spec/07 "Review simulation tries live project"; decisions #38, #140–#143).
--
-- * Only an organization on the private allowlist `app_private.demo_organizations` is a demo. The
--   allowlist is written only by the database owner (`seed_reviewer_demo`, SQL editor); no client
--   role can read or change it.
-- * The demo's people are synthetic no-phone identities, each with a synthetic phone record that
--   never receives an upload credential. "Simulate arrival/departure" (Edge Function
--   `demo-simulate`) feeds coordinate-free geofence records and on-site fixes for those synthetic
--   phones through the production ingest pipeline, after this database confirms: the caller may
--   correct attendance on the project (MFA), the project belongs to an active demo organization,
--   and the person is one of its synthetic workers. Everything else fails closed.
-- * Real accounts in the demo (the reviewer's own phone) are never simulated.

-- ---------------------------------------------------------------------------------------------
-- 1. Allowlist and synthetic people
-- ---------------------------------------------------------------------------------------------
create table app_private.demo_organizations (
  organization_id uuid primary key references public.organizations (id) on delete cascade,
  label text not null default 'SITEMUSTER_DEMO' check (label = 'SITEMUSTER_DEMO'),
  created_at timestamptz not null default now(),
  retired_at timestamptz
);
alter table app_private.demo_organizations enable row level security;

create table app_private.demo_workers (
  worker_id uuid primary key references public.worker_profiles (id) on delete cascade,
  organization_id uuid not null references app_private.demo_organizations (organization_id) on delete cascade,
  project_id uuid not null references public.projects (id) on delete cascade,
  device_id uuid not null unique references public.device_installations (id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table app_private.demo_workers enable row level security;

-- A synthetic phone can never authenticate an upload: it has no credential, and none can be made.
create function app_private.demo_device_credential_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from app_private.demo_workers d where d.device_id = new.device_id) then
    raise exception 'DEMO_DEVICE_HAS_NO_CREDENTIAL' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger demo_device_no_credential
  before insert on app_private.device_upload_credentials
  for each row execute function app_private.demo_device_credential_guard();

-- ---------------------------------------------------------------------------------------------
-- 2. Server-side checks
-- ---------------------------------------------------------------------------------------------
create function app_private.is_demo_project(p_project uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.projects p
      join app_private.demo_organizations d on d.organization_id = p.organization_id
     where p.id = p_project)
$$;

create function app_private.is_active_demo_project(p_project uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.projects p
      join app_private.demo_organizations d on d.organization_id = p.organization_id
     where p.id = p_project and d.retired_at is null and p.status = 'ACTIVE')
$$;

-- ---------------------------------------------------------------------------------------------
-- 3. Seeding (database owner only, from the SQL editor; HUMAN_CHECKLIST §11)
-- ---------------------------------------------------------------------------------------------
-- p_owner_user:    an owner-controlled account that owns the demo organization (never given to a
--                  reviewer; it keeps the demo deletable by the reviewer accounts).
-- p_reviewer_user: reviewer account A — organization admin; superintendent, safety manager with the
--                  emergency role and kiosk attendant on the demo project; also a worker and the
--                  verified foreman of the first demo company.
-- p_deletion_user: optional reviewer account B — a worker only, for testing account deletion
--                  without losing account A.
-- Every acknowledgement goes through the production notice gate: in production the seed refuses
-- until the worker notice is approved in English and Spanish (CONSENT_NOTICE_NOT_APPROVED).
create function app_private.seed_reviewer_demo(
  p_owner_user uuid,
  p_reviewer_user uuid,
  p_deletion_user uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set timezone = 'UTC'
as $$
declare
  v_org uuid;
  v_project uuid;
  v_version uuid;
  v_settings jsonb;
  v_companies uuid[] := '{}';
  v_company uuid;
  v_notice public.legal_notice_versions;
  v_worker uuid;
  v_device uuid;
  v_enrollment public.worker_enrollments;
  v_locale public.locale_code;
  v_synthetic uuid[] := '{}';
  v_reviewer_worker uuid;
  v_deletion_worker uuid;
  v_names constant text[] := array['Demo Worker A', 'Demo Worker B', 'Demo Worker C', 'Demo Worker D',
                                   'Demo Worker E', 'Demo Worker F', 'Demo Worker G', 'Demo Worker H'];
  v_trades constant text[] := array['Concrete', 'Electrical'];
  i integer;
begin
  if p_owner_user is null or p_reviewer_user is null then
    raise exception 'DEMO_USERS_REQUIRED' using errcode = '22023';
  end if;
  if p_owner_user = p_reviewer_user or p_deletion_user in (p_owner_user, p_reviewer_user) then
    raise exception 'DEMO_USERS_MUST_DIFFER' using errcode = '22023';
  end if;
  if (select count(*) from auth.users u where u.id in (p_owner_user, p_reviewer_user, p_deletion_user))
     <> (case when p_deletion_user is null then 2 else 3 end) then
    raise exception 'DEMO_USER_NOT_FOUND' using errcode = '22023';
  end if;
  if exists (select 1 from app_private.platform_operators o
              where o.user_id in (p_owner_user, p_reviewer_user, p_deletion_user) and o.active) then
    raise exception 'DEMO_USER_IS_OPERATOR' using errcode = '22023';
  end if;
  if exists (select 1 from app_private.demo_organizations d where d.retired_at is null) then
    raise exception 'DEMO_ALREADY_SEEDED' using errcode = '22023';
  end if;
  -- Reviewer accounts are dedicated to the demo: no other organization, project or worker profile.
  if exists (select 1 from public.organization_members m
              where m.user_id in (p_reviewer_user, p_deletion_user) and m.membership_status = 'ACTIVE')
     or exists (select 1 from public.project_staff s
                 where s.user_id in (p_reviewer_user, p_deletion_user) and s.status = 'ACTIVE')
     or exists (select 1 from public.worker_profiles w
                 where w.auth_user_id in (p_reviewer_user, p_deletion_user) and w.deleted_at is null)
     or exists (select 1 from public.organizations o where o.owner_user_id in (p_reviewer_user, p_deletion_user)) then
    raise exception 'DEMO_ACCOUNT_NOT_DEDICATED' using errcode = '22023';
  end if;

  -- Organization, allowlist and membership.
  insert into public.organizations (name, owner_user_id, idempotency_key)
  values ('SiteMuster Demo (synthetic data)', p_owner_user, gen_random_uuid())
  returning id into v_org;
  insert into app_private.demo_organizations (organization_id) values (v_org);
  insert into public.organization_members (organization_id, user_id, role, added_by) values
    (v_org, p_owner_user, 'OWNER', p_owner_user),
    (v_org, p_reviewer_user, 'ADMIN', p_owner_user);

  -- A 24/7 site, so a simulated arrival is always inside the schedule whatever the reviewer's clock.
  v_settings := app_private.build_settings(150, 600, 75, true, '[]'::jsonb);
  insert into public.projects (organization_id, name, project_number, address, iana_timezone, status,
                               assigned_superintendent_id, created_by, idempotency_key)
  values (v_org, 'Demo Tower (synthetic site)', 'DEMO-1', 'Synthetic demo site, Austin, TX', 'America/Chicago', 'DRAFT',
          p_reviewer_user, p_owner_user, gen_random_uuid())
  returning id into v_project;
  insert into public.project_tracking_config_versions
    (project_id, version_number, effective_at, created_by, reason, settings_json, sha256, operates_24_7, idempotency_key)
  values (v_project, 1, now(), p_owner_user, 'Reviewer demo', v_settings, repeat('0', 64), true, gen_random_uuid())
  returning id into v_version;
  insert into public.project_geofences (config_version_id, project_id, center, radius_m, exit_hysteresis_m)
  values (v_version, v_project,
          extensions.st_setsrid(extensions.st_makepoint(-97.7431, 30.2672), 4326)::extensions.geography,
          150, (v_settings ->> 'exit_hysteresis_m')::numeric);
  update public.projects set config_version_id = v_version, status = 'ACTIVE' where id = v_project;

  insert into public.project_staff (project_id, user_id, role, emergency_designated, can_approve_corrections, added_by) values
    (v_project, p_reviewer_user, 'SUPER', false, true, p_owner_user),
    (v_project, p_reviewer_user, 'SAFETY', true, false, p_owner_user),
    (v_project, p_reviewer_user, 'ATTENDANT', false, false, p_owner_user);

  -- Two verified, approved companies.
  for i in 1 .. 2 loop
    insert into public.subcontractor_companies (canonical_name, default_trade, verified_status, verified_by, verified_at, created_by)
    values (case i when 1 then 'Demo Concrete Co. (synthetic)' else 'Demo Electric LLC (synthetic)' end,
            v_trades[i], 'VERIFIED', p_owner_user, now(), p_owner_user)
    returning id into v_company;
    insert into public.project_subcontractors (project_id, subcontractor_id, status, approved_by, approved_at)
    values (v_project, v_company, 'APPROVED', p_owner_user, now());
    v_companies := v_companies || v_company;
  end loop;

  -- Eight synthetic no-phone workers, each with a synthetic phone record for simulation only.
  -- Emergency numbers are in the 555-0100…0199 range reserved for fiction.
  for i in 1 .. array_length(v_names, 1) loop
    v_locale := case when i % 2 = 0 then 'es-US' else 'en-US' end;
    v_company := v_companies[1 + (i + 1) % 2];
    v_notice := app_private.assert_notice_acceptable(v_project, v_locale,
                                                     (app_private.current_notice(v_project, v_locale)).id, true);
    insert into public.worker_profiles (legal_name, primary_language, managed_identity, created_by, idempotency_key)
    values (v_names[i], v_locale, true, p_owner_user, gen_random_uuid())
    returning id into v_worker;
    perform app_private.replace_emergency_contact(v_worker, 'Demo Contact ' || chr(64 + i),
                                                  '+1512555' || lpad((100 + i)::text, 4, '0'), 'synthetic');
    v_enrollment := app_private.record_orientation(v_project, v_worker, null, p_owner_user, v_company,
                                                   v_trades[1 + (i + 1) % 2], v_notice, 'SUPERVISED');
    update public.subcontractor_members set verification_status = 'VERIFIED'
     where worker_profile_id = v_worker and company_id = v_company;
    update public.worker_enrollments
       set enrollment_status = 'APPROVED', approved_by = p_owner_user, approval_at = now(),
           employer_status = 'VERIFIED', employer_confirmed_by = p_owner_user, employer_confirmed_at = now(), updated_at = now()
     where id = v_enrollment.id;
    insert into public.device_installations (worker_id, platform, hardware_installation_hash, app_version)
    values (v_worker, case when i % 2 = 0 then 'ANDROID' else 'IOS' end::public.device_platform,
            encode(pg_catalog.sha256(convert_to('sitemuster-demo-device|' || v_worker::text, 'UTF8')), 'hex'),
            'demo-synthetic')
    returning id into v_device;
    insert into app_private.demo_workers (worker_id, organization_id, project_id, device_id)
    values (v_worker, v_org, v_project, v_device);
    v_synthetic := v_synthetic || v_worker;
  end loop;

  -- Reviewer A as a worker and the verified foreman of the first company. The acknowledgement
  -- recorded here is marked for renewal: location stays off until the reviewer reads and accepts
  -- the notice in the app (Profile → Location and consent).
  v_notice := app_private.assert_notice_acceptable(v_project, 'en-US',
                                                   (app_private.current_notice(v_project, 'en-US')).id, true);
  insert into public.worker_profiles (auth_user_id, legal_name, primary_language, managed_identity, created_by)
  values (p_reviewer_user, 'App Reviewer (demo)', 'en-US', false, p_owner_user)
  returning id into v_reviewer_worker;
  perform app_private.replace_emergency_contact(v_reviewer_worker, 'Demo Contact R', '+15125550199', 'synthetic');
  v_enrollment := app_private.record_orientation(v_project, v_reviewer_worker, null, p_owner_user, v_companies[1],
                                                 'Concrete', v_notice, 'SUPERVISED');
  update public.subcontractor_members set verification_status = 'VERIFIED'
   where worker_profile_id = v_reviewer_worker and company_id = v_companies[1];
  insert into public.subcontractor_members (company_id, worker_profile_id, role, trade, verification_status, authorized_by)
  values (v_companies[1], v_reviewer_worker, 'FOREMAN', 'Concrete', 'VERIFIED', p_owner_user);
  update public.worker_enrollments
     set enrollment_status = 'APPROVED', approved_by = p_owner_user, approval_at = now(),
         employer_status = 'VERIFIED', employer_confirmed_by = p_owner_user, employer_confirmed_at = now(), updated_at = now()
   where id = v_enrollment.id;
  update public.tracking_consents set renewal_required_at = now()
   where worker_id = v_reviewer_worker and project_id = v_project and withdrawn_at is null;

  -- Reviewer B: a worker only.
  if p_deletion_user is not null then
    insert into public.worker_profiles (auth_user_id, legal_name, primary_language, managed_identity, created_by)
    values (p_deletion_user, 'Deletion Test (demo)', 'en-US', false, p_owner_user)
    returning id into v_deletion_worker;
    perform app_private.replace_emergency_contact(v_deletion_worker, 'Demo Contact T', '+15125550198', 'synthetic');
    v_enrollment := app_private.record_orientation(v_project, v_deletion_worker, null, p_owner_user, v_companies[2],
                                                   'Electrical', v_notice, 'SUPERVISED');
    update public.subcontractor_members set verification_status = 'VERIFIED'
     where worker_profile_id = v_deletion_worker and company_id = v_companies[2];
    update public.worker_enrollments
       set enrollment_status = 'APPROVED', approved_by = p_owner_user, approval_at = now(),
           employer_status = 'VERIFIED', employer_confirmed_by = p_owner_user, employer_confirmed_at = now(), updated_at = now()
     where id = v_enrollment.id;
    update public.tracking_consents set renewal_required_at = now()
     where worker_id = v_deletion_worker and project_id = v_project and withdrawn_at is null;
  end if;

  perform app_private.write_audit('SYSTEM', null, 'demo.seeded', v_org, v_project, 'organization', v_org, null,
                                  jsonb_build_object('synthetic_workers', array_length(v_synthetic, 1),
                                                     'deletion_account', p_deletion_user is not null));
  return jsonb_build_object('organization_id', v_org, 'project_id', v_project,
                            'company_ids', to_jsonb(v_companies), 'synthetic_worker_ids', to_jsonb(v_synthetic),
                            'reviewer_worker_id', v_reviewer_worker, 'deletion_worker_id', v_deletion_worker);
end;
$$;

-- Ends a demo: simulation stops and its projects are archived (records stay, as for any project).
create function app_private.retire_reviewer_demo(p_organization uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  update app_private.demo_organizations set retired_at = now()
   where organization_id = p_organization and retired_at is null;
  if not found then
    raise exception 'DEMO_NOT_FOUND' using errcode = '22023';
  end if;
  update public.projects set status = 'ARCHIVED', updated_at = now()
   where organization_id = p_organization and status <> 'ARCHIVED';
  perform app_private.write_audit('SYSTEM', null, 'demo.retired', p_organization, null, 'organization', p_organization,
                                  null, '{}'::jsonb);
  return jsonb_build_object('organization_id', p_organization, 'retired', true);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 4. Client reads (demo labels and the simulation screen)
-- ---------------------------------------------------------------------------------------------
-- The demo projects the caller belongs to (staff, organization member or enrolled worker). Empty
-- for everyone outside a demo organization.
create function public.my_demo_projects()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('project_id', p.id, 'organization_id', p.organization_id,
                                               'active', d.retired_at is null and p.status = 'ACTIVE')
                            order by p.id), '[]'::jsonb)
    from public.projects p
    join app_private.demo_organizations d on d.organization_id = p.organization_id
   where app_private.tenant_access_allowed()
     and (exists (select 1 from public.project_staff s
                   where s.project_id = p.id and s.user_id = auth.uid() and s.status = 'ACTIVE')
          or exists (select 1 from public.organization_members m
                      where m.organization_id = p.organization_id and m.user_id = auth.uid()
                        and m.membership_status = 'ACTIVE')
          or exists (select 1 from public.worker_enrollments e
                      where e.project_id = p.id and e.worker_id = app_private.current_worker_id()
                        and e.enrollment_status in ('PENDING', 'APPROVED')))
$$;

-- The synthetic people a simulation may move, with where the engine has them now.
create function public.demo_workers(p_project_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set timezone = 'UTC'
as $$
begin
  if auth.uid() is null or not app_private.can_correct_attendance(p_project_id)
     or not app_private.is_active_demo_project(p_project_id) then
    raise exception 'DEMO_NOT_ALLOWED' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'worker_id', w.id, 'name', w.legal_name, 'company_name', c.canonical_name,
             'presence', ps.presence_state, 'last_seen_at', ps.last_seen_at)
           order by w.legal_name, w.id)
      from app_private.demo_workers dw
      join public.worker_profiles w on w.id = dw.worker_id
      left join public.worker_enrollments e
        on e.worker_id = dw.worker_id and e.project_id = dw.project_id and e.enrollment_status = 'APPROVED'
      left join public.subcontractor_companies c on c.id = e.subcontractor_id
      left join public.presence_states ps on ps.project_id = dw.project_id and ps.worker_id = dw.worker_id
     where dw.project_id = p_project_id), '[]'::jsonb);
end;
$$;

-- Called by `demo-simulate` WITH THE CALLER'S OWN JWT: every check happens here, server-side.
create function public.begin_demo_simulation(
  p_project_id uuid,
  p_worker_id uuid,
  p_action text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set timezone = 'UTC'
as $$
declare
  v_uid uuid := auth.uid();
  v_demo app_private.demo_workers;
begin
  if v_uid is null then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_action is null or p_action not in ('ARRIVE', 'LEAVE') then
    raise exception 'INVALID_ACTION' using errcode = '22023';
  end if;
  if p_idempotency_key is null then
    raise exception 'IDEMPOTENCY_KEY_REQUIRED' using errcode = '22023';
  end if;
  -- One answer for "not a demo", "not yours" and "no MFA": nothing about the project is revealed.
  if not app_private.can_correct_attendance(p_project_id) or not app_private.is_active_demo_project(p_project_id) then
    raise exception 'DEMO_NOT_ALLOWED' using errcode = '42501';
  end if;
  select * into v_demo from app_private.demo_workers d
   where d.worker_id = p_worker_id and d.project_id = p_project_id;
  if v_demo.worker_id is null then
    raise exception 'NOT_A_DEMO_WORKER' using errcode = '42501';
  end if;
  if not app_private.consume_rate_limit('demo_simulation_hour', v_uid::text, 120, 3600) then
    raise exception 'RATE_LIMITED' using errcode = '22023';
  end if;
  perform app_private.write_audit('USER', v_uid, 'demo.simulated_' || lower(p_action),
                                  v_demo.organization_id, p_project_id, 'worker_profile', p_worker_id, null,
                                  jsonb_build_object('idempotency_key', p_idempotency_key));
  return jsonb_build_object(
    'device_id', v_demo.device_id, 'worker_id', v_demo.worker_id, 'project_id', v_demo.project_id,
    'action', p_action,
    'last_evidence_at', (select max(r.observed_at) from app_private.location_event_receipts r
                          where r.device_id = v_demo.device_id));
end;
$$;

-- The synthetic phone as the ingest pipeline sees it (service role only). Simulated positions are
-- generated by the server at the demo site, never taken from a phone, so they are allowed without
-- the per-build privacy sign-off that real phones need (decision #141).
create function public.edge_demo_device(p_device uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set timezone = 'UTC'
as $$
declare
  d public.device_installations;
begin
  select di.* into d
    from app_private.demo_workers dw
    join app_private.demo_organizations o on o.organization_id = dw.organization_id
    join public.device_installations di on di.id = dw.device_id
   where dw.device_id = p_device and o.retired_at is null and di.active;
  if d.id is null then
    return jsonb_build_object('status', 'INVALID');
  end if;
  return jsonb_build_object(
    'status', 'OK',
    'device_id', d.id,
    'worker_id', d.worker_id,
    'platform', d.platform,
    'coordinates_allowed', true,
    'fences', app_private.device_fences(d.id, d.worker_id));
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 5. Grants (deny by default; decision #57)
-- ---------------------------------------------------------------------------------------------
revoke all on table app_private.demo_organizations, app_private.demo_workers
  from public, anon, authenticated, service_role;

revoke all on function
  app_private.demo_device_credential_guard(), app_private.is_demo_project(uuid),
  app_private.is_active_demo_project(uuid), app_private.seed_reviewer_demo(uuid, uuid, uuid),
  app_private.retire_reviewer_demo(uuid)
  from public, anon, authenticated, service_role;

revoke all on function
  public.my_demo_projects(), public.demo_workers(uuid), public.begin_demo_simulation(uuid, uuid, text, uuid),
  public.edge_demo_device(uuid)
  from public, anon, authenticated, service_role;

grant execute on function
  public.my_demo_projects(), public.demo_workers(uuid), public.begin_demo_simulation(uuid, uuid, text, uuid)
  to authenticated;
grant execute on function public.edge_demo_device(uuid) to service_role;
