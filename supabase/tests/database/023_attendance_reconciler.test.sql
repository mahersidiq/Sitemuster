-- Milestone 06: transactional attendance reconciler — service-role-only RPCs, optimistic revision,
-- idempotent event uuids, one open session, NO overlapping sessions, ownership tied to one project
-- and worker, coordinate-free state, the SQL sweep (time rules only), live counts and the schedule.
begin;
select plan(48);
select tests.seed_world();

select set_config('t.p', tests.id('p_a1')::text, false), set_config('t.cv', tests.id('cv_a1')::text, false),
       set_config('t.w1', tests.id('w_a1')::text, false), set_config('t.w2', tests.id('w_a2')::text, false),
       set_config('t.wm', tests.id('w_managed')::text, false), set_config('t.wf', tests.id('w_fa')::text, false),
       set_config('t.pb', tests.id('p_b1')::text, false), set_config('t.cvb', tests.id('cv_b1')::text, false),
       set_config('t.s1', tests.id('s_a1')::text, false), set_config('t.ev', tests.id('ev_a1')::text, false),
       set_config('t.foreman', tests.id('u_foreman_a')::text, false);

-- Changeset builders (camelCase like the TypeScript engine output).
create function pg_temp.session(p_id uuid, p_worker uuid, p_status text, p_start timestamptz,
                                p_end timestamptz default null, p_latest timestamptz default null,
                                p_config uuid default '2a000000-0000-4000-8000-0000000000a1')
returns jsonb language sql as $$
  select jsonb_build_object(
    'id', p_id, 'projectId', '1a000000-0000-4000-8000-0000000000a1', 'workerId', p_worker, 'status', p_status,
    'startAt', p_start, 'startSource', 'FOREMAN', 'startConfidence', 'HIGH', 'endAt', p_end,
    'endSource', case when p_end is null then null else 'FOREMAN' end,
    'endEarliestAt', case when p_latest is null then null else p_start end, 'endLatestAt', p_latest,
    'configVersionId', p_config, 'timezone', 'America/Chicago', 'lastSeenAt', p_start,
    'lastConfirmedInsideAt', p_start, 'closeoutAt', '2026-11-04T01:00:00Z', 'authorizeAt', null,
    'authorizedCloseoutAt', null, 'windowStartAt', null, 'windowEndAt', null, 'unscheduled', false,
    'unscheduledUntil', null, 'overtimeApprovedAt', null, 'overtimeApprovedBy', null, 'witnessed', true,
    'gaps', '[]'::jsonb, 'reviewReasons', '[]'::jsonb, 'unresolvedAt', null, 'openedByEvent', p_id,
    'employerSnapshotId', null)
$$;
create function pg_temp.changeset(p_worker uuid, p_expected int, p_presence text, p_current uuid,
                                  p_sessions jsonb, p_events jsonb default '[]', p_position jsonb default null,
                                  p_previous uuid default null)
returns jsonb language sql as $$
  select jsonb_build_object(
    'projectId', '1a000000-0000-4000-8000-0000000000a1', 'workerId', p_worker, 'expectedRevision', p_expected,
    'state', jsonb_build_object(
      'projectId', '1a000000-0000-4000-8000-0000000000a1', 'workerId', p_worker, 'revision', p_expected,
      'presence', p_presence, 'presenceChangedAt', '2026-11-03T12:00:00Z', 'confidence', 'HIGH',
      'monitoring', 'ACTIVE', 'candidate', null, 'lastSeenAt', '2026-11-03T12:00:00Z',
      'lastConfirmedInsideAt', '2026-11-03T12:00:00Z', 'arrivalConfirmedAt', null,
      'evaluatedAt', '2026-11-03T12:00:00Z', 'presenceCloseoutAt', null, 'requireEnterAfter', null,
      'continuityBreakAt', null, 'flags', '[]'::jsonb, 'configVersionId', '2a000000-0000-4000-8000-0000000000a1',
      'current', case when p_current is null then null else jsonb_build_object('id', p_current) end,
      'previous', case when p_previous is null then null else jsonb_build_object('id', p_previous) end),
    'sessions', p_sessions, 'events', p_events, 'receipts', '[]'::jsonb, 'corrections', '[]'::jsonb,
    'position', p_position)
