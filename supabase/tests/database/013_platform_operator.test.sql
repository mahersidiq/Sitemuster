-- Platform operator (decision #32): MFA operator account still receives NO tenant data, GPS,
-- emergency contacts or PII through any table, and cannot create tenants.
begin;
select plan(14);
select tests.seed_world();

select tests.authenticate_as(tests.id('u_operator'), 'aal2');
select is((select count(*)::int from public.latest_onsite_positions), 0, 'operator cannot read any coordinates');
select is((select count(*)::int from public.emergency_contacts), 0, 'operator cannot read emergency contacts');
select is((select count(*)::int from public.worker_profiles), 0, 'operator cannot read worker profiles');
select is((select count(*)::int from public.organizations), 0, 'operator cannot browse organizations through tables');
select is((select count(*)::int from public.projects), 0, 'operator cannot read projects');
select is((select count(*)::int from public.attendance_sessions), 0, 'operator cannot read attendance');
select is((select count(*)::int from public.muster_snapshot_members), 0, 'operator cannot read muster PII');
select is((select count(*)::int from public.visitor_records), 0, 'operator cannot read visitors');
select is((select count(*)::int from public.legal_notice_versions), 0, 'operator gets no tenant-scoped reads at all');
select throws_ok('select 1 from app_private.raw_onsite_fixes', '42501', null, 'operator cannot query raw fixes');
select throws_ok('select 1 from app_private.location_event_receipts', '42501', null, 'operator cannot query location receipts');
select throws_ok('select 1 from app_private.audit_logs', '42501', null, 'operator cannot read audit logs through the API role');
select throws_ok($$select public.create_organization('Operator Org', gen_random_uuid())$$, '42501', null, 'operator cannot create tenant organizations');

-- Even if an operator account were (wrongly) given a tenant role, RLS still denies it.
select tests.as_postgres();
insert into public.project_staff (project_id, user_id, role) values (tests.id('p_a1'), tests.id('u_operator'), 'SAFETY');
select tests.authenticate_as(tests.id('u_operator'), 'aal2');
select is((select count(*)::int from public.latest_onsite_positions), 0, 'operator with a stray staff row still cannot read coordinates');

select tests.as_postgres();
select * from finish();
rollback;
