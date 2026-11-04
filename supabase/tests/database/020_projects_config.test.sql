-- Milestone 04: project creation, immutable config versions, lifecycle, overlap warnings,
-- invitations and address-lookup authorization/rate limits.
begin;
select plan(65);
select tests.seed_world();

-- Owner creates a project (v1 config, circle, windows), idempotently.
select tests.authenticate_as(tests.id('u_a_owner'));
select lives_ok(
  format($$select public.create_project(%L, 'Alpha Annex', 'A-200', '100 Main St', 29.7700, -95.3800, 'America/Chicago', 200, false,
           '[{"weekday":1,"local_start_time":"06:00","local_end_time":"18:00"},{"weekday":2,"local_start_time":"20:00","local_end_time":"04:00"}]',
           '11111111-aaaa-4aaa-8aaa-000000000001')$$, tests.id('org_a')),
  'owner creates a project');
select is(
  public.create_project(tests.id('org_a'), 'Alpha Annex (retry)', 'A-200', '100 Main St', 29.77, -95.38, 'America/Chicago', 200, false,
    '[{"weekday":1,"local_start_time":"06:00","local_end_time":"18:00"}]', '11111111-aaaa-4aaa-8aaa-000000000001'),
  (select id from public.projects where name = 'Alpha Annex'),
  'retry with the same key returns the same project (no duplicate)');
select tests.as_postgres();
create temp table annex as select id from public.projects where name = 'Alpha Annex';
grant select on annex to authenticated;
select is((select status::text from public.projects where id = (select id from annex)), 'DRAFT', 'new projects start as DRAFT');
select is((select count(*)::int from public.project_tracking_config_versions where project_id = (select id from annex)), 1, 'exactly one config version (v1)');
select is((select radius_m from public.project_geofences g join public.projects p on p.config_version_id = g.config_version_id where p.id = (select id from annex)), 200.00, 'v1 circle radius stored');
select is((select count(*)::int from public.project_work_windows w join public.projects p on p.config_version_id = w.config_version_id where p.id = (select id from annex)), 2, 'v1 work windows stored');
select ok((select crosses_midnight from public.project_work_windows w join public.projects p on p.config_version_id = w.config_version_id where p.id = (select id from annex) and w.weekday = 2), 'overnight window flagged crosses_midnight');
select is((select (settings_json ->> 'entry_dwell_seconds')::int from public.project_tracking_config_versions where project_id = (select id from annex)), 600, 'settings document holds the locked dwell default');
select is((select sha256 from public.project_tracking_config_versions where project_id = (select id from annex)),
          encode(sha256(convert_to((select settings_json::text from public.project_tracking_config_versions where project_id = (select id from annex)), 'UTF8')), 'hex'),
          'server digest covers the complete settings (incl. windows)');
select is((select count(*)::int from app_private.audit_logs where action = 'project.created' and project_id = (select id from annex)), 1, 'creation audited once');

