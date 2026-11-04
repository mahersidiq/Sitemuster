-- Cross-tenant isolation: GC A and GC B can never read or write each other's data, even with
-- guessed IDs (spec 02 "Security tests required"; Milestone 02 acceptance).
begin;
select plan(26);
select tests.seed_world();

-- GC A owner (MFA): sees GC A only.
select tests.authenticate_as(tests.id('u_a_owner'));
select results_eq('select id from public.organizations', array[tests.id('org_a')], 'GC A owner sees only GC A organization');
select results_eq('select id from public.projects', array[tests.id('p_a1')], 'GC A owner sees only GC A projects');
select is_empty(format('select 1 from public.projects where id = %L', tests.id('p_b1')), 'guessed GC B project id returns nothing');
select is((select count(*)::int from public.attendance_sessions where project_id = tests.id('p_b1')), 0, 'no GC B sessions');
select is((select count(*)::int from public.attendance_events where project_id = tests.id('p_b1')), 0, 'no GC B attendance events');
select is((select count(*)::int from public.latest_onsite_positions where project_id = tests.id('p_b1')), 0, 'no GC B coordinates');
select is((select count(*)::int from public.worker_profiles where id = tests.id('w_b1')), 0, 'GC B worker profile hidden');
select is((select count(*)::int from public.emergency_contacts where worker_profile_id = tests.id('w_b1')), 0, 'GC B emergency contact hidden');
select is((select count(*)::int from public.visitor_records where project_id = tests.id('p_b1')), 0, 'no GC B visitors');
select is((select count(*)::int from public.daily_company_reports where project_id = tests.id('p_b1')), 0, 'no GC B reports');
select is((select count(*)::int from public.project_tracking_config_versions where project_id = tests.id('p_b1')), 0, 'no GC B configuration');
select is((select count(*)::int from public.subcontractor_companies where id = tests.id('c_b')), 0, 'GC B-only company hidden');
select is((select count(*)::int from public.latest_onsite_positions), 2, 'GC A owner sees GC A positions (owner authorized)');
select is((select count(*)::int from public.emergency_contacts), 0, 'org owner without emergency designation sees no emergency contacts');

-- Writes are denied at the privilege layer, even for an owner.
select throws_ok(
  format($$insert into public.projects (organization_id, name, iana_timezone, idempotency_key) values (%L, 'x', 'UTC', gen_random_uuid())$$, tests.id('org_a')),
  '42501', null, 'owner cannot insert projects directly (privileged functions only)');
select throws_ok(
  format($$update public.attendance_sessions set end_at = now() where id = %L$$, tests.id('s_a1')),
  '42501', null, 'owner cannot edit authoritative sessions');
select throws_ok('delete from public.attendance_events', '42501', null, 'owner cannot delete attendance events');
select throws_ok(
  format($$update public.project_staff set role = 'SAFETY' where project_id = %L$$, tests.id('p_b1')),
  '42501', null, 'owner cannot touch GC B staff roles');

-- GC B superintendent (MFA, emergency-designated on B1): sees GC B only.
select tests.authenticate_as(tests.id('u_b_super'));
select results_eq('select id from public.projects', array[tests.id('p_b1')], 'GC B super sees only GC B project');
select is((select count(*)::int from public.attendance_events where project_id = tests.id('p_a1')), 0, 'no GC A events for GC B');
select is((select count(*)::int from public.latest_onsite_positions where project_id = tests.id('p_a1')), 0, 'no GC A coordinates for GC B');
select results_eq('select worker_profile_id from public.emergency_contacts', array[tests.id('w_b1')], 'GC B designated super sees only GC B worker contact');
select is((select count(*)::int from public.muster_events), 0, 'GC A muster invisible to GC B');
select is((select count(*)::int from public.kiosk_devices), 0, 'GC A kiosk invisible to GC B');
select is((select count(*)::int from public.organization_members), 0, 'GC B super (not an org admin) sees no member lists');

-- A user with no role anywhere sees nothing tenant-scoped.
select tests.authenticate_as(tests.id('u_outsider'));
select is(
  (select count(*)::int from public.projects) + (select count(*)::int from public.organizations)
  + (select count(*)::int from public.worker_profiles) + (select count(*)::int from public.attendance_sessions),
  0, 'authenticated outsider sees no tenant data');

select tests.as_postgres();
select * from finish();
rollback;
