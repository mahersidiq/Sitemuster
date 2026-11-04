-- Milestone 08: operation permissions (kiosk, visitor desk, manual correction, foreman crew),
-- kiosk registration/revocation, the service-role helpers behind ingest-operations, and the
-- read functions for the fallback screens (docs/spec/02, 04, 11; decisions #98–#103).
begin;
select plan(63);
select tests.seed_world();
select set_config('t.p_a1', tests.id('p_a1')::text, true);
select set_config('t.p_b1', tests.id('p_b1')::text, true);
select set_config('t.c_a', tests.id('c_a')::text, true);
select set_config('t.c_b', tests.id('c_b')::text, true);
select set_config('t.k_a', tests.id('k_a')::text, true);
select set_config('t.s_a1', tests.id('s_a1')::text, true);
select set_config('t.u_a_owner', tests.id('u_a_owner')::text, true);
select set_config('t.u_a_pm', tests.id('u_a_pm')::text, true);
select set_config('t.u_a_super', tests.id('u_a_super')::text, true);
select set_config('t.u_a_safety', tests.id('u_a_safety')::text, true);
select set_config('t.u_a_attendant', tests.id('u_a_attendant')::text, true);
select set_config('t.u_b_super', tests.id('u_b_super')::text, true);
select set_config('t.u_foreman_a', tests.id('u_foreman_a')::text, true);
select set_config('t.u_foreman_b', tests.id('u_foreman_b')::text, true);
select set_config('t.u_worker_a1', tests.id('u_worker_a1')::text, true);
select set_config('t.u_operator', tests.id('u_operator')::text, true);
select set_config('t.w_a1', tests.id('w_a1')::text, true);
select set_config('t.w_a2', tests.id('w_a2')::text, true);
select set_config('t.w_b1', tests.id('w_b1')::text, true);
select set_config('t.w_fa', tests.id('w_fa')::text, true);
select set_config('t.w_managed', tests.id('w_managed')::text, true);

-- A second attendant on project A and a kiosk grant for foreman A (own crew only).
select tests.create_user('a7000000-0000-4000-8000-0000000000a7', 'attendant2.a@example.test');
insert into public.project_staff (project_id, user_id, role, emergency_designated)
values (current_setting('t.p_a1')::uuid, 'a7000000-0000-4000-8000-0000000000a7', 'ATTENDANT', false);
insert into public.foreman_project_grants (project_id, subcontractor_id, foreman_profile_id, can_operate_kiosk)
values (current_setting('t.p_a1')::uuid, current_setting('t.c_a')::uuid, current_setting('t.w_fa')::uuid, true);

-- ---------------------------------------------------------------------------------------------
-- operation_context: what the caller may do, derived from memberships (never from the request)
-- ---------------------------------------------------------------------------------------------
create function pg_temp.ctx(p_user text, p_project text, p_aal text default 'aal2') returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform tests.authenticate_as(current_setting(p_user)::uuid, p_aal);
  v := public.operation_context(current_setting(p_project)::uuid);
  perform tests.as_postgres();
  return v;
end $$;

select is(pg_temp.ctx('t.u_a_attendant', 't.p_a1') - 'user_id',
  jsonb_build_object('project_id', current_setting('t.p_a1'), 'project_status', 'ACTIVE', 'kiosk', 'ALL',
                     'visitors', true, 'correct', false, 'foreman_company_ids', '[]'::jsonb),
  'an assigned attendant with MFA runs the kiosk for everyone and the visitor desk, but cannot correct attendance');
select is(pg_temp.ctx('t.u_a_attendant', 't.p_a1', 'aal1') ->> 'kiosk', null,
  'without MFA the attendant gets no kiosk permission');
select is(pg_temp.ctx('t.u_a_super', 't.p_a1') -> 'correct', 'true'::jsonb, 'the assigned superintendent corrects attendance');
select is(pg_temp.ctx('t.u_a_super', 't.p_a1') ->> 'kiosk', null, 'a superintendent is not a kiosk attendant unless assigned as one');
select is(pg_temp.ctx('t.u_a_pm', 't.p_a1') -> 'correct', 'true'::jsonb, 'the assigned PM corrects attendance');
select is(pg_temp.ctx('t.u_a_owner', 't.p_a1') -> 'correct', 'true'::jsonb, 'the organization owner corrects attendance');
select is(pg_temp.ctx('t.u_a_safety', 't.p_a1') -> 'correct', 'false'::jsonb,
  'safety managers correct only if delegated, and V1 has no delegation');
select is(pg_temp.ctx('t.u_foreman_a', 't.p_a1', 'aal1') - 'user_id',
  jsonb_build_object('project_id', current_setting('t.p_a1'), 'project_status', 'ACTIVE', 'kiosk', 'OWN_CREW',
                     'visitors', false, 'correct', false,
                     'foreman_company_ids', jsonb_build_array(current_setting('t.c_a'))),
  'a foreman with a kiosk grant scans only their own crew, never visitors, and sees only their own company');
select is(pg_temp.ctx('t.u_foreman_b', 't.p_a1', 'aal1') - 'user_id',
  jsonb_build_object('project_id', current_setting('t.p_a1'), 'project_status', 'ACTIVE', 'kiosk', null,
                     'visitors', false, 'correct', false, 'foreman_company_ids', '[]'::jsonb),
  'a foreman of another company has no permission on project A');
select is(pg_temp.ctx('t.u_b_super', 't.p_a1') -> 'correct', 'false'::jsonb, 'GC B staff cannot correct project A attendance');
select is(pg_temp.ctx('t.u_b_super', 't.p_a1') ->> 'kiosk', null, 'GC B staff cannot run a project A kiosk');
select is(pg_temp.ctx('t.u_worker_a1', 't.p_a1', 'aal1') -> 'foreman_company_ids', '[]'::jsonb, 'a worker has no foreman company');
select is(pg_temp.ctx('t.u_operator', 't.p_a1') -> 'correct', 'false'::jsonb, 'the platform operator cannot correct attendance');
select is((select pg_temp.ctx('t.u_a_super', 't.p_a1') -> 'project_id') is not null and
          (pg_temp.ctx('t.u_a_super', 't.p_a1') ->> 'user_id') = current_setting('t.u_a_super'), true,
  'the actor comes from the JWT');
select set_config('t.unknown', '0f000000-0000-4000-8000-0000000000ff', true);
select is(pg_temp.ctx('t.u_a_super', 't.unknown') ->> 'project_id', null, 'an unknown project answers with every permission off');
select tests.authenticate_as_anon();
select throws_ok($$ select public.operation_context(current_setting('t.p_a1')::uuid) $$, '42501', null,
  'anonymous callers get nothing');
select tests.as_postgres();

-- ---------------------------------------------------------------------------------------------
-- Kiosk registration and revocation
-- ---------------------------------------------------------------------------------------------
select tests.authenticate_as(current_setting('t.u_a_attendant')::uuid);
select set_config('t.k_new', (public.register_kiosk(current_setting('t.p_a1')::uuid, 'kioskAlphaGate0001') ->> 'kiosk_device_id'), true);
select tests.as_postgres();
select is((select assigned_operator_user_id from public.kiosk_devices where id = current_setting('t.k_new')::uuid),
  current_setting('t.u_a_attendant')::uuid, 'an attendant registers this device as a project A kiosk, assigned to them');
select is((select count(*)::int from app_private.audit_logs where action = 'kiosk.registered' and resource_id = current_setting('t.k_new')::uuid),
  1, 'kiosk registration is audited');

select tests.authenticate_as('a7000000-0000-4000-8000-0000000000a7');
select is(public.register_kiosk(current_setting('t.p_a1')::uuid, 'kioskAlphaGate0001') ->> 'kiosk_device_id',
  current_setting('t.k_new'), 'the next attendant on shift takes over the same kiosk');
select tests.as_postgres();
select is((select assigned_operator_user_id from public.kiosk_devices where id = current_setting('t.k_new')::uuid),
  'a7000000-0000-4000-8000-0000000000a7'::uuid, 'the kiosk is now assigned to the attendant on shift');

select tests.authenticate_as(current_setting('t.u_a_super')::uuid);
select throws_ok($$ select public.register_kiosk(current_setting('t.p_a1')::uuid, 'kioskAlphaGate0002') $$, '42501', null,
  'a superintendent who is not an assigned attendant cannot register a kiosk');
select tests.authenticate_as(current_setting('t.u_a_attendant')::uuid, 'aal1');
select throws_ok($$ select public.register_kiosk(current_setting('t.p_a1')::uuid, 'kioskAlphaGate0002') $$, '42501', null,
  'an attendant without MFA cannot register a kiosk');
select tests.authenticate_as(current_setting('t.u_b_super')::uuid);
select throws_ok($$ select public.register_kiosk(current_setting('t.p_a1')::uuid, 'kioskAlphaGate0002') $$, '42501', null,
  'GC B staff cannot register a project A kiosk');
select tests.authenticate_as(current_setting('t.u_a_attendant')::uuid);
select throws_ok($$ select public.register_kiosk(current_setting('t.p_a1')::uuid, 'short') $$, '22023', 'INVALID_DEVICE_ID',
  'kiosk ids are validated');
select tests.as_postgres();
insert into public.project_staff (project_id, user_id, role, emergency_designated)
values (current_setting('t.p_b1')::uuid, current_setting('t.u_a_attendant')::uuid, 'ATTENDANT', false);
select tests.authenticate_as(current_setting('t.u_a_attendant')::uuid);
select throws_ok($$ select public.register_kiosk(current_setting('t.p_b1')::uuid, 'kioskAlphaGate0001') $$, '22023', 'KIOSK_OTHER_PROJECT',
  'a kiosk id bound to project A is never reused for another project');
select tests.authenticate_as(current_setting('t.u_foreman_a')::uuid, 'aal1');
select is(public.register_kiosk(current_setting('t.p_a1')::uuid, 'kioskForemanAcme01') ->> 'status', 'ACTIVE',
  'a foreman with a kiosk grant registers a crew kiosk');
select tests.authenticate_as('a7000000-0000-4000-8000-0000000000a7');
select throws_ok($$ select public.revoke_kiosk(current_setting('t.k_a')::uuid, 'lost tablet') $$, '42501', null,
  'an attendant cannot revoke a kiosk assigned to someone else');
select lives_ok($$ select public.revoke_kiosk(current_setting('t.k_new')::uuid, 'tablet retired') $$,
  'the attendant it is assigned to revokes it');
select throws_ok($$ select public.register_kiosk(current_setting('t.p_a1')::uuid, 'kioskAlphaGate0001') $$, '22023', 'KIOSK_REVOKED',
  'a revoked kiosk stays revoked');
select tests.authenticate_as(current_setting('t.u_a_super')::uuid);
select throws_ok($$ select public.revoke_kiosk(current_setting('t.k_a')::uuid, 'x') $$, '22023', 'REASON_REQUIRED',
  'revoking needs a reason');
select lives_ok($$ select public.revoke_kiosk(current_setting('t.k_a')::uuid, 'replaced by a new tablet') $$,
  'the superintendent who configures the project revokes any project kiosk');
select tests.as_postgres();
select is((select status::text from public.kiosk_devices where id = current_setting('t.k_a')::uuid), 'REVOKED', 'the kiosk is revoked');

-- ---------------------------------------------------------------------------------------------
-- Service-role helpers behind ingest-operations
-- ---------------------------------------------------------------------------------------------
select set_config('role', 'service_role', true);
select is(public.edge_kiosk_device(current_setting('t.k_a')::uuid), null, 'a revoked kiosk is not usable');
select is(public.edge_kiosk_device(current_setting('t.k_new')::uuid), null, 'neither is a retired one');
select is(
  public.edge_record_operation_receipts('0e000000-0000-4000-8000-000000000001', jsonb_build_array(
    jsonb_build_object('event_uuid', '0e000000-0000-4000-8000-0000000000e1', 'actor_id', current_setting('t.u_a_attendant'),
                       'project_id', current_setting('t.p_a1'), 'operation_type', 'KIOSK_ENTRY', 'status', 'accepted',
                       'reason', null, 'worker_id', current_setting('t.w_a1'), 'review', true,
                       'observed_at', '2026-11-04T12:00:00Z'))),
  1, 'a terminal result is recorded once');
select is(
  public.edge_record_operation_receipts('0e000000-0000-4000-8000-000000000002', jsonb_build_array(
    jsonb_build_object('event_uuid', '0e000000-0000-4000-8000-0000000000e1', 'actor_id', current_setting('t.u_a_attendant'),
                       'project_id', current_setting('t.p_a1'), 'operation_type', 'KIOSK_ENTRY', 'status', 'rejected',
                       'reason', 'LATER'))),
  0, 'a second write for the same operation changes nothing');
select is(public.edge_operation_receipts(array['0e000000-0000-4000-8000-0000000000e1'::uuid]) -> 0 ->> 'status', 'accepted',
  'the first terminal result is the one kept');
select is((public.edge_operation_receipts(array['0e000000-0000-4000-8000-0000000000e1'::uuid]) -> 0 -> 'review')::boolean, true,
  'the review flag is kept for the client');
select is(public.edge_printed_badge_worker(sha256(convert_to('SMP1.not-a-badge', 'UTF8'))), null, 'an unknown printed code matches nobody');
reset role;
insert into public.worker_badges (worker_id, badge_kind, opaque_badge_hash, issued_by)
values (current_setting('t.w_managed')::uuid, 'PRINTED', sha256(convert_to('SMP1.managed-badge-code', 'UTF8')), current_setting('t.u_a_super')::uuid);
select set_config('role', 'service_role', true);
select is(public.edge_printed_badge_worker(sha256(convert_to('SMP1.managed-badge-code', 'UTF8'))),
  jsonb_build_object('worker_id', current_setting('t.w_managed'), 'active', true), 'a printed badge resolves to its worker by hash only');
select is(
  (select jsonb_agg(x order by x ->> 'worker_id') from jsonb_array_elements(public.edge_operation_workers(
     current_setting('t.p_a1')::uuid, array[current_setting('t.w_a1')::uuid, current_setting('t.w_b1')::uuid])) x),
  (select jsonb_agg(x order by x ->> 'worker_id') from jsonb_array_elements(jsonb_build_array(
     jsonb_build_object('worker_id', current_setting('t.w_a1'), 'enrolled', true, 'approved', true, 'eligible', true, 'company_id', current_setting('t.c_a')),
     jsonb_build_object('worker_id', current_setting('t.w_b1'), 'enrolled', false, 'approved', false, 'eligible', false, 'company_id', null))) x),
  'enrollment facts are per project: a project B worker is not enrolled on project A');
select is(
  (select jsonb_object_agg(x ->> 'worker_id', (x -> 'eligible')::boolean) from jsonb_array_elements(public.edge_operation_workers(
     current_setting('t.p_a1')::uuid, array[current_setting('t.w_a1')::uuid, current_setting('t.w_a2')::uuid,
                                             current_setting('t.w_managed')::uuid, current_setting('t.w_fa')::uuid])) x),
  (select jsonb_object_agg(w, (public.edge_attendance_load(current_setting('t.p_a1')::uuid, w, '{}', '{}') -> 'eligibility' ->> 'eligible')::boolean)
     from unnest(array[current_setting('t.w_a1')::uuid, current_setting('t.w_a2')::uuid,
                       current_setting('t.w_managed')::uuid, current_setting('t.w_fa')::uuid]) w),
  'kiosk eligibility is the reconciler''s attendance rule (decision #56) for every seeded worker');
select is(public.edge_visitor_register(current_setting('t.p_a1')::uuid, '7e000000-0000-4000-8000-000000000001',
  'Ivy Inspector', 'City of Houston', current_setting('t.u_a_super')::uuid, 'Framing inspection', current_setting('t.u_a_attendant')::uuid),
  'ok', 'a new visitor is created with the id the kiosk chose');
select is(public.edge_visitor_register(current_setting('t.p_a1')::uuid, '7e000000-0000-4000-8000-000000000001',
  null, null, null, null, current_setting('t.u_a_attendant')::uuid),
  'ok', 'a returning visitor needs only the id');
select is(public.edge_visitor_register(current_setting('t.p_b1')::uuid, '7e000000-0000-4000-8000-000000000001',
  'Ivy Inspector', null, current_setting('t.u_b_super')::uuid, 'Inspection', current_setting('t.u_b_super')::uuid),
  'VISITOR_ID_CONFLICT', 'a visitor id from project A is never reused on project B');
select is(public.edge_visitor_register(current_setting('t.p_a1')::uuid, '7e000000-0000-4000-8000-000000000002',
  'Dan Delivery', null, current_setting('t.u_b_super')::uuid, 'Rebar delivery', current_setting('t.u_a_attendant')::uuid),
  'HOST_NOT_FOUND', 'the host must be active staff of this project');
select is(public.edge_visitor_register(current_setting('t.p_a1')::uuid, '7e000000-0000-4000-8000-000000000003',
  null, null, current_setting('t.u_a_super')::uuid, 'Delivery', current_setting('t.u_a_attendant')::uuid),
  'VISITOR_DETAILS_REQUIRED', 'a new visitor needs a name and a purpose');
reset role;
select is((select count(*)::int from public.visitor_records where project_id = current_setting('t.p_b1')::uuid), 0,
  'no visitor row was written on project B');

-- A visitor exit stores its operation id with the close; a second close is refused as stale
-- (review finding on PR #8: a resend after a lost answer must find the exit it already made).
select is(public.edge_visitor_commit(jsonb_build_object(
  'id', '7f000000-0000-4000-8000-000000000001', 'projectId', current_setting('t.p_a1'),
  'visitorKey', '7e000000-0000-4000-8000-000000000001', 'status', 'OPEN',
  'checkedInAt', '2026-11-04T14:00:00Z', 'checkedOutAt', null, 'closeoutAt', '2026-11-05T01:00:00Z',
  'idempotencyKey', '7f000000-0000-4000-8000-000000000001', 'exitIdempotencyKey', null),
  current_setting('t.u_a_attendant')::uuid, null), 'ok', 'a visitor sign-in opens a visit');
select is(public.edge_visitor_commit(jsonb_build_object(
  'id', '7f000000-0000-4000-8000-000000000001', 'projectId', current_setting('t.p_a1'),
  'visitorKey', '7e000000-0000-4000-8000-000000000001', 'status', 'CLOSED',
  'checkedInAt', '2026-11-04T14:00:00Z', 'checkedOutAt', '2026-11-04T15:00:00Z', 'closeoutAt', '2026-11-05T01:00:00Z',
  'idempotencyKey', '7f000000-0000-4000-8000-000000000001', 'exitIdempotencyKey', '7f000000-0000-4000-8000-0000000000e1'),
  current_setting('t.u_a_attendant')::uuid, null), 'ok', 'the sign-out closes it');
select is(public.edge_visitor_commit(jsonb_build_object(
  'id', '7f000000-0000-4000-8000-000000000001', 'projectId', current_setting('t.p_a1'),
  'visitorKey', '7e000000-0000-4000-8000-000000000001', 'status', 'CLOSED',
  'checkedInAt', '2026-11-04T14:00:00Z', 'checkedOutAt', '2026-11-04T16:00:00Z', 'closeoutAt', '2026-11-05T01:00:00Z',
  'idempotencyKey', '7f000000-0000-4000-8000-000000000001', 'exitIdempotencyKey', '7f000000-0000-4000-8000-0000000000e2'),
  current_setting('t.u_a_attendant')::uuid, null), 'stale', 'a second sign-out of a closed visit is refused as stale');
select is((select jsonb_build_object('out', x ->> 'checkedOutAt', 'exit', x ->> 'exitIdempotencyKey')
             from jsonb_array_elements(public.edge_visitor_load(current_setting('t.p_a1')::uuid)) x
            where x ->> 'id' = '7f000000-0000-4000-8000-000000000001'),
  jsonb_build_object('out', '2026-11-04T15:00:00+00:00', 'exit', '7f000000-0000-4000-8000-0000000000e1'),
  'the first sign-out time and its operation id are kept and read back for resends');

-- ---------------------------------------------------------------------------------------------
-- Read functions for the fallback screens
-- ---------------------------------------------------------------------------------------------
select tests.authenticate_as(current_setting('t.u_foreman_a')::uuid, 'aal1');
select is((select jsonb_agg(x ->> 'company_id') from jsonb_array_elements(public.my_foreman_projects()) x),
  jsonb_build_array(current_setting('t.c_a')), 'foreman A sees only company A on project A');
select is((select jsonb_agg(x ->> 'name' order by x ->> 'name') from jsonb_array_elements(
           public.foreman_crew(current_setting('t.p_a1')::uuid, current_setting('t.c_a')::uuid)) x),
  '["Ana Acosta", "Ben Avila", "Diego No-Phone", "Fernando Alvarez"]'::jsonb,
  'the crew list is the approved company A workers on project A (names only)');
select ok(not (public.foreman_crew(current_setting('t.p_a1')::uuid, current_setting('t.c_a')::uuid)::text ~ '(phone|emergency|lat|lng)'),
  'the crew list carries no phone numbers, emergency contacts or positions');
select throws_ok($$ select public.foreman_crew(current_setting('t.p_b1')::uuid, current_setting('t.c_b')::uuid) $$, '42501', null,
  'foreman A cannot read company B''s crew');
select throws_ok($$ select public.open_visitor_visits(current_setting('t.p_a1')::uuid) $$, '42501', null,
  'a foreman cannot read the visitor list');
select tests.authenticate_as(current_setting('t.u_worker_a1')::uuid, 'aal1');
select is(public.my_foreman_projects(), '[]'::jsonb, 'a worker who is not a foreman has no crews');
select tests.authenticate_as(current_setting('t.u_a_attendant')::uuid);
select lives_ok($$ select public.open_visitor_visits(current_setting('t.p_a1')::uuid) $$, 'the attendant reads open visits');
select throws_ok($$ select public.worker_attendance_sessions(current_setting('t.p_a1')::uuid, current_setting('t.w_a1')::uuid) $$, '42501', null,
  'an attendant cannot open the correction screen');
select tests.authenticate_as(current_setting('t.u_a_super')::uuid);
select is(public.worker_attendance_sessions(current_setting('t.p_a1')::uuid, current_setting('t.w_a1')::uuid) -> 0 ->> 'session_id',
  current_setting('t.s_a1'), 'the superintendent sees the worker''s recent sessions to correct');
select is((public.get_project_detail(current_setting('t.p_a1')::uuid) -> 'permissions') ->> 'can_correct_attendance', 'true',
  'project detail offers the correction screen to the superintendent');
select tests.authenticate_as(current_setting('t.u_b_super')::uuid);
select throws_ok($$ select public.worker_attendance_sessions(current_setting('t.p_a1')::uuid, current_setting('t.w_a1')::uuid) $$, '42501', null,
  'GC B staff cannot read project A sessions');
select tests.as_postgres();

select * from finish();
rollback;