-- Validation (server hard bounds; never silently invented).
select tests.authenticate_as(tests.id('u_a_owner'));
select throws_ok(format($$select public.create_project(%L, 'Tiny', null, null, 29.7, -95.3, 'America/Chicago', 149, false, '[{"weekday":1,"local_start_time":"06:00","local_end_time":"18:00"}]', gen_random_uuid())$$, tests.id('org_a')), '22023', 'RADIUS_OUT_OF_BOUNDS', 'radius below 150 m rejected');
select throws_ok(format($$select public.create_project(%L, 'Huge', null, null, 29.7, -95.3, 'America/Chicago', 2001, false, '[{"weekday":1,"local_start_time":"06:00","local_end_time":"18:00"}]', gen_random_uuid())$$, tests.id('org_a')), '22023', 'RADIUS_OUT_OF_BOUNDS', 'radius above 2000 m rejected');
select throws_ok(format($$select public.create_project(%L, 'Quick', null, null, 29.7, -95.3, 'America/Chicago', 150, false, '[{"weekday":1,"local_start_time":"06:00","local_end_time":"18:00"}]', gen_random_uuid(), 120)$$, tests.id('org_a')), '22023', 'DWELL_OUT_OF_BOUNDS', 'dwell below the 300 s floor rejected');
select throws_ok(format($$select public.create_project(%L, 'Overlap', null, null, 29.7, -95.3, 'America/Chicago', 150, false, '[{"weekday":1,"local_start_time":"06:00","local_end_time":"18:00"},{"weekday":1,"local_start_time":"17:00","local_end_time":"20:00"}]', gen_random_uuid())$$, tests.id('org_a')), '22023', 'OVERLAPPING_WORK_WINDOWS', 'overlapping windows rejected');
select throws_ok(format($$select public.create_project(%L, 'Overnight overlap', null, null, 29.7, -95.3, 'America/Chicago', 150, false, '[{"weekday":1,"local_start_time":"20:00","local_end_time":"04:00"},{"weekday":2,"local_start_time":"03:00","local_end_time":"10:00"}]', gen_random_uuid())$$, tests.id('org_a')), '22023', 'OVERLAPPING_WORK_WINDOWS', 'overlap across midnight rejected');
select throws_ok(format($$select public.create_project(%L, 'Sunday wrap', null, null, 29.7, -95.3, 'America/Chicago', 150, false, '[{"weekday":7,"local_start_time":"22:00","local_end_time":"06:00"},{"weekday":1,"local_start_time":"05:00","local_end_time":"09:00"}]', gen_random_uuid())$$, tests.id('org_a')), '22023', 'OVERLAPPING_WORK_WINDOWS', 'overlap across Sunday→Monday rejected');
select throws_ok(format($$select public.create_project(%L, 'No schedule', null, null, 29.7, -95.3, 'America/Chicago', 150, false, '[]', gen_random_uuid())$$, tests.id('org_a')), '22023', 'WORK_WINDOW_REQUIRED', 'non-24/7 project needs a window');
select lives_ok(format($$select public.create_project(%L, 'Always Open Plant', null, null, 29.6, -95.2, 'America/Chicago', 300, true, '[]', gen_random_uuid())$$, tests.id('org_a')), '24/7 project needs no windows');
select throws_ok(format($$select public.create_project(%L, 'Bad zone', null, null, 29.7, -95.3, 'Mars/Base', 150, false, '[{"weekday":1,"local_start_time":"06:00","local_end_time":"18:00"}]', gen_random_uuid())$$, tests.id('org_a')), '22023', 'INVALID_TIMEZONE', 'unknown IANA zone rejected');
select throws_ok(format($$select public.create_project(%L, '   ', null, null, 29.7, -95.3, 'America/Chicago', 150, false, '[{"weekday":1,"local_start_time":"06:00","local_end_time":"18:00"}]', gen_random_uuid())$$, tests.id('org_a')), '22023', 'NAME_REQUIRED', 'blank project name rejected');
select throws_ok(format($$select public.create_project(%L, 'Nowhere', null, null, 95.0, -95.3, 'America/Chicago', 150, false, '[{"weekday":1,"local_start_time":"06:00","local_end_time":"18:00"}]', gen_random_uuid())$$, tests.id('org_a')), '22023', 'INVALID_COORDINATES', 'impossible site coordinates rejected');
select throws_ok(format($$select public.create_project(%L, 'Bad time', null, null, 29.7, -95.3, 'America/Chicago', 150, false, '[{"weekday":1,"local_start_time":"25:00","local_end_time":"18:00"}]', gen_random_uuid())$$, tests.id('org_a')), '22023', 'INVALID_WORK_WINDOW_TIME', 'invalid clock time rejected');

