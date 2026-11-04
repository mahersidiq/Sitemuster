-- Foreman and worker boundaries (spec 02): own company / own records only; locations and
-- emergency contacts for foremen only by explicit GC grant; no worker writes anywhere.
begin;
select plan(32);
select tests.seed_world();

-- Foreman A (phone OTP session, aal1): own company crew on project A1 only.
select tests.authenticate_as(tests.id('u_foreman_a'), 'aal1');
select is((select count(*)::int from public.worker_enrollments), 4, 'foreman A sees own company enrollments on A1');
select is((select count(*)::int from public.worker_enrollments where project_id = tests.id('p_b1')), 0, 'foreman A sees nothing on project B1');
select results_eq('select worker_id from public.attendance_sessions', array[tests.id('w_a1')], 'foreman A sees own crew sessions only');
select is((select count(*)::int from public.worker_profiles where id = tests.id('w_b1')), 0, 'foreman A cannot read company B worker');
select is((select count(*)::int from public.latest_onsite_positions), 0, 'foreman A: no locations without a GC grant');
select is((select count(*)::int from public.emergency_contacts), 0, 'foreman A: no emergency contacts without delegation');
select is((select count(*)::int from public.visitor_records), 0, 'foreman A cannot read visitor records');
select is((select count(*)::int from public.visitor_visits), 0, 'foreman A cannot read visitor visits');
select results_eq('select worker_id from public.muster_snapshot_members', array[tests.id('w_a1')], 'foreman A sees only own crew in the muster roster');
select is((select count(*)::int from public.daily_company_reports), 1, 'foreman A sees own company daily report only');
select is((select count(*)::int from public.kiosk_devices), 0, 'foreman A sees no kiosk devices');
select throws_ok(
  format($$update public.daily_company_reports set status = 'CONFIRMED' where project_id = %L$$, tests.id('p_a1')),
  '42501', null, 'foreman cannot confirm by direct table write (Edge Function only)');

-- GC grants locations and emergency contacts to foreman A for project A1.
select tests.as_postgres();
insert into public.foreman_project_grants (project_id, subcontractor_id, foreman_profile_id, can_view_locations, can_view_emergency_contacts, granted_by)
values (tests.id('p_a1'), tests.id('c_a'), tests.id('w_fa'), true, true, tests.id('u_a_super'));
select tests.authenticate_as(tests.id('u_foreman_a'), 'aal1');
select is((select count(*)::int from public.latest_onsite_positions), 2, 'granted foreman sees own crew locations');
select is((select count(*)::int from public.latest_onsite_positions where project_id = tests.id('p_b1')), 0, 'grant never extends to another project');
select results_eq('select worker_profile_id from public.emergency_contacts', array[tests.id('w_a1')], 'delegated foreman sees own crew emergency contacts');

-- Foreman B: company B on project B1 only; cannot see foreman A's crew.
select tests.authenticate_as(tests.id('u_foreman_b'), 'aal1');
select is((select count(*)::int from public.attendance_sessions where project_id = tests.id('p_a1')), 0, 'foreman B cannot read foreman A crew');
select results_eq('select worker_id from public.attendance_sessions', array[tests.id('w_b1')], 'foreman B sees own crew only');

-- A foreman whose membership is revoked loses crew access.
select tests.as_postgres();
update public.subcontractor_members set verification_status = 'REVOKED'
 where worker_profile_id = tests.id('w_fa') and role = 'FOREMAN';
select tests.authenticate_as(tests.id('u_foreman_a'), 'aal1');
select results_eq('select worker_id from public.attendance_sessions', array[]::uuid[], 'revoked foreman sees no crew sessions');

-- Worker A1: own records only.
select tests.authenticate_as(tests.id('u_worker_a1'), 'aal1');
select results_eq('select id from public.worker_enrollments', array[tests.id('e_a1')], 'worker sees own enrollment');
select results_eq('select id from public.attendance_sessions', array[tests.id('s_a1')], 'worker sees own session');
select results_eq('select worker_id from public.latest_onsite_positions', array[tests.id('w_a1')], 'worker sees only own latest position');
select results_eq('select worker_profile_id from public.emergency_contacts', array[tests.id('w_a1')], 'worker sees own emergency contact');
select is((select count(*)::int from public.visitor_records), 0, 'worker cannot read visitors');
select results_eq('select worker_id from public.muster_snapshot_members', array[tests.id('w_a1')], 'worker sees only own muster row');
select is((select count(*)::int from public.daily_company_reports), 0, 'worker cannot read company reports');
select results_eq('select id from public.projects', array[tests.id('p_a1')], 'worker sees the project they are enrolled in');
select throws_ok('select phone from public.worker_profiles', '42501', null, 'phone column is not readable through the table');

-- Worker cannot promote themselves, approve enrollment or alter attendance/muster state.
select throws_ok(
  format($$insert into public.project_staff (project_id, user_id, role) values (%L, %L, 'SUPER')$$, tests.id('p_a1'), tests.id('u_worker_a1')),
  '42501', null, 'worker cannot grant themselves a staff role');
select throws_ok(
  format($$update public.worker_enrollments set enrollment_status = 'APPROVED' where id = %L$$, tests.id('e_a1')),
  '42501', null, 'worker cannot approve their own enrollment');
select throws_ok(
  format($$update public.worker_enrollments set employer_status = 'VERIFIED' where id = %L$$, tests.id('e_a1')),
  '42501', null, 'worker cannot certify their own company affiliation');
select throws_ok(
  format($$insert into public.attendance_events (event_uuid, worker_id, project_id, config_version_id, source, direction, observed_at, verification_status, confidence, reason, actor_id) values (gen_random_uuid(), %L, %L, %L, 'MANUAL', 'ENTRY', now(), 'WITNESSED', 'HIGH', 'self', %L)$$,
         tests.id('w_a1'), tests.id('p_a1'), tests.id('cv_a1'), tests.id('u_worker_a1')),
  '42501', null, 'worker cannot write authoritative attendance');
select throws_ok(
  format($$update public.muster_snapshot_members set canonical_status = 'VERIFIED_ACCOUNTED' where id = %L$$, tests.id('mm_a1')),
  '42501', null, 'worker cannot mark themselves physically verified');

select tests.as_postgres();
select * from finish();
rollback;
