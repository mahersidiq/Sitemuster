-- Regression tests for the automated-review findings on merged PRs #2 and #4 (decision #76):
-- delegated PMs cannot grant roles with implicit powers, platform operators lose delegated-PM
-- powers, and foreman grants cover only the company that carries them.
begin;
select plan(13);
select tests.seed_world();

-- A PM with staffing delegation may add plain roles, never SUPER (configures) or SAFETY (emergency).
update public.project_staff set can_assign_staff = true, can_configure_project = true
 where project_id = tests.id('p_a1') and user_id = tests.id('u_a_pm');
select tests.authenticate_as(tests.id('u_a_pm'));
select throws_ok(format($$select public.invite_project_staff(%L, 'boss@example.test', 'SUPER')$$, tests.id('p_a1')),
  '42501', 'DELEGATION_REQUIRES_ORG_ADMIN', 'delegated PM cannot invite a superintendent (implicit configuration)');
select throws_ok(format($$select public.invite_project_staff(%L, 'safe@example.test', 'SAFETY')$$, tests.id('p_a1')),
  '42501', 'DELEGATION_REQUIRES_ORG_ADMIN', 'delegated PM cannot invite a safety manager (implicit emergency role)');
select lives_ok(format($$select public.invite_project_staff(%L, 'gate2@example.test', 'ATTENDANT')$$, tests.id('p_a1')),
  'delegated PM can still invite a kiosk attendant');
select lives_ok(format($$select public.invite_project_staff(%L, 'pm2@example.test', 'PM')$$, tests.id('p_a1')),
  'delegated PM can still invite a plain PM');
select tests.authenticate_as(tests.id('u_a_owner'));
select lives_ok(format($$select public.invite_project_staff(%L, 'boss@example.test', 'SUPER')$$, tests.id('p_a1')),
  'the organization owner can invite a superintendent');

-- A delegated PM who becomes a platform operator keeps no tenant powers.
select tests.as_postgres();
insert into app_private.platform_operators (user_id) values (tests.id('u_a_pm'));
select set_config('request.jwt.claims', json_build_object('sub', tests.id('u_a_pm'), 'role', 'authenticated', 'aal', 'aal2')::text, true);
select is(app_private.can_configure_project(tests.id('p_a1')), false, 'platform operator loses delegated configuration');
select is(app_private.can_assign_staff(tests.id('p_a1')), false, 'platform operator loses delegated staffing');
select tests.authenticate_as(tests.id('u_a_pm'));
select throws_ok(format($$select public.invite_project_staff(%L, 'x@example.test', 'ATTENDANT')$$, tests.id('p_a1')),
  '42501', 'FORBIDDEN', 'platform operator cannot invite staff through a delegated PM row');
select tests.as_postgres();
delete from app_private.platform_operators where user_id = tests.id('u_a_pm');

-- Foreman of two companies on one project; the location/emergency grant covers only company A.
insert into public.subcontractor_companies (id, canonical_name) values ('77000000-0000-4000-8000-00000000000c', 'Xylo Masonry');
insert into public.project_subcontractors (project_id, subcontractor_id, status)
values (tests.id('p_a1'), '77000000-0000-4000-8000-00000000000c', 'APPROVED');
insert into public.subcontractor_members (company_id, worker_profile_id, role, verification_status)
values ('77000000-0000-4000-8000-00000000000c', tests.id('w_fa'), 'FOREMAN', 'VERIFIED');
insert into public.worker_profiles (id, legal_name, managed_identity) values ('77000000-0000-4000-8000-0000000000a1', 'Xavier Mason', true);
insert into public.subcontractor_members (company_id, worker_profile_id, role, verification_status)
values ('77000000-0000-4000-8000-00000000000c', '77000000-0000-4000-8000-0000000000a1', 'WORKER', 'VERIFIED');
insert into public.orientation_records (worker_profile_id, project_id, completed_at, notice_version_id)
values ('77000000-0000-4000-8000-0000000000a1', tests.id('p_a1'), now(), tests.id('n_en'));
insert into public.worker_enrollments (project_id, worker_id, subcontractor_id, enrollment_status, employer_status, approved_by,
                                       approval_at, employer_confirmed_by, employer_confirmed_at)
values (tests.id('p_a1'), '77000000-0000-4000-8000-0000000000a1', '77000000-0000-4000-8000-00000000000c', 'APPROVED', 'VERIFIED',
        tests.id('u_a_super'), now(), tests.id('u_a_super'), now());
insert into public.latest_onsite_positions (project_id, worker_id, position, horizontal_accuracy_m, observed_at, expiry_at)
values (tests.id('p_a1'), '77000000-0000-4000-8000-0000000000a1',
        extensions.st_setsrid(extensions.st_makepoint(-95.3698, 29.7604), 4326)::extensions.geography, 10, now(), now() + interval '10 minutes');
insert into public.emergency_contacts (worker_profile_id, name, phone) values ('77000000-0000-4000-8000-0000000000a1', 'Xena Mason', '+15550009999');
delete from public.foreman_project_grants where foreman_profile_id = tests.id('w_fa');
insert into public.foreman_project_grants (project_id, subcontractor_id, foreman_profile_id, can_view_locations, can_view_emergency_contacts)
values (tests.id('p_a1'), tests.id('c_a'), tests.id('w_fa'), true, true);

select tests.authenticate_as(tests.id('u_foreman_a'));
select is((select count(*)::int from public.latest_onsite_positions where worker_id = tests.id('w_a1')), 1,
  'the grant for company A shows company A positions');
select is((select count(*)::int from public.latest_onsite_positions where worker_id = '77000000-0000-4000-8000-0000000000a1'), 0,
  'the grant for company A does not show company X positions');
select ok((select count(*) from public.emergency_contacts where worker_profile_id = tests.id('w_a1')) >= 1,
  'the emergency grant for company A shows company A contacts');
select is((select count(*)::int from public.emergency_contacts where worker_profile_id = '77000000-0000-4000-8000-0000000000a1'), 0,
  'the emergency grant for company A does not show company X contacts');
select tests.as_postgres();
insert into public.foreman_project_grants (project_id, subcontractor_id, foreman_profile_id, can_view_locations)
values (tests.id('p_a1'), '77000000-0000-4000-8000-00000000000c', tests.id('w_fa'), true);
select tests.authenticate_as(tests.id('u_foreman_a'));
select is((select count(*)::int from public.latest_onsite_positions where worker_id = '77000000-0000-4000-8000-0000000000a1'), 1,
  'a separate grant for company X shows company X positions');

select * from finish();
rollback;
