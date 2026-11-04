-- Test-only helpers (local Docker / CI database only — never a migration, never production).
-- Installs a `tests` schema with role switching and a deterministic two-tenant fixture. This file
-- intentionally commits (no BEGIN/ROLLBACK) so later test files can use the helpers; every other
-- test file runs inside its own transaction and rolls back.

create schema if not exists tests;
grant usage on schema tests to anon, authenticated;

-- Switch the current transaction to the `authenticated` role with JWT claims (aal2 = MFA done).
create or replace function tests.authenticate_as(p_user uuid, p_aal text default 'aal2')
returns void
language plpgsql
as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal)::text, true);
  perform set_config('role', 'authenticated', true);
end;
$$;

create or replace function tests.authenticate_as_anon()
returns void
language plpgsql
as $$
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  perform set_config('role', 'anon', true);
end;
$$;

-- Back to the test superuser (fixture setup, privileged checks).
create or replace function tests.as_postgres()
returns void
language plpgsql
as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
end;
$$;

create or replace function tests.create_user(p_id uuid, p_email text default null, p_phone text default null)
returns uuid
language plpgsql
as $$
begin
  insert into auth.users (instance_id, id, aud, role, email, phone, email_confirmed_at, phone_confirmed_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values ('00000000-0000-0000-0000-000000000000', p_id, 'authenticated', 'authenticated', p_email, p_phone,
          case when p_email is not null then now() end, case when p_phone is not null then now() end,
          '{}'::jsonb, '{}'::jsonb, now(), now());
  return p_id;
end;
$$;

-- Fixed identifiers used by every test file (see seed_world).
create or replace function tests.id(p_name text)
returns uuid
language sql
immutable
as $$
  select (case p_name
    when 'u_a_owner'    then 'a1000000-0000-4000-8000-000000000001'
    when 'u_a_admin'    then 'a1000000-0000-4000-8000-000000000002'
    when 'u_a_pm'       then 'a1000000-0000-4000-8000-000000000003'
    when 'u_a_super'    then 'a1000000-0000-4000-8000-000000000004'
    when 'u_a_safety'   then 'a1000000-0000-4000-8000-000000000005'
    when 'u_a_attendant' then 'a1000000-0000-4000-8000-000000000006'
    when 'u_b_owner'    then 'b1000000-0000-4000-8000-000000000001'
    when 'u_b_super'    then 'b1000000-0000-4000-8000-000000000004'
    when 'u_foreman_a'  then 'f1000000-0000-4000-8000-000000000001'
    when 'u_foreman_b'  then 'f1000000-0000-4000-8000-000000000002'
    when 'u_worker_a1'  then 'c1000000-0000-4000-8000-000000000001'
    when 'u_worker_a2'  then 'c1000000-0000-4000-8000-000000000002'
    when 'u_worker_b1'  then 'c1000000-0000-4000-8000-000000000003'
    when 'u_operator'   then 'e1000000-0000-4000-8000-000000000001'
    when 'u_outsider'   then 'd1000000-0000-4000-8000-000000000001'
    when 'org_a'        then '0a000000-0000-4000-8000-00000000000a'
    when 'org_b'        then '0b000000-0000-4000-8000-00000000000b'
    when 'p_a1'         then '1a000000-0000-4000-8000-0000000000a1'
    when 'p_b1'         then '1b000000-0000-4000-8000-0000000000b1'
    when 'cv_a1'        then '2a000000-0000-4000-8000-0000000000a1'
    when 'cv_b1'        then '2b000000-0000-4000-8000-0000000000b1'
    when 'c_a'          then '3a000000-0000-4000-8000-00000000000a'
    when 'c_b'          then '3b000000-0000-4000-8000-00000000000b'
    when 'w_fa'         then '4f000000-0000-4000-8000-0000000000fa'
    when 'w_fb'         then '4f000000-0000-4000-8000-0000000000fb'
    when 'w_a1'         then '4a000000-0000-4000-8000-0000000000a1'
    when 'w_a2'         then '4a000000-0000-4000-8000-0000000000a2'
    when 'w_b1'         then '4b000000-0000-4000-8000-0000000000b1'
    when 'w_managed'    then '4c000000-0000-4000-8000-0000000000c1'
    when 'e_a1'         then '5e000000-0000-4000-8000-0000000000a1'
    when 'e_a2'         then '5e000000-0000-4000-8000-0000000000a2'
    when 'e_b1'         then '5e000000-0000-4000-8000-0000000000b1'
    when 'e_managed'    then '5e000000-0000-4000-8000-0000000000c1'
    when 'e_fa'         then '5e000000-0000-4000-8000-0000000000fa'
    when 'd_a1'         then '5d000000-0000-4000-8000-0000000000a1'
    when 'd_a1_old'     then '5d000000-0000-4000-8000-0000000000a0'
    when 's_a1'         then '6a000000-0000-4000-8000-0000000000a1'
    when 's_b1'         then '6b000000-0000-4000-8000-0000000000b1'
    when 'ev_a1'        then '7a000000-0000-4000-8000-0000000000a1'
    when 'ev_b1'        then '7b000000-0000-4000-8000-0000000000b1'
    when 'v_a'          then '8a000000-0000-4000-8000-00000000000a'
    when 'vv_a'         then '8b000000-0000-4000-8000-00000000000a'
    when 'm_a'          then '9a000000-0000-4000-8000-00000000000a'
    when 'mm_a1'        then '9b000000-0000-4000-8000-0000000000a1'
    when 'mm_v'         then '9b000000-0000-4000-8000-00000000000e'
    when 'n_en'         then 'aa000000-0000-4000-8000-0000000000e1'
    when 'k_a'          then 'ab000000-0000-4000-8000-00000000000a'
  end)::uuid
$$;

-- Complete settings document like production versions (null before Milestone 04 helpers exist).
create or replace function tests.full_settings(p_radius numeric, p_24_7 boolean)
returns jsonb
language plpgsql
as $$
begin
  if to_regprocedure('app_private.build_settings(numeric, integer, numeric, boolean, jsonb)') is null then
    return null;
  end if;
  return app_private.build_settings(p_radius, 600, 75, p_24_7,
    (select jsonb_agg(jsonb_build_object('weekday', d, 'local_start_time', '06:00', 'local_end_time', '18:00'))
       from generate_series(1, 6) d));
end;
$$;

-- Deterministic two-tenant world. Run as postgres at the start of a test transaction.
create or replace function tests.seed_world()
returns void
language plpgsql
as $$
declare
  t timestamptz := '2026-11-03 14:00:00+00';
begin
  perform tests.create_user(tests.id('u_a_owner'), 'owner.a@example.test');
  perform tests.create_user(tests.id('u_a_admin'), 'admin.a@example.test');
  perform tests.create_user(tests.id('u_a_pm'), 'pm.a@example.test');
  perform tests.create_user(tests.id('u_a_super'), 'super.a@example.test');
  perform tests.create_user(tests.id('u_a_safety'), 'safety.a@example.test');
  perform tests.create_user(tests.id('u_a_attendant'), 'attendant.a@example.test');
  perform tests.create_user(tests.id('u_b_owner'), 'owner.b@example.test');
  perform tests.create_user(tests.id('u_b_super'), 'super.b@example.test');
  perform tests.create_user(tests.id('u_foreman_a'), null, '+15550000101');
  perform tests.create_user(tests.id('u_foreman_b'), null, '+15550000102');
  perform tests.create_user(tests.id('u_worker_a1'), null, '+15550000201');
  perform tests.create_user(tests.id('u_worker_a2'), null, '+15550000202');
  perform tests.create_user(tests.id('u_worker_b1'), null, '+15550000203');
  perform tests.create_user(tests.id('u_operator'), 'operator@example.test');
  perform tests.create_user(tests.id('u_outsider'), 'outsider@example.test');

  insert into app_private.platform_operators (user_id) values (tests.id('u_operator'));

  insert into public.organizations (id, name, owner_user_id, idempotency_key) values
    (tests.id('org_a'), 'GC Alpha', tests.id('u_a_owner'), gen_random_uuid()),
    (tests.id('org_b'), 'GC Bravo', tests.id('u_b_owner'), gen_random_uuid());
  insert into public.organization_members (organization_id, user_id, role) values
    (tests.id('org_a'), tests.id('u_a_owner'), 'OWNER'),
    (tests.id('org_a'), tests.id('u_a_admin'), 'ADMIN'),
    (tests.id('org_b'), tests.id('u_b_owner'), 'OWNER');

  insert into public.projects (id, organization_id, name, iana_timezone, status, idempotency_key) values
    (tests.id('p_a1'), tests.id('org_a'), 'Alpha Tower', 'America/Chicago', 'ACTIVE', gen_random_uuid()),
    (tests.id('p_b1'), tests.id('org_b'), 'Bravo Plant', 'America/New_York', 'ACTIVE', gen_random_uuid());
  insert into public.project_tracking_config_versions (id, project_id, version_number, effective_at, settings_json) values
    (tests.id('cv_a1'), tests.id('p_a1'), 1, t - interval '30 days',
     coalesce(tests.full_settings(150, false), '{"geofence_radius_m":150}'::jsonb)),
    (tests.id('cv_b1'), tests.id('p_b1'), 1, t - interval '30 days',
     coalesce(tests.full_settings(200, false), '{"geofence_radius_m":200}'::jsonb));
  update public.projects set config_version_id = tests.id('cv_a1') where id = tests.id('p_a1');
  update public.projects set config_version_id = tests.id('cv_b1') where id = tests.id('p_b1');
  insert into public.project_geofences (config_version_id, project_id, center, radius_m) values
    (tests.id('cv_a1'), tests.id('p_a1'), extensions.st_setsrid(extensions.st_makepoint(-95.3698, 29.7604), 4326)::extensions.geography, 150),
    (tests.id('cv_b1'), tests.id('p_b1'), extensions.st_setsrid(extensions.st_makepoint(-74.0060, 40.7128), 4326)::extensions.geography, 200);
  insert into public.project_work_windows (config_version_id, weekday, local_start_time, local_end_time, crosses_midnight)
  select tests.id('cv_a1'), d, '06:00', '18:00', false from generate_series(1, 6) d;

  insert into public.project_staff (project_id, user_id, role, emergency_designated) values
    (tests.id('p_a1'), tests.id('u_a_pm'), 'PM', false),
    (tests.id('p_a1'), tests.id('u_a_super'), 'SUPER', false),
    (tests.id('p_a1'), tests.id('u_a_safety'), 'SAFETY', false),
    (tests.id('p_a1'), tests.id('u_a_attendant'), 'ATTENDANT', false),
    (tests.id('p_b1'), tests.id('u_b_super'), 'SUPER', true);

  insert into public.subcontractor_companies (id, canonical_name) values
    (tests.id('c_a'), 'Acme Concrete'), (tests.id('c_b'), 'Bolt Electric');
  insert into public.project_subcontractors (project_id, subcontractor_id, status) values
    (tests.id('p_a1'), tests.id('c_a'), 'APPROVED'),
    (tests.id('p_b1'), tests.id('c_b'), 'APPROVED');

  insert into public.worker_profiles (id, auth_user_id, legal_name, phone, managed_identity) values
    (tests.id('w_fa'), tests.id('u_foreman_a'), 'Fernando Alvarez', '+15550000101', false),
    (tests.id('w_fb'), tests.id('u_foreman_b'), 'Frank Brown', '+15550000102', false),
    (tests.id('w_a1'), tests.id('u_worker_a1'), 'Ana Acosta', '+15550000201', false),
    (tests.id('w_a2'), tests.id('u_worker_a2'), 'Ben Avila', '+15550000202', false),
    (tests.id('w_b1'), tests.id('u_worker_b1'), 'Carla Banks', '+15550000203', false),
    (tests.id('w_managed'), null, 'Diego No-Phone', null, true);

  insert into public.subcontractor_members (company_id, worker_profile_id, role, verification_status) values
    (tests.id('c_a'), tests.id('w_fa'), 'FOREMAN', 'VERIFIED'),
    (tests.id('c_b'), tests.id('w_fb'), 'FOREMAN', 'VERIFIED'),
    (tests.id('c_a'), tests.id('w_a1'), 'WORKER', 'VERIFIED'),
    (tests.id('c_a'), tests.id('w_a2'), 'WORKER', 'VERIFIED'),
    (tests.id('c_a'), tests.id('w_managed'), 'WORKER', 'VERIFIED'),
    (tests.id('c_b'), tests.id('w_b1'), 'WORKER', 'VERIFIED');

  insert into public.legal_notice_versions (id, document_id, locale, document_type, version, content) values
    (tests.id('n_en'), 'TEST_WORKER_NOTICE_EN_V1', 'en-US', 'WORKER_LOCATION_DISCLOSURE', 1, 'Synthetic test notice (draft).');

  insert into public.orientation_records (worker_profile_id, project_id, completed_at, notice_version_id)
  select w, p, t - interval '7 days', tests.id('n_en')
    from (values (tests.id('w_a1'), tests.id('p_a1')), (tests.id('w_a2'), tests.id('p_a1')),
                 (tests.id('w_managed'), tests.id('p_a1')), (tests.id('w_fa'), tests.id('p_a1')),
                 (tests.id('w_b1'), tests.id('p_b1')), (tests.id('w_fb'), tests.id('p_b1'))) v(w, p);

  insert into public.worker_enrollments (id, project_id, worker_id, subcontractor_id, enrollment_status, employer_status,
                                         approved_by, approval_at, employer_confirmed_by, employer_confirmed_at) values
    (tests.id('e_a1'), tests.id('p_a1'), tests.id('w_a1'), tests.id('c_a'), 'APPROVED', 'VERIFIED', tests.id('u_a_super'), t - interval '6 days', tests.id('u_a_super'), t - interval '6 days'),
    (tests.id('e_a2'), tests.id('p_a1'), tests.id('w_a2'), tests.id('c_a'), 'APPROVED', 'VERIFIED', tests.id('u_a_super'), t - interval '6 days', tests.id('u_a_super'), t - interval '6 days'),
    (tests.id('e_managed'), tests.id('p_a1'), tests.id('w_managed'), tests.id('c_a'), 'APPROVED', 'VERIFIED', tests.id('u_a_super'), t - interval '6 days', tests.id('u_a_super'), t - interval '6 days'),
    (tests.id('e_fa'), tests.id('p_a1'), tests.id('w_fa'), tests.id('c_a'), 'APPROVED', 'VERIFIED', tests.id('u_a_super'), t - interval '6 days', tests.id('u_a_super'), t - interval '6 days'),
    (tests.id('e_b1'), tests.id('p_b1'), tests.id('w_b1'), tests.id('c_b'), 'APPROVED', 'VERIFIED', tests.id('u_b_super'), t - interval '6 days', tests.id('u_b_super'), t - interval '6 days');
  insert into public.worker_enrollments (project_id, worker_id, subcontractor_id, enrollment_status, employer_status, approved_by, approval_at)
  values (tests.id('p_b1'), tests.id('w_fb'), tests.id('c_b'), 'APPROVED', 'PENDING_CONFIRMATION', tests.id('u_b_super'), t - interval '6 days');

  insert into public.tracking_consents (worker_id, project_id, notice_version_id, locale, method, accepted_at)
  values (tests.id('w_a1'), tests.id('p_a1'), tests.id('n_en'), 'en-US', 'DIGITAL', t - interval '6 days');

  insert into public.emergency_contacts (worker_profile_id, name, phone, relationship) values
    (tests.id('w_a1'), 'Maria Acosta', '+15550009991', 'spouse'),
    (tests.id('w_b1'), 'Tom Banks', '+15550009992', 'parent');

  insert into public.device_installations (id, worker_id, platform, hardware_installation_hash, active, deactivated_at) values
    (tests.id('d_a1_old'), tests.id('w_a1'), 'ANDROID', repeat('a', 64), false, t - interval '2 days'),
    (tests.id('d_a1'), tests.id('w_a1'), 'IOS', repeat('b', 64), true, null);
  -- Since Milestone 07 the binding is derived by trigger (decision #89); keep the explicit row for
  -- earlier milestones' tests without duplicating it.
  insert into public.device_project_bindings (device_id, project_id, enrollment_id, config_version_id)
  values (tests.id('d_a1'), tests.id('p_a1'), tests.id('e_a1'), tests.id('cv_a1'))
  on conflict (device_id, project_id) where revoked_at is null do nothing;

  insert into public.kiosk_devices (id, project_id, assigned_operator_user_id, device_public_id)
  values (tests.id('k_a'), tests.id('p_a1'), tests.id('u_a_attendant'), 'kiosk-alpha-0001');

  insert into public.latest_onsite_positions (project_id, worker_id, position, horizontal_accuracy_m, observed_at, expiry_at) values
    (tests.id('p_a1'), tests.id('w_a1'), extensions.st_setsrid(extensions.st_makepoint(-95.3697, 29.7605), 4326)::extensions.geography, 12, t, t + interval '10 minutes'),
    (tests.id('p_a1'), tests.id('w_a2'), extensions.st_setsrid(extensions.st_makepoint(-95.3699, 29.7603), 4326)::extensions.geography, 20, t, t + interval '10 minutes'),
    (tests.id('p_b1'), tests.id('w_b1'), extensions.st_setsrid(extensions.st_makepoint(-74.0061, 40.7129), 4326)::extensions.geography, 15, t, t + interval '10 minutes');

  insert into public.attendance_sessions (id, project_id, worker_id, employer_snapshot_id, start_at, start_source, config_version_id, status, iana_timezone) values
    (tests.id('s_a1'), tests.id('p_a1'), tests.id('w_a1'), tests.id('c_a'), t - interval '3 hours', 'GEOFENCE', tests.id('cv_a1'), 'OPEN', 'America/Chicago'),
    (tests.id('s_b1'), tests.id('p_b1'), tests.id('w_b1'), tests.id('c_b'), t - interval '2 hours', 'GEOFENCE', tests.id('cv_b1'), 'OPEN', 'America/New_York');
  insert into public.attendance_events (event_uuid, worker_id, project_id, session_id, device_id, config_version_id, source, direction, observed_at, verification_status, confidence) values
    (tests.id('ev_a1'), tests.id('w_a1'), tests.id('p_a1'), tests.id('s_a1'), tests.id('d_a1'), tests.id('cv_a1'), 'GEOFENCE', 'ENTRY', t - interval '3 hours', 'SYSTEM_CONFIRMED', 'MEDIUM');
  insert into public.attendance_events (event_uuid, worker_id, project_id, session_id, actor_id, config_version_id, source, direction, observed_at, verification_status, confidence) values
    (tests.id('ev_b1'), tests.id('w_b1'), tests.id('p_b1'), tests.id('s_b1'), tests.id('u_foreman_b'), tests.id('cv_b1'), 'FOREMAN', 'ENTRY', t - interval '2 hours', 'WITNESSED', 'MEDIUM');
  insert into public.presence_states (project_id, worker_id, presence_state, first_inside_at, last_seen_at, confidence, config_version_id) values
    (tests.id('p_a1'), tests.id('w_a1'), 'ONSITE_ESTIMATED', t - interval '3 hours', t, 'MEDIUM', tests.id('cv_a1')),
    (tests.id('p_b1'), tests.id('w_b1'), 'ONSITE_ESTIMATED', t - interval '2 hours', t, 'MEDIUM', tests.id('cv_b1'));

  insert into public.visitor_records (id, project_id, name, organization, host_user_id, purpose, contact_phone)
  values (tests.id('v_a'), tests.id('p_a1'), 'Ivy Inspector', 'City of Houston', tests.id('u_a_super'), 'Inspection', '+15550008881');
  insert into public.visitor_visits (id, visitor_id, project_id, kiosk_actor_id, kiosk_device_id, checked_in_at, idempotency_key)
  values (tests.id('vv_a'), tests.id('v_a'), tests.id('p_a1'), tests.id('u_a_attendant'), tests.id('k_a'), t - interval '1 hour', gen_random_uuid());

  insert into public.muster_events (id, project_id, triggered_by, incident_label, idempotency_key, config_version_id)
  values (tests.id('m_a'), tests.id('p_a1'), tests.id('u_a_safety'), 'Drill', gen_random_uuid(), tests.id('cv_a1'));
  insert into public.muster_snapshot_members (id, muster_id, worker_id, employer_id, initial_status, canonical_status) values
    (tests.id('mm_a1'), tests.id('m_a'), tests.id('w_a1'), tests.id('c_a'), 'UNACCOUNTED', 'UNACCOUNTED');
  insert into public.muster_snapshot_members (id, muster_id, visitor_id, initial_status, canonical_status) values
    (tests.id('mm_v'), tests.id('m_a'), tests.id('v_a'), 'UNACCOUNTED', 'UNACCOUNTED');

  insert into public.daily_company_reports (project_id, subcontractor_id, local_date, summary, due_at) values
    (tests.id('p_a1'), tests.id('c_a'), '2026-11-02', '{"estimated_onsite_hours": 16}', '2026-11-03 18:00:00+00'),
    (tests.id('p_b1'), tests.id('c_b'), '2026-11-02', '{"estimated_onsite_hours": 8}', '2026-11-03 17:00:00+00');
end;
$$;

grant execute on all functions in schema tests to anon, authenticated;

begin;
select plan(1);
select ok(to_regprocedure('tests.seed_world()') is not null, 'test helpers installed');
select * from finish();
rollback;