$$;
create function pg_temp.event(p_uuid uuid, p_worker uuid, p_session uuid, p_direction text, p_at timestamptz)
returns jsonb language sql as $$
  select jsonb_build_object(
    'event_uuid', p_uuid, 'worker_id', p_worker, 'project_id', '1a000000-0000-4000-8000-0000000000a1',
    'session_id', p_session, 'actor_id', 'f1000000-0000-4000-8000-000000000001', 'kiosk_device_id', null,
    'device_id', null, 'config_version_id', '2a000000-0000-4000-8000-0000000000a1', 'source', 'FOREMAN',
    'direction', p_direction, 'observed_at', p_at, 'received_at', p_at, 'verification_status', 'WITNESSED',
    'confidence', 'HIGH', 'reason', null)
$$;

select ok('ENDED_UNVERIFIED' = any(enum_range(null::public.session_status)::text[]), 'session status ENDED_UNVERIFIED exists');

-- Only Edge Functions (service role) can load or commit attendance.
select tests.authenticate_as(tests.id('u_a_super'));
select throws_ok(format($$select public.edge_attendance_load(%L, %L, '{}', '{}')$$, tests.id('p_a1'), tests.id('w_a1')),
  '42501', null, 'staff apps cannot read the reconciler state directly');
select tests.authenticate_as(tests.id('u_worker_a1'), 'aal1');
select throws_ok($$select public.edge_attendance_commit('{}'::jsonb)$$, '42501', null, 'worker apps cannot commit attendance');
select throws_ok($$select public.edge_attendance_sweep(now())$$, '42501', null, 'apps cannot run the sweep');
select tests.as_postgres();

-- Load. (Seed rows predate Milestone 06: link the open session to its track like the reconciler does.)
update public.presence_states set current_session_id = tests.id('s_a1') where project_id = tests.id('p_a1') and worker_id = tests.id('w_a1');
select set_config('t.load_w1', public.edge_attendance_load(tests.id('p_a1'), tests.id('w_a1'),
  array[tests.id('ev_a1'), '99999999-0000-4000-8000-000000000001'::uuid], '{}')::text, false);
select set_config('t.load_w2', public.edge_attendance_load(tests.id('p_a1'), tests.id('w_a2'), '{}', '{}')::text, false);
select is((current_setting('t.load_w1')::jsonb -> 'eligibility' ->> 'eligible')::boolean, true,
  'an approved, employer-verified, consented worker is eligible');
select is(current_setting('t.load_w2')::jsonb -> 'eligibility' ->> 'reason', 'CONSENT_MISSING',
  'eligibility explains a missing acknowledgement');
select is(current_setting('t.load_w1')::jsonb -> 'duplicates', jsonb_build_array(tests.id('ev_a1')),
  'event uuids already recorded are reported as duplicates');
select is(current_setting('t.load_w1')::jsonb #>> '{track,current,id}', tests.id('s_a1')::text,
  'the track includes its open session');
