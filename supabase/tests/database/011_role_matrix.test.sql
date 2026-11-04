-- Role matrix (docs/spec/02-roles-permissions.md) for GC staff: PM, SUPER, SAFETY, ATTENDANT,
-- org ADMIN without assignment, org OWNER, MFA enforcement and anonymous access.
begin;
select plan(30);
select tests.seed_world();

-- PM (assigned): roster + locations, no emergency contacts by default.
select tests.authenticate_as(tests.id('u_a_pm'));
select is((select count(*)::int from public.worker_enrollments), 4, 'PM reads the project roster');
select is((select count(*)::int from public.latest_onsite_positions), 2, 'PM reads latest onsite locations');
select is((select count(*)::int from public.emergency_contacts), 0, 'PM: emergency contacts denied by default');
select is((select count(*)::int from public.visitor_records), 1, 'PM reads visitors of the assigned project');

-- SUPER (assigned, not designated): same as PM.
select tests.authenticate_as(tests.id('u_a_super'));
select is((select count(*)::int from public.attendance_sessions), 1, 'SUPER reads project sessions');
select is((select count(*)::int from public.latest_onsite_positions), 2, 'SUPER reads latest onsite locations');
select is((select count(*)::int from public.emergency_contacts), 0, 'SUPER without emergency designation: no contacts');

-- SAFETY (assigned): emergency contacts of APPROVED workers only.
select tests.authenticate_as(tests.id('u_a_safety'));
select results_eq('select worker_profile_id from public.emergency_contacts', array[tests.id('w_a1')], 'SAFETY reads emergency contacts of approved workers');
select is((select count(*)::int from public.latest_onsite_positions), 2, 'SAFETY reads latest locations');
select is((select count(*)::int from public.muster_snapshot_members), 2, 'SAFETY reads the muster roster incl. visitors');

-- ATTENDANT: roster/kiosk/visitors, never locations or emergency contacts.
select tests.authenticate_as(tests.id('u_a_attendant'));
select is((select count(*)::int from public.worker_enrollments), 4, 'ATTENDANT reads the roster to confirm identity');
select is((select count(*)::int from public.kiosk_devices), 1, 'ATTENDANT reads the project kiosk');
select is((select count(*)::int from public.latest_onsite_positions), 0, 'ATTENDANT cannot read locations');
select is((select count(*)::int from public.emergency_contacts), 0, 'ATTENDANT cannot read emergency contacts');

-- Org ADMIN without project assignment: org management only.
select tests.authenticate_as(tests.id('u_a_admin'));
select is((select count(*)::int from public.organizations), 1, 'ADMIN sees the organization');
select is((select count(*)::int from public.organization_members), 2, 'ADMIN manages organization membership');
select is((select count(*)::int from public.projects), 0, 'unassigned ADMIN sees no project (least privilege, #53)');
select is((select count(*)::int from public.latest_onsite_positions), 0, 'unassigned ADMIN sees no locations');

-- MFA is mandatory for staff: the same SUPER with aal1 sees nothing privileged.
select tests.authenticate_as(tests.id('u_a_super'), 'aal1');
select is((select count(*)::int from public.projects), 0, 'staff without MFA: no projects');
select is((select count(*)::int from public.worker_enrollments), 0, 'staff without MFA: no roster');
select is((select count(*)::int from public.latest_onsite_positions), 0, 'staff without MFA: no locations');
select tests.authenticate_as(tests.id('u_a_owner'), 'aal1');
select is((select count(*)::int from public.organizations), 0, 'owner without MFA: no organization access');

-- Emergency designation is explicit and per project.
select tests.as_postgres();
update public.project_staff set emergency_designated = true
 where project_id = tests.id('p_a1') and user_id = tests.id('u_a_super');
select tests.authenticate_as(tests.id('u_a_super'));
select results_eq('select worker_profile_id from public.emergency_contacts', array[tests.id('w_a1')], 'designated SUPER reads approved workers'' emergency contacts');

-- Revoking a staff assignment removes access immediately.
select tests.as_postgres();
update public.project_staff set status = 'REVOKED', revoked_at = now()
 where project_id = tests.id('p_a1') and user_id = tests.id('u_a_pm');
select tests.authenticate_as(tests.id('u_a_pm'));
select is((select count(*)::int from public.projects), 0, 'revoked PM loses project access at once');
select is((select count(*)::int from public.latest_onsite_positions), 0, 'revoked PM loses location access at once');

-- Revoked enrollment hides that worker's emergency contact from emergency staff.
select tests.as_postgres();
update public.worker_enrollments set enrollment_status = 'REVOKED', revoked_at = now() where id = tests.id('e_a1');
select tests.authenticate_as(tests.id('u_a_safety'));
select is((select count(*)::int from public.emergency_contacts), 0, 'emergency contact hidden after enrollment revocation');

-- Anonymous callers have no table privilege at all.
select tests.authenticate_as_anon();
select throws_ok('select 1 from public.projects', '42501', null, 'anon cannot read projects');
select throws_ok('select 1 from public.latest_onsite_positions', '42501', null, 'anon cannot read locations');
select throws_ok('select 1 from public.emergency_contacts', '42501', null, 'anon cannot read emergency contacts');
select throws_ok($$select public.create_organization('x', gen_random_uuid())$$, '42501', null, 'anon cannot call RPCs');

select tests.as_postgres();
select * from finish();
rollback;