-- Authorization for creation.
select tests.authenticate_as(tests.id('u_b_owner'));
select throws_ok(format($$select public.create_project(%L, 'Hijack', null, null, 29.7, -95.3, 'America/Chicago', 150, false, '[{"weekday":1,"local_start_time":"06:00","local_end_time":"18:00"}]', gen_random_uuid())$$, tests.id('org_a')), '42501', null, 'another GC cannot create projects in GC A');
select tests.authenticate_as(tests.id('u_a_owner'), 'aal1');
select throws_ok(format($$select public.create_project(%L, 'No MFA', null, null, 29.7, -95.3, 'America/Chicago', 150, false, '[{"weekday":1,"local_start_time":"06:00","local_end_time":"18:00"}]', gen_random_uuid())$$, tests.id('org_a')), '42501', null, 'MFA required to create projects');
select tests.authenticate_as(tests.id('u_a_super'));
select throws_ok(format($$select public.create_project(%L, 'Super made', null, null, 29.7, -95.3, 'America/Chicago', 150, false, '[{"weekday":1,"local_start_time":"06:00","local_end_time":"18:00"}]', gen_random_uuid())$$, tests.id('org_a')), '42501', null, 'project staff cannot create new projects for the organization');
select tests.authenticate_as(tests.id('u_a_admin'));
select lives_ok(format($$select public.create_project(%L, 'Admin Project', null, null, 30.1, -95.9, 'America/Chicago', 150, false, '[{"weekday":1,"local_start_time":"06:00","local_end_time":"18:00"}]', gen_random_uuid())$$, tests.id('org_a')), 'org admin can create a project');
select is((select count(*)::int from public.projects where name = 'Admin Project'), 1, 'the creating admin is assigned and can see it (decision #65)');

-- Configuration change = new version; open sessions keep their version (spec 06 example).
select tests.authenticate_as(tests.id('u_a_super'));
select throws_ok(format($$select public.update_project_config(%L, 29.7604, -95.3698, 250, false, '[{"weekday":1,"local_start_time":"06:00","local_end_time":"18:00"}]', 600, 75, 'Bigger site', false, gen_random_uuid())$$, tests.id('p_a1')),
  '22023', 'SENSITIVE_CHANGE_REQUIRES_CONFIRMATION: GEOFENCE_ENLARGED', 'enlarging the circle needs explicit confirmation');
select lives_ok(format($$select public.update_project_config(%L, 29.7604, -95.3698, 250, false, '[{"weekday":1,"local_start_time":"06:00","local_end_time":"18:00"}]', 600, 75, 'Bigger laydown yard', true, '22222222-bbbb-4bbb-8bbb-000000000001')$$, tests.id('p_a1')),
  'SUPER confirms and creates v2');
select is(
  public.update_project_config(tests.id('p_a1'), 29.7604, -95.3698, 250, false, '[{"weekday":1,"local_start_time":"06:00","local_end_time":"18:00"}]', 600, 75, 'Bigger laydown yard', true, '22222222-bbbb-4bbb-8bbb-000000000001'),
  (select id from public.project_tracking_config_versions where project_id = tests.id('p_a1') and version_number = 2),
  'config change is idempotent');
select throws_ok(format($$select public.update_project_config(%L, 29.7604, -95.3698, 250, true, '[]', 600, 75, 'Go 24/7', false, gen_random_uuid())$$, tests.id('p_a1')),
  '22023', 'SENSITIVE_CHANGE_REQUIRES_CONFIRMATION: OPERATES_24_7', 'switching to 24/7 needs confirmation');
select throws_ok(format($$select public.update_project_config(%L, 29.7604, -95.3698, 250, false, '[{"weekday":1,"local_start_time":"06:00","local_end_time":"18:00"}]', 300, 75, 'Faster arrivals', false, gen_random_uuid())$$, tests.id('p_a1')),
  '22023', 'SENSITIVE_CHANGE_REQUIRES_CONFIRMATION: DWELL_REDUCED', 'reducing dwell needs confirmation');
select throws_ok(format($$select public.update_project_config(%L, 29.7604, -95.3698, 200, false, '[{"weekday":1,"local_start_time":"06:00","local_end_time":"18:00"}]', 600, 75, '', false, gen_random_uuid())$$, tests.id('p_a1')),
  '22023', 'REASON_REQUIRED', 'every change needs a reason');