select ok((current_setting('t.load_w1')::jsonb #>> '{configs,0,center,lat}')::numeric between 29 and 30,
  'each configuration version comes with its site circle');
select is(current_setting('t.load_w2')::jsonb -> 'track', 'null'::jsonb, 'a worker without history has no track yet');

-- Commit: first write, stale revision, duplicate uuid.
select set_config('t.cs1', pg_temp.changeset(tests.id('w_a2'), 0, 'ONSITE_ESTIMATED', 'aaaa0000-0000-4000-8000-000000000001',
  jsonb_build_array(pg_temp.session('aaaa0000-0000-4000-8000-000000000001', tests.id('w_a2'), 'OPEN', '2026-11-03T12:00:00Z')),
  jsonb_build_array(pg_temp.event('bbbb0000-0000-4000-8000-000000000001', tests.id('w_a2'), 'aaaa0000-0000-4000-8000-000000000001', 'ENTRY', '2026-11-03T12:00:00Z')),
  '{"op":"set","lat":29.7604,"lng":-95.3698,"accuracyM":10,"observedAt":"2026-11-03T12:00:00Z","expiryAt":"2026-11-03T12:20:00Z"}'::jsonb)::text, false);
select set_config('role', 'service_role', true);
select is(public.edge_attendance_commit(current_setting('t.cs1')::jsonb), 'ok', 'a first commit for a track succeeds');
select is(public.edge_attendance_commit(current_setting('t.cs1')::jsonb), 'conflict', 'a commit based on a stale revision is refused');
reset role;
select tests.as_postgres();
select is((select revision from public.presence_states where project_id = tests.id('p_a1') and worker_id = tests.id('w_a2')), 1::bigint,
  'the track revision advanced once');
select is((select status::text from public.attendance_sessions where id = 'aaaa0000-0000-4000-8000-000000000001'), 'OPEN', 'the session was created');
select is((select count(*)::int from public.latest_onsite_positions where project_id = tests.id('p_a1') and worker_id = tests.id('w_a2')), 1,
  'the latest map position was stored with the commit');

select set_config('t.cs_dup', pg_temp.changeset(tests.id('w_a2'), 1, 'ONSITE_ESTIMATED', 'aaaa0000-0000-4000-8000-000000000001', '[]',
  jsonb_build_array(pg_temp.event('bbbb0000-0000-4000-8000-000000000001', tests.id('w_a2'), 'aaaa0000-0000-4000-8000-000000000001', 'VERIFY', '2026-11-03T12:30:00Z')))::text, false);
select set_config('t.cs_coords', jsonb_set(pg_temp.changeset(tests.id('w_a2'), 1, 'ONSITE_ESTIMATED', null, '[]'),
  '{state,lastPosition}', '{"lat":29.7,"lng":-95.3}'::jsonb)::text, false);
select set_config('t.cs_other', pg_temp.changeset(tests.id('w_a2'), 1, 'ONSITE_ESTIMATED', null,
  jsonb_build_array(pg_temp.session('aaaa0000-0000-4000-8000-0000000000ff', tests.id('w_a1'), 'OPEN', '2026-11-03T13:00:00Z')))::text, false);
select set_config('t.cs_second_open', pg_temp.changeset(tests.id('w_a2'), 1, 'ONSITE_ESTIMATED', 'aaaa0000-0000-4000-8000-000000000002',
  jsonb_build_array(pg_temp.session('aaaa0000-0000-4000-8000-000000000002', tests.id('w_a2'), 'OPEN', '2026-11-03T13:00:00Z')))::text, false);
select set_config('t.cs_overlap', pg_temp.changeset(tests.id('w_a2'), 1, 'ONSITE_ESTIMATED', 'aaaa0000-0000-4000-8000-000000000003',
  jsonb_build_array(
    pg_temp.session('aaaa0000-0000-4000-8000-000000000001', tests.id('w_a2'), 'CLOSED', '2026-11-03T12:00:00Z', '2026-11-03T16:00:00Z'),
    pg_temp.session('aaaa0000-0000-4000-8000-000000000003', tests.id('w_a2'), 'OPEN', '2026-11-03T15:00:00Z')))::text, false);
select set_config('t.cs_bounded', pg_temp.changeset(tests.id('w_a2'), 1, 'ONSITE_ESTIMATED', 'aaaa0000-0000-4000-8000-000000000004',
  jsonb_build_array(
    pg_temp.session('aaaa0000-0000-4000-8000-000000000001', tests.id('w_a2'), 'ENDED_UNVERIFIED', '2026-11-03T12:00:00Z', null, '2026-11-03T14:00:00Z'),
    pg_temp.session('aaaa0000-0000-4000-8000-000000000004', tests.id('w_a2'), 'OPEN', '2026-11-03T14:00:00Z')),
  '[]', '{"op":"clear"}'::jsonb, 'aaaa0000-0000-4000-8000-000000000001')::text, false);
select set_config('role', 'service_role', true);
select is(public.edge_attendance_commit(current_setting('t.cs_dup')::jsonb), 'conflict', 'an event uuid recorded earlier is never applied twice');
select throws_ok(format($$select public.edge_attendance_commit(%L::jsonb)$$, current_setting('t.cs_coords')),
  '22023', 'COORDINATES_NOT_PERMITTED', 'persisted attendance state must be coordinate-free');
select throws_ok(format($$select public.edge_attendance_commit(%L::jsonb)$$, current_setting('t.cs_other')),
  '22023', 'INVALID_CHANGESET', 'a track can only write its own worker''s sessions');
select is(public.edge_attendance_commit(current_setting('t.cs_second_open')::jsonb), 'conflict',
  'a second open session for the same worker and project is refused');
select throws_ok(format($$select public.edge_attendance_commit(%L::jsonb)$$, current_setting('t.cs_overlap')),
  '23P01', 'OVERLAPPING_SESSION', 'overlapping sessions are refused (time is never counted twice)');
select is(public.edge_attendance_commit(current_setting('t.cs_bounded')::jsonb), 'ok',
  'an unresolved session bounded before the next one opens is accepted');
reset role;
select tests.as_postgres();
select is((select array_agg(status::text order by start_at) from public.attendance_sessions where worker_id = tests.id('w_a2')),
  array['ENDED_UNVERIFIED', 'OPEN'], 'the earlier session ended unverified and the new one is open');
select is((select count(*)::int from public.latest_onsite_positions where project_id = tests.id('p_a1') and worker_id = tests.id('w_a2')), 0,
  'clearing removes the map position');

-- Database invariants independent of the reconciler.
select throws_ok(format($$update public.attendance_sessions set status = 'CLOSED' where id = %L$$, 'aaaa0000-0000-4000-8000-000000000004'),
  '23514', null, 'a CLOSED session needs an end time');
select throws_ok(format($$update public.attendance_sessions set status = 'ENDED_UNVERIFIED' where id = %L$$, 'aaaa0000-0000-4000-8000-000000000004'),
  '23514', null, 'an ENDED_UNVERIFIED session needs a latest end bound');
select throws_ok(format($$insert into public.attendance_sessions (project_id, worker_id, start_at, start_source, config_version_id, status, iana_timezone)
                          values (%L, %L, '2026-11-01T12:00:00Z', 'MANUAL', %L, 'VOID', 'America/Chicago')$$,
                        tests.id('p_a1'), tests.id('w_managed'), tests.id('cv_b1')),
  '23503', null, 'a session cannot use another project''s configuration version');
select throws_ok(format($$insert into public.attendance_events (event_uuid, worker_id, project_id, session_id, actor_id, config_version_id, source, direction, observed_at, verification_status, confidence)
                          values (gen_random_uuid(), %L, %L, %L, %L, %L, 'FOREMAN', 'ENTRY', now(), 'WITNESSED', 'HIGH')$$,
                        tests.id('w_a1'), tests.id('p_a1'), 'aaaa0000-0000-4000-8000-000000000004', tests.id('u_foreman_a'), tests.id('cv_a1')),
  '23503', null, 'an event cannot be attached to another worker''s session');
select throws_ok(format($$update public.attendance_sessions set worker_id = %L where id = %L$$, tests.id('w_a1'), 'aaaa0000-0000-4000-8000-000000000004'),
  '42501', 'attendance session identity is immutable', 'a session never changes owner');
select throws_ok(format($$delete from public.attendance_sessions where id = %L$$, 'aaaa0000-0000-4000-8000-000000000004'),
  '42501', null, 'sessions are never deleted outside the retention purge');

-- Sweep: time rules only.
update public.attendance_sessions set last_seen_at = '2026-11-03T14:00:00Z', last_confirmed_inside_at = '2026-11-03T14:00:00Z', witnessed = false
 where id = 'aaaa0000-0000-4000-8000-000000000004';
insert into public.attendance_sessions (id, project_id, worker_id, start_at, start_source, config_version_id, status, iana_timezone,
                                        last_seen_at, last_confirmed_inside_at, closeout_at, authorize_at, authorized_closeout_at, unscheduled, opened_by_event)
values ('aaaa0000-0000-4000-8000-000000000005', tests.id('p_a1'), tests.id('w_managed'), '2026-11-03T10:00:00Z', 'GEOFENCE', tests.id('cv_a1'),
        'PENDING_APPROVAL', 'America/Chicago', '2026-11-03T10:55:00Z', '2026-11-03T10:55:00Z', '2026-11-03T11:00:00Z',
        '2026-11-03T11:00:00Z', '2026-11-04T01:00:00Z', true, 'aaaa0000-0000-4000-8000-000000000005');
insert into public.presence_states (project_id, worker_id, presence_state, confidence, config_version_id, current_session_id)
values (tests.id('p_a1'), tests.id('w_managed'), 'UNSCHEDULED_PENDING', 'MEDIUM', tests.id('cv_a1'), 'aaaa0000-0000-4000-8000-000000000005');
insert into public.presence_states (project_id, worker_id, presence_state, confidence, config_version_id, candidate_started_at,
                                    first_inside_at, candidate_last_evidence_at, candidate_config_version_id, candidate_closeout_at)
values (tests.id('p_a1'), tests.id('w_fa'), 'ARRIVING', 'LOW', tests.id('cv_a1'), '2026-11-03T12:00:00Z', '2026-11-03T12:00:00Z',
        '2026-11-03T12:05:00Z', tests.id('cv_a1'), '2026-11-04T01:00:00Z');
update public.visitor_visits set closeout_at = '2026-11-04T01:00:00Z' where id = tests.id('vv_a');

select is(app_private.attendance_sweep('2026-11-03T11:01:00Z') >= 1, true, 'the sweep reports the tracks it changed');
select is((select status::text || ' ' || unscheduled_until::text from public.attendance_sessions where id = 'aaaa0000-0000-4000-8000-000000000005'),
  'OPEN 2026-11-03 11:00:00+00', 'an unscheduled worker still on site when the window (minus grace) begins is authorized from that moment');
select is((select presence_state::text from public.presence_states where worker_id = tests.id('w_managed') and project_id = tests.id('p_a1')),
  'ONSITE_ESTIMATED', 'the authorized worker is counted');
select lives_ok($$select app_private.attendance_sweep('2026-11-03T14:30:00Z')$$, 'the sweep runs again later');
select is((select presence_state::text from public.presence_states where worker_id = tests.id('w_a2') and project_id = tests.id('p_a1')),
  'PRESENCE_UNKNOWN', 'after 20 minutes without evidence the worker is unknown, not departed');
select is((select status::text from public.attendance_sessions where id = 'aaaa0000-0000-4000-8000-000000000004'), 'OPEN',
  'a stale session stays open before close-out');
select is((select presence_state::text || ' ' || presence_closeout_at::text from public.presence_states
            where worker_id = tests.id('w_fa') and project_id = tests.id('p_a1')),
  'PRESENCE_UNKNOWN 2026-11-04 01:00:00+00', 'an unconfirmed arrival lapses to unknown until that shift''s close-out');
select is((select count(*)::int from public.latest_onsite_positions where project_id = tests.id('p_a1')), 0,
  'expired map positions are deleted');
select lives_ok($$select app_private.attendance_sweep('2026-11-04T01:30:00Z')$$, 'the close-out sweep runs');
select is((select status::text || ' ' || unresolved_at::text || ' ' || end_earliest_at::text from public.attendance_sessions
            where id = 'aaaa0000-0000-4000-8000-000000000004'),
  'UNRESOLVED 2026-11-04 01:00:00+00 2026-11-03 14:00:00+00',
  'at close-out a stale session becomes UNRESOLVED with the last confirmed inside time, never an invented exit');
select is((select presence_state::text from public.presence_states where worker_id = tests.id('w_fa') and project_id = tests.id('p_a1')),
  'OFFSITE', 'a never-counted unknown arrival resets after close-out');
select is((select status::text from public.visitor_visits where id = tests.id('vv_a')), 'UNRESOLVED',
  'an unclosed visitor visit becomes UNRESOLVED at close-out');

-- Live counts for project staff: one witnessed open session (counted, verified) and one GPS
-- session whose evidence went stale an hour ago (unknown, not counted).
insert into public.attendance_sessions (id, project_id, worker_id, start_at, start_source, config_version_id, status, iana_timezone,
                                        last_seen_at, closeout_at, witnessed, opened_by_event)
values ('aaaa0000-0000-4000-8000-000000000006', tests.id('p_a1'), tests.id('w_fa'), now() - interval '2 hours', 'KIOSK_DYNAMIC_BADGE',
        tests.id('cv_a1'), 'OPEN', 'America/Chicago', now() - interval '2 hours', now() + interval '6 hours', true,
        'aaaa0000-0000-4000-8000-000000000006');
update public.presence_states set presence_state = 'ONSITE_ESTIMATED', current_session_id = 'aaaa0000-0000-4000-8000-000000000006'
 where project_id = tests.id('p_a1') and worker_id = tests.id('w_fa');
update public.attendance_sessions set last_seen_at = now() - interval '1 hour' where id = tests.id('s_a1');
select tests.authenticate_as(tests.id('u_a_super'));
select set_config('t.counts', public.attendance_counts(tests.id('p_a1'))::text, false);
select is((current_setting('t.counts')::jsonb ->> 'estimated_onsite')::int, 1, 'staff see the estimated on-site count');
select is((current_setting('t.counts')::jsonb ->> 'manually_verified')::int, 1, 'witnessed presence is counted as verified');
select is((current_setting('t.counts')::jsonb ->> 'presence_unknown')::int, 1, 'stale GPS presence is shown as unknown without waiting for the sweep');
select is((current_setting('t.counts')::jsonb ->> 'approved_roster')::int, 4, 'the approved roster is a separate number');
select tests.authenticate_as(tests.id('u_b_owner'));
select throws_ok(format($$select public.attendance_counts(%L)$$, tests.id('p_a1')), '42501', 'FORBIDDEN', 'another GC cannot read the counts');
select tests.authenticate_as(tests.id('u_worker_a1'), 'aal1');
select throws_ok(format($$select public.attendance_counts(%L)$$, tests.id('p_a1')), '42501', 'FORBIDDEN', 'workers cannot read project counts');
select tests.as_postgres();

-- Schedule.
select is((select schedule from cron.job where jobname = 'sitemuster-attendance-sweep'), '* * * * *', 'the sweep is scheduled every minute');

select * from finish();
rollback;
