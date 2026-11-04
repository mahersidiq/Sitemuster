-- Milestone 13: the server-gated synthetic reviewer demo (docs/spec/09 "Reviewer/demo mode",
-- docs/spec/07 "Review simulation tries live project"; decisions #140–#143). Only an allowlisted
-- demo organization can be simulated, only for its synthetic people, only by its MFA staff; the
-- seed goes through the production notice gate; nothing reaches a real tenant.
begin;
select plan(41);
select tests.seed_world();

select tests.create_user('de000000-0000-4000-8000-0000000000a0', 'demo.owner@example.test');
select tests.create_user('de000000-0000-4000-8000-0000000000a1', 'reviewer.a@example.test', '+15125550150');
select tests.create_user('de000000-0000-4000-8000-0000000000a2', null, '+15125550151');

-- ---------------------------------------------------------------------------------------------
-- Seeding: database owner only, dedicated accounts, production notice gate
-- ---------------------------------------------------------------------------------------------
select ok(not has_function_privilege('authenticated', 'app_private.seed_reviewer_demo(uuid, uuid, uuid)', 'EXECUTE')
          and not has_function_privilege('service_role', 'app_private.seed_reviewer_demo(uuid, uuid, uuid)', 'EXECUTE')
          and not has_function_privilege('authenticated', 'app_private.retire_reviewer_demo(uuid)', 'EXECUTE'),
  'only the database owner can seed or retire a demo');
select is(
  (select count(*)::int from unnest(array['demo_organizations', 'demo_workers']) t(name)
     cross join unnest(array['anon', 'authenticated', 'service_role']) r(role)
    where has_table_privilege(r.role, 'app_private.' || t.name, 'SELECT,INSERT,UPDATE,DELETE')),
  0, 'no API role can read or change the demo allowlist');
select throws_ok(
  $$ select app_private.seed_reviewer_demo('de000000-0000-4000-8000-0000000000a0', 'de000000-0000-4000-8000-0000000000a0') $$,
  '22023', 'DEMO_USERS_MUST_DIFFER', 'the owner and a reviewer must be different accounts');
select throws_ok(
  format($$ select app_private.seed_reviewer_demo('de000000-0000-4000-8000-0000000000a0', %L) $$, tests.id('u_a_super')),
  '22023', 'DEMO_ACCOUNT_NOT_DEDICATED', 'a real customer account can never become a reviewer account');
select throws_ok(
  format($$ select app_private.seed_reviewer_demo('de000000-0000-4000-8000-0000000000a0', %L) $$, tests.id('u_operator')),
  '22023', 'DEMO_USER_IS_OPERATOR', 'the platform operator is never part of a demo');

update app_private.settings set value = 'production' where key = 'environment';
select throws_ok(
  $$ select app_private.seed_reviewer_demo('de000000-0000-4000-8000-0000000000a0', 'de000000-0000-4000-8000-0000000000a1') $$,
  '22023', 'CONSENT_NOTICE_NOT_APPROVED', 'in production the seed refuses until the notice is approved in both languages');
update app_private.settings set value = 'development' where key = 'environment';

select set_config('t.seed', app_private.seed_reviewer_demo(
  'de000000-0000-4000-8000-0000000000a0', 'de000000-0000-4000-8000-0000000000a1',
  'de000000-0000-4000-8000-0000000000a2')::text, true);
select set_config('t.org', current_setting('t.seed')::jsonb ->> 'organization_id', true);
select set_config('t.project', current_setting('t.seed')::jsonb ->> 'project_id', true);
select set_config('t.synthetic', current_setting('t.seed')::jsonb -> 'synthetic_worker_ids' ->> 0, true);
select set_config('t.reviewer_worker', current_setting('t.seed')::jsonb ->> 'reviewer_worker_id', true);
select set_config('t.device', (select device_id::text from app_private.demo_workers
                                where worker_id = current_setting('t.synthetic')::uuid), true);

select ok(exists (select 1 from app_private.demo_organizations
                   where organization_id = current_setting('t.org')::uuid and retired_at is null),
  'the seeded organization is on the allowlist');
select is((select count(*)::int from app_private.demo_workers where project_id = current_setting('t.project')::uuid),
  8, 'eight synthetic people');
select is(
  (select count(*)::int from app_private.demo_workers d
     join public.worker_profiles w on w.id = d.worker_id
    where w.managed_identity and w.auth_user_id is null and w.phone is null and w.email is null),
  8, 'every synthetic person is a no-phone identity: no account, no phone number, no email');
select is(
  (select count(*)::int from app_private.demo_workers d
     join public.device_project_bindings b on b.device_id = d.device_id and b.revoked_at is null
    where b.project_id = current_setting('t.project')::uuid),
  8, 'each synthetic phone record is bound to the demo project only');
select is(
  (select count(*)::int from app_private.device_upload_credentials c
     join app_private.demo_workers d on d.device_id = c.device_id),
  0, 'no synthetic phone record has an upload credential');
select throws_ok(
  $$ insert into app_private.device_upload_credentials (device_id, token_sha256, expires_at)
     values (current_setting('t.device')::uuid, sha256('demo'::bytea), now() + interval '30 days') $$,
  '42501', 'DEMO_DEVICE_HAS_NO_CREDENTIAL', 'and none can ever be issued');
select ok(
  (select v.operates_24_7 from public.projects p join public.project_tracking_config_versions v on v.id = p.config_version_id
    where p.id = current_setting('t.project')::uuid)
  and (select status = 'ACTIVE' from public.projects where id = current_setting('t.project')::uuid),
  'the demo site is active and runs 24/7 (a simulation is never outside the schedule)');
select ok(
  (select bool_and(e.enrollment_status = 'APPROVED' and e.employer_status = 'VERIFIED')
     from public.worker_enrollments e where e.project_id = current_setting('t.project')::uuid),
  'every demo enrollment is approved with a verified employer');
select is(
  (select array_agg(role::text order by role) from public.project_staff
    where project_id = current_setting('t.project')::uuid and user_id = 'de000000-0000-4000-8000-0000000000a1' and status = 'ACTIVE'),
  array['SUPER', 'SAFETY', 'ATTENDANT'],
  'reviewer A is superintendent, safety manager and kiosk attendant on the demo project');
select ok(
  (select emergency_designated from public.project_staff
    where project_id = current_setting('t.project')::uuid and user_id = 'de000000-0000-4000-8000-0000000000a1' and role = 'SAFETY'),
  'reviewer A holds the emergency role (muster drills)');
select ok(
  exists (select 1 from public.tracking_consents c
           where c.worker_id = current_setting('t.reviewer_worker')::uuid and c.withdrawn_at is null
             and c.renewal_required_at is not null),
  'reviewer A reads and accepts the notice in the app before location turns on');
select is(
  (select owner_user_id from public.organizations where id = current_setting('t.org')::uuid),
  'de000000-0000-4000-8000-0000000000a0'::uuid,
  'an owner-controlled account owns the demo, so reviewer accounts stay deletable');
select throws_ok(
  $$ select app_private.seed_reviewer_demo('de000000-0000-4000-8000-0000000000a0', 'de000000-0000-4000-8000-0000000000a1') $$,
  '22023', 'DEMO_ALREADY_SEEDED', 'one active demo at a time');

-- ---------------------------------------------------------------------------------------------
-- Client reads: labels and the simulation list
-- ---------------------------------------------------------------------------------------------
select tests.authenticate_as('de000000-0000-4000-8000-0000000000a1', 'aal2');
select is(public.my_demo_projects() -> 0 ->> 'project_id', current_setting('t.project'),
  'reviewer A sees the demo project marked as a demo');
select is(jsonb_array_length(public.demo_workers(current_setting('t.project')::uuid)), 8,
  'reviewer A (MFA) lists the synthetic people');
select throws_ok(format('select public.demo_workers(%L)', tests.id('p_a1')), '42501', 'DEMO_NOT_ALLOWED',
  'a real project never lists anyone for simulation');
select tests.authenticate_as('de000000-0000-4000-8000-0000000000a1', 'aal1');
select throws_ok(format('select public.demo_workers(%L)', current_setting('t.project')), '42501', 'DEMO_NOT_ALLOWED',
  'without the authenticator step the list is refused');
select tests.authenticate_as(tests.id('u_a_super'), 'aal2');
select is(public.my_demo_projects(), '[]'::jsonb, 'a real customer sees no demo project');
select throws_ok(format('select public.demo_workers(%L)', current_setting('t.project')), '42501', 'DEMO_NOT_ALLOWED',
  'another tenant''s staff cannot list the demo people');

-- ---------------------------------------------------------------------------------------------
-- Beginning a simulation: every check is server-side
-- ---------------------------------------------------------------------------------------------
select tests.authenticate_as('de000000-0000-4000-8000-0000000000a1', 'aal2');
select is(
  public.begin_demo_simulation(current_setting('t.project')::uuid, current_setting('t.synthetic')::uuid, 'ARRIVE', gen_random_uuid()) ->> 'device_id',
  current_setting('t.device'), 'reviewer A may simulate a synthetic person; the server names the phone record');
select throws_ok(
  format('select public.begin_demo_simulation(%L, %L, %L, gen_random_uuid())', current_setting('t.project'), current_setting('t.reviewer_worker'), 'ARRIVE'),
  '42501', 'NOT_A_DEMO_WORKER', 'a real account in the demo (the reviewer''s own phone) is never simulated');
select throws_ok(
  format('select public.begin_demo_simulation(%L, %L, %L, gen_random_uuid())', tests.id('p_a1'), tests.id('w_a1'), 'ARRIVE'),
  '42501', 'DEMO_NOT_ALLOWED', 'reviewer A cannot simulate anyone on a real project');
select throws_ok(
  format('select public.begin_demo_simulation(%L, %L, %L, gen_random_uuid())', current_setting('t.project'), current_setting('t.synthetic'), 'TELEPORT'),
  '22023', 'INVALID_ACTION', 'only arrival and departure exist');
select tests.authenticate_as('de000000-0000-4000-8000-0000000000a2', 'aal1');
select throws_ok(
  format('select public.begin_demo_simulation(%L, %L, %L, gen_random_uuid())', current_setting('t.project'), current_setting('t.synthetic'), 'ARRIVE'),
  '42501', 'DEMO_NOT_ALLOWED', 'reviewer B (a worker only) cannot simulate');
select tests.authenticate_as(tests.id('u_a_owner'), 'aal2');
select throws_ok(
  format('select public.begin_demo_simulation(%L, %L, %L, gen_random_uuid())', current_setting('t.project'), current_setting('t.synthetic'), 'ARRIVE'),
  '42501', 'DEMO_NOT_ALLOWED', 'another tenant''s owner cannot simulate in the demo');
select tests.as_postgres();
select is(
  (select count(*)::int from app_private.audit_logs
    where action = 'demo.simulated_arrive' and actor_id = 'de000000-0000-4000-8000-0000000000a1'),
  1, 'every allowed simulation is audited with the person who asked for it');

-- ---------------------------------------------------------------------------------------------
-- The synthetic phone as the ingest pipeline sees it (service role)
-- ---------------------------------------------------------------------------------------------
set local role service_role;
select set_config('t.dev_demo', public.edge_demo_device(current_setting('t.device')::uuid)::text, true);
select set_config('t.dev_real', public.edge_demo_device('00000000-0000-4000-8000-0000000000d1'::uuid)::text, true);
reset role;
select is(current_setting('t.dev_demo')::jsonb ->> 'status', 'OK', 'the synthetic phone record resolves');
select is(current_setting('t.dev_demo')::jsonb -> 'fences' -> 0 ->> 'projectId', current_setting('t.project'),
  'with the demo project''s fence only');
select is(jsonb_array_length(current_setting('t.dev_demo')::jsonb -> 'fences'), 1, 'and nothing else');
select is(current_setting('t.dev_real')::jsonb ->> 'status', 'INVALID', 'a real phone is never treated as a demo phone');
select ok(not has_function_privilege('authenticated', 'public.edge_demo_device(uuid)', 'EXECUTE'),
  'only the Edge Function can read a synthetic phone record');

-- ---------------------------------------------------------------------------------------------
-- Retiring the demo stops simulation
-- ---------------------------------------------------------------------------------------------
select app_private.retire_reviewer_demo(current_setting('t.org')::uuid);
select is((select status::text from public.projects where id = current_setting('t.project')::uuid), 'ARCHIVED',
  'retiring archives the demo project');
select tests.authenticate_as('de000000-0000-4000-8000-0000000000a1', 'aal2');
select throws_ok(
  format('select public.begin_demo_simulation(%L, %L, %L, gen_random_uuid())', current_setting('t.project'), current_setting('t.synthetic'), 'ARRIVE'),
  '42501', 'DEMO_NOT_ALLOWED', 'a retired demo cannot be simulated');
select is(public.my_demo_projects() -> 0 ->> 'active', 'false', 'and is shown as inactive');
select tests.as_postgres();
set local role service_role;
select set_config('t.dev_retired', public.edge_demo_device(current_setting('t.device')::uuid)::text, true);
reset role;
select is(current_setting('t.dev_retired')::jsonb ->> 'status', 'INVALID', 'its synthetic phones are refused too');

select * from finish();
rollback;