select throws_ok(format($$select public.update_project_config(%L, null, -95.3698, 200, false, '[{"weekday":1,"local_start_time":"06:00","local_end_time":"18:00"}]', 600, 75, 'move nowhere', true, gen_random_uuid())$$, tests.id('p_a1')), '22023', 'INVALID_COORDINATES', 'config update needs a valid centre');
select tests.as_postgres();
select is((select version_number from public.project_tracking_config_versions v join public.projects p on p.config_version_id = v.id where p.id = tests.id('p_a1')), 2, 'project now points at v2');
select is((select (settings_json ->> 'geofence_radius_m')::numeric from public.project_tracking_config_versions where id = tests.id('cv_a1')), 150::numeric, 'v1 settings untouched');
select is((select config_version_id from public.attendance_sessions where id = tests.id('s_a1')), tests.id('cv_a1'), 'the open session keeps v1 (no retroactive recalculation)');
select isnt(
  (select sdk_identifier from public.project_geofences where config_version_id = tests.id('cv_a1')),
  (select g.sdk_identifier from public.project_geofences g join public.projects p on p.config_version_id = g.config_version_id where p.id = tests.id('p_a1')),
  'v2 has its own native fence identifier; v1 stays resolvable for open-session exits');

-- Who may configure.
select tests.authenticate_as(tests.id('u_a_pm'));
select throws_ok(format($$select public.update_project_config(%L, 29.7604, -95.3698, 200, false, '[{"weekday":1,"local_start_time":"06:00","local_end_time":"18:00"}]', 600, 75, 'PM change', true, gen_random_uuid())$$, tests.id('p_a1')), '42501', null, 'PM without delegation cannot configure');
select tests.authenticate_as(tests.id('u_a_attendant'));
select throws_ok(format($$select public.set_project_status(%L, 'PAUSED', null)$$, tests.id('p_a1')), '42501', null, 'attendant cannot change lifecycle');
select tests.authenticate_as(tests.id('u_b_super'));
select throws_ok(format($$select public.update_project_config(%L, 29.7604, -95.3698, 200, false, '[{"weekday":1,"local_start_time":"06:00","local_end_time":"18:00"}]', 600, 75, 'cross tenant', true, gen_random_uuid())$$, tests.id('p_a1')), '42501', null, 'another GC cannot configure GC A projects');

-- Lifecycle.
select tests.authenticate_as(tests.id('u_a_owner'));
select is(public.set_project_status((select id from annex), 'ACTIVE', null)::text, 'ACTIVE', 'DRAFT → ACTIVE');
select throws_ok(format($$select public.set_project_status(%L, 'ARCHIVED', 'skip')$$, (select id from annex)), '22023', 'INVALID_STATUS_TRANSITION', 'ACTIVE cannot jump to ARCHIVED');
select throws_ok(format($$select public.set_project_status(%L, 'COMPLETED', null)$$, (select id from annex)), '22023', 'REASON_REQUIRED', 'completing needs a reason');
select is(public.set_project_status((select id from annex), 'COMPLETED', 'Turned over to owner')::text, 'COMPLETED', 'ACTIVE → COMPLETED');
select throws_ok(format($$select public.update_project_config(%L, 29.77, -95.38, 200, false, '[{"weekday":1,"local_start_time":"06:00","local_end_time":"18:00"}]', 600, 75, 'late change', true, gen_random_uuid())$$, (select id from annex)), '22023', 'PROJECT_CLOSED', 'completed projects cannot be reconfigured');

-- Overlap and similar-name warnings stay inside the caller's organization.
select ok(jsonb_array_length(public.check_project_site(tests.id('org_a'), 'Brand New', 29.7605, -95.3699, 150) -> 'overlaps') >= 1, 'overlapping circle in the same organization is reported');
select is(jsonb_array_length(public.check_project_site(tests.id('org_a'), 'Brand New', 40.7128, -74.0060, 150) -> 'overlaps'), 0, 'another GC''s site at the same spot is never revealed');
select ok(jsonb_array_length(public.check_project_site(tests.id('org_a'), 'Alpha Towers', 10, 10, 150) -> 'similar_names') >= 1, 'similar project names are reported');

-- Invitations: bound to a verified email, accepted with MFA, single use.
select lives_ok(format($$select public.invite_project_staff(%L, 'New.Safety@Example.test', 'SAFETY', true)$$, tests.id('p_a1')), 'owner invites a safety manager with emergency designation');
select tests.as_postgres();
select tests.create_user('99000000-0000-4000-8000-0000000000aa', 'new.safety@example.test');
select tests.authenticate_as('99000000-0000-4000-8000-0000000000aa');
select is((select count(*)::int from public.list_my_invitations()), 1, 'invitee sees the invitation for their verified email');
select lives_ok(format($$select public.accept_invitation(%L)$$, (select invitation_id from public.list_my_invitations())), 'invitee accepts with MFA');
select ok(app_private.has_emergency_role(tests.id('p_a1')), 'accepted role and emergency designation are active');
select tests.authenticate_as(tests.id('u_outsider'));
select throws_ok(format($$select public.accept_invitation(%L)$$, (select id from public.organization_invitations where target_email = 'new.safety@example.test')), 'P0002', null, 'someone else cannot accept it');

-- PM delegation can invite plain roles only.
select tests.as_postgres();
update public.project_staff set can_assign_staff = true where project_id = tests.id('p_a1') and user_id = tests.id('u_a_pm');
select tests.authenticate_as(tests.id('u_a_pm'));
select lives_ok(format($$select public.invite_project_staff(%L, 'gate@example.test', 'ATTENDANT')$$, tests.id('p_a1')), 'delegated PM invites an attendant');
select throws_ok(format($$select public.invite_project_staff(%L, 'boss@example.test', 'SUPER', false, true)$$, tests.id('p_a1')), '42501', 'DELEGATION_REQUIRES_ORG_ADMIN', 'PM cannot hand out configuration delegation');

-- Project list/detail reads stay inside the caller's projects; invitation e-mails only for staff managers.
select tests.authenticate_as(tests.id('u_a_owner'));
select ok((select bool_and((p ->> 'organization_id')::uuid = tests.id('org_a')) from jsonb_array_elements(public.list_my_projects()) p), 'owner list holds only own-organization projects');
select ok(jsonb_array_length(public.get_project_detail(tests.id('p_a1')) -> 'invitations') >= 1, 'staff manager sees pending invitations');
select tests.authenticate_as(tests.id('u_a_attendant'));
select is(jsonb_array_length(public.get_project_detail(tests.id('p_a1')) -> 'invitations'), 0, 'attendant does not see pending invitation e-mails');
select tests.authenticate_as(tests.id('u_b_owner'));
select is((select count(*)::int from jsonb_array_elements(public.list_my_projects()) p where (p ->> 'organization_id')::uuid = tests.id('org_a')), 0, 'GC B never lists GC A projects');
select throws_ok(format($$select public.get_project_detail(%L)$$, tests.id('p_a1')), '42501', 'FORBIDDEN', 'GC B cannot open GC A project detail');
select tests.authenticate_as(tests.id('u_worker_a1'));
select is(jsonb_array_length(public.list_my_projects()), 0, 'workers do not get the staff project list');
select throws_ok(format($$select public.get_project_detail(%L)$$, tests.id('p_a1')), '42501', 'FORBIDDEN', 'workers cannot open the staff project detail');

-- Address lookup authorization and rate limit.
select tests.authenticate_as(tests.id('u_a_owner'));
select is(public.address_lookup_allowed() ->> 'allowed', 'true', 'owner with MFA may search addresses');
select tests.authenticate_as(tests.id('u_worker_a1'), 'aal1');
select is(public.address_lookup_allowed() ->> 'reason', 'FORBIDDEN', 'workers may not use the paid address API');

select tests.as_postgres();
select * from finish();
rollback;
