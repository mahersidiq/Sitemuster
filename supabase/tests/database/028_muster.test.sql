-- Milestone 11: Active Muster Mode (docs/spec/12).
-- Only the designated safety role starts and closes; concurrent starts collapse onto one ACTIVE
-- muster; the snapshot freezes the approved roster and open visitor visits; a self report never
-- becomes a physical verification; counters stay separated; close needs an acknowledgement when
-- people are unresolved and freezes an immutable report; late offline checks and corrections
-- are signed append-only amendments; push delivery is metadata only; GC B, the operator, workers
-- and foremen of other companies are refused.
begin;
select plan(74);
select tests.seed_world();

select set_config('t.p', tests.id('p_a1')::text, false), set_config('t.seed', tests.id('m_a')::text, false);

-- ---------------------------------------------------------------------------------------------
-- Who may start
-- ---------------------------------------------------------------------------------------------
select tests.authenticate_as(tests.id('u_a_super'));
select throws_ok($$select public.start_muster(current_setting('t.p')::uuid, 'Fire', gen_random_uuid())$$, '42501', 'FORBIDDEN',
  'a superintendent without the emergency designation cannot start a muster');
select tests.authenticate_as(tests.id('u_a_owner'));
select throws_ok($$select public.start_muster(current_setting('t.p')::uuid, 'Fire', gen_random_uuid())$$, '42501', 'FORBIDDEN',
  'the organization owner needs an explicit emergency designation too (decision #53)');
select tests.authenticate_as(tests.id('u_b_super'));
select throws_ok($$select public.start_muster(current_setting('t.p')::uuid, 'Fire', gen_random_uuid())$$, '42501', 'FORBIDDEN',
  'GC B''s designated person cannot start a muster on project A');
select tests.authenticate_as(tests.id('u_operator'));
select throws_ok($$select public.start_muster(current_setting('t.p')::uuid, 'Fire', gen_random_uuid())$$, '42501', 'FORBIDDEN',
  'the platform operator cannot start a muster');
select tests.authenticate_as(tests.id('u_foreman_a'), 'aal1');
select throws_ok($$select public.start_muster(current_setting('t.p')::uuid, 'Fire', gen_random_uuid())$$, '42501', 'FORBIDDEN',
  'a foreman cannot start a muster');
select tests.authenticate_as(tests.id('u_a_safety'), 'aal1');
select throws_ok($$select public.start_muster(current_setting('t.p')::uuid, 'Fire', gen_random_uuid())$$, '42501', 'FORBIDDEN',
  'the safety manager needs MFA');

-- The seeded drill is still active: a second tap joins it instead of creating another.
select tests.authenticate_as(tests.id('u_a_safety'));
select is(public.start_muster(current_setting('t.p')::uuid, 'Fire alarm', 'a0000000-0000-4000-8000-000000000101') - 'muster_id',
  '{"created": false, "duplicate": false, "already_active": true}'::jsonb, 'an active muster is reused, not duplicated');

-- ---------------------------------------------------------------------------------------------
-- Close the seeded drill: acknowledgement and note required; then immutable
-- ---------------------------------------------------------------------------------------------
select throws_ok($$select public.close_muster(current_setting('t.seed')::uuid, 'Drill done', false)$$, '22023',
  'ACKNOWLEDGE_INCOMPLETE_REQUIRED', 'closing with unresolved people needs an explicit acknowledgement');
select throws_ok($$select public.close_muster(current_setting('t.seed')::uuid, 'x', true)$$, '22023', 'REASON_REQUIRED',
  'closing needs a note');
select tests.authenticate_as(tests.id('u_a_super'));
select throws_ok($$select public.close_muster(current_setting('t.seed')::uuid, 'Drill done', true)$$, '42501', 'FORBIDDEN',
  'only the designated role closes');
select tests.authenticate_as(tests.id('u_a_safety'));
select set_config('t.close1', public.close_muster(current_setting('t.seed')::uuid, 'Drill complete, two not accounted', true)::text, false);
select is((select jsonb_build_object('status', status, 'ack', closeout_acknowledged_incomplete, 'digest', closeout_report_digest = current_setting('t.close1')::jsonb ->> 'digest')
             from public.muster_events where id = current_setting('t.seed')::uuid),
  '{"status": "CLOSED", "ack": true, "digest": true}'::jsonb, 'the drill is closed with its acknowledgement and report digest');
select is((select digest = encode(sha256(convert_to(report::text, 'UTF8')), 'hex') from public.muster_reports where muster_id = current_setting('t.seed')::uuid),
  true, 'the stored digest is the SHA-256 of the frozen report');
select is(public.close_muster(current_setting('t.seed')::uuid, 'again', true) ->> 'duplicate', 'true', 'closing twice is a duplicate');
select tests.as_postgres();
select throws_ok($$update public.muster_events set incident_label = 'changed' where id = current_setting('t.seed')::uuid$$,
  '42501', 'closed muster is immutable', 'a closed muster never changes');
select throws_ok($$update public.muster_reports set digest = repeat('0', 64) where muster_id = current_setting('t.seed')::uuid$$,
  null, null, 'the closing report never changes');
select throws_ok($$update public.muster_snapshot_members set canonical_status = 'VERIFIED_ACCOUNTED' where muster_id = current_setting('t.seed')::uuid$$,
  '42501', 'muster snapshot is immutable', 'a closed snapshot never changes');

-- ---------------------------------------------------------------------------------------------
-- A new muster: snapshot of the approved roster and open visits, idempotent
-- ---------------------------------------------------------------------------------------------
-- Ana's phone reported two minutes ago (counted on site); everyone else is roster only.
update public.attendance_sessions set last_seen_at = now() - interval '2 minutes' where id = tests.id('s_a1');
update public.presence_states set current_session_id = tests.id('s_a1'), last_seen_at = now() - interval '2 minutes'
 where project_id = tests.id('p_a1') and worker_id = tests.id('w_a1');
select tests.authenticate_as(tests.id('u_a_safety'));
select set_config('t.start', public.start_muster(current_setting('t.p')::uuid, 'Fire alarm', 'a0000000-0000-4000-8000-000000000102')::text, false);
select set_config('t.m', current_setting('t.start')::jsonb ->> 'muster_id', false);
select is((current_setting('t.start')::jsonb -> 'counts'),
  '{"workers": {"total": 4, "unknown": 0, "verified": 0, "unaccounted": 4, "self_reported": 0, "detected_at_start": 1},
    "visitors": {"total": 1, "verified": 0, "unaccounted": 1}}'::jsonb,
  'the snapshot holds the four approved workers (one detected on site) and the open visitor');
select is(public.start_muster(current_setting('t.p')::uuid, 'Fire alarm', 'a0000000-0000-4000-8000-000000000102') ->> 'duplicate',
  'true', 'the same request again is a duplicate (same muster)');
select is(public.start_muster(current_setting('t.p')::uuid, 'Smoke', 'a0000000-0000-4000-8000-000000000103') ->> 'muster_id',
  current_setting('t.m'), 'a second start while one is active joins it');
select is((select count(*)::int from public.muster_events where project_id = current_setting('t.p')::uuid and status = 'ACTIVE'), 1,
  'exactly one active muster for the project');
select ok((select roster_snapshot_hash ~ '^[0-9a-f]{64}$' from public.muster_events where id = current_setting('t.m')::uuid),
  'the snapshot digest is recorded');
select is((select jsonb_object_agg(coalesce(w.legal_name, v.name), m.source || ' ' || m.initial_status)
             from public.muster_snapshot_members m
             left join public.worker_profiles w on w.id = m.worker_id
             left join public.visitor_records v on v.id = m.visitor_id
            where m.muster_id = current_setting('t.m')::uuid),
  '{"Ana Acosta": "ONSITE_GEOFENCE UNACCOUNTED", "Ben Avila": "ROSTER_NOT_DETECTED UNACCOUNTED",
    "Diego No-Phone": "ROSTER_NOT_DETECTED UNACCOUNTED", "Fernando Alvarez": "ROSTER_NOT_DETECTED UNACCOUNTED",
    "Ivy Inspector": "VISITOR UNACCOUNTED"}'::jsonb,
  'each person carries the source the commander needs (detected on site, roster only, visitor)');
select ok((select bool_and(m.employer_id = tests.id('c_a')) from public.muster_snapshot_members m
            where m.muster_id = current_setting('t.m')::uuid and m.worker_id is not null),
  'workers carry their employer');

select set_config('t.ana', (select id::text from public.muster_snapshot_members where muster_id = current_setting('t.m')::uuid and worker_id = tests.id('w_a1')), false),
       set_config('t.ben', (select id::text from public.muster_snapshot_members where muster_id = current_setting('t.m')::uuid and worker_id = tests.id('w_a2')), false),
       set_config('t.diego', (select id::text from public.muster_snapshot_members where muster_id = current_setting('t.m')::uuid and worker_id = tests.id('w_managed')), false),
       set_config('t.ivy', (select id::text from public.muster_snapshot_members where muster_id = current_setting('t.m')::uuid and visitor_id = tests.id('v_a')), false);

-- ---------------------------------------------------------------------------------------------
-- Responses: 2 workers + 1 visitor, counters separated
-- ---------------------------------------------------------------------------------------------
select tests.as_postgres();
select is(public.edge_muster_respond(current_setting('t.m')::uuid, current_setting('t.ana')::uuid, 'SELF_REPORT', 'APP',
            tests.id('u_worker_a1'), null, now(), 'b0000000-0000-4000-8000-000000000001', null) ->> 'status',
  'SELF_REPORTED_SAFE', 'Ana taps I''M SAFE: self reported, not verified');
select is(public.edge_muster_respond(current_setting('t.m')::uuid, current_setting('t.ben')::uuid, 'PHYSICAL_VERIFICATION', 'FOREMAN',
            tests.id('u_foreman_a'), null, now(), 'b0000000-0000-4000-8000-000000000002', null) ->> 'status',
  'VERIFIED_ACCOUNTED', 'Ben is physically seen by his foreman: verified');
select is(public.edge_muster_respond(current_setting('t.m')::uuid, current_setting('t.ivy')::uuid, 'PHYSICAL_VERIFICATION', 'KIOSK',
            tests.id('u_a_attendant'), tests.id('k_a'), now(), 'b0000000-0000-4000-8000-000000000003', null) ->> 'status',
  'VERIFIED_ACCOUNTED', 'the visitor is checked at the attended kiosk');
select is(app_private.muster_counts(current_setting('t.m')::uuid),
  '{"workers": {"total": 4, "unknown": 0, "verified": 1, "unaccounted": 2, "self_reported": 1, "detected_at_start": 1},
    "visitors": {"total": 1, "verified": 1, "unaccounted": 0}}'::jsonb,
  'counters stay separated: one verified, one self reported, two unaccounted, the visitor apart');
select is(public.edge_muster_respond(current_setting('t.m')::uuid, current_setting('t.ana')::uuid, 'SELF_REPORT', 'APP',
            tests.id('u_worker_a1'), null, now(), 'b0000000-0000-4000-8000-000000000001', null) ->> 'result',
  'duplicate', 'the same offline operation synced twice is recorded once');
select is((select count(*)::int from public.muster_responses where event_uuid = 'b0000000-0000-4000-8000-000000000001'), 1,
  'exactly one response row for that event');
select throws_ok($$insert into public.muster_responses (muster_id, snapshot_member_id, action, responder_id, channel, observed_at,
                   resulting_status, event_uuid)
                   values (current_setting('t.m')::uuid, current_setting('t.ana')::uuid, 'SELF_REPORT', tests.id('u_worker_a1'), 'APP', now(),
                   'VERIFIED_ACCOUNTED', gen_random_uuid())$$,
  '23514', null, 'a self report can never be stored as a physical verification');
select throws_ok($$insert into public.muster_responses (muster_id, snapshot_member_id, action, responder_id, channel, observed_at,
                   resulting_status, event_uuid)
                   values (current_setting('t.m')::uuid, current_setting('t.ana')::uuid, 'PHYSICAL_VERIFICATION', tests.id('u_worker_a1'), 'APP', now(),
                   'VERIFIED_ACCOUNTED', gen_random_uuid())$$,
  '23514', null, 'a verification through the worker''s own app is refused (physical channels only)');
select is(public.edge_muster_respond(current_setting('t.m')::uuid, current_setting('t.ben')::uuid, 'SELF_REPORT', 'NOTIFICATION_ACTION',
            tests.id('u_worker_a2'), null, now(), 'b0000000-0000-4000-8000-000000000004', null) ->> 'status',
  'VERIFIED_ACCOUNTED', 'a later self report never lowers a physical verification');
select is(public.edge_muster_respond(current_setting('t.m')::uuid, current_setting('t.ana')::uuid, 'PHYSICAL_VERIFICATION', 'SAFETY_STAFF',
            tests.id('u_a_safety'), null, now(), 'b0000000-0000-4000-8000-000000000005', null) ->> 'status',
  'VERIFIED_ACCOUNTED', 'the safety manager physically sees Ana: verified supersedes self report');
select is(public.edge_muster_respond(current_setting('t.m')::uuid, current_setting('t.ben')::uuid, 'PHYSICAL_VERIFICATION', 'FOREMAN',
            tests.id('u_foreman_a'), null, now(), 'b0000000-0000-4000-8000-000000000006', null) ->> 'status',
  'VERIFIED_ACCOUNTED', 'a second verification of Ben keeps one current status');
select is((select array_agg(action::text || '/' || channel::text order by received_at, event_uuid) from public.muster_responses
            where snapshot_member_id = current_setting('t.ben')::uuid),
  array['PHYSICAL_VERIFICATION/FOREMAN', 'SELF_REPORT/NOTIFICATION_ACTION', 'PHYSICAL_VERIFICATION/FOREMAN'],
  'every actor''s entry is kept for audit');
select is(public.edge_muster_respond(current_setting('t.m')::uuid, tests.id('mm_a1'), 'SELF_REPORT', 'APP',
            tests.id('u_worker_a1'), null, now(), gen_random_uuid(), null) ->> 'reason',
  'NOT_IN_MUSTER', 'a member of another muster is refused');

-- ---------------------------------------------------------------------------------------------
-- Reads: staff board, foreman own crew, worker own row; others refused
-- ---------------------------------------------------------------------------------------------
select tests.authenticate_as(tests.id('u_a_super'));
select set_config('t.board', public.muster_board(current_setting('t.m')::uuid)::text, false);
select is((select jsonb_build_object('can_command', (current_setting('t.board')::jsonb ->> 'can_command')::boolean,
                                     'members', jsonb_array_length(current_setting('t.board')::jsonb -> 'members'),
                                     'counts', current_setting('t.board')::jsonb -> 'counts' -> 'workers' -> 'verified')),
  '{"can_command": false, "members": 5, "counts": 2}'::jsonb, 'the superintendent reads the board but cannot command');
select ok(current_setting('t.board') !~ '(phone|\+1555|"lat|"lng|Maria)', 'the board carries no phone numbers, contacts or positions');
select tests.authenticate_as(tests.id('u_a_safety'));
select is((public.muster_board(current_setting('t.m')::uuid) ->> 'can_command')::boolean, true, 'the safety manager commands');
select tests.authenticate_as(tests.id('u_b_super'));
select throws_ok($$select public.muster_board(current_setting('t.m')::uuid)$$, '42501', 'FORBIDDEN', 'GC B cannot read project A''s muster');
select tests.authenticate_as(tests.id('u_operator'));
select throws_ok($$select public.muster_board(current_setting('t.m')::uuid)$$, '42501', 'FORBIDDEN', 'the platform operator never reads the muster roster');
select tests.authenticate_as(tests.id('u_foreman_a'), 'aal1');
select is((select jsonb_agg(x ->> 'name' order by x ->> 'name') from jsonb_array_elements(public.foreman_muster(current_setting('t.m')::uuid) -> 'members') x),
  '["Ana Acosta", "Ben Avila", "Diego No-Phone", "Fernando Alvarez"]'::jsonb, 'the foreman sees only their company''s workers, no visitors');
select is(jsonb_array_length(public.foreman_active_musters()), 1, 'the foreman sees the active muster of their project');
select throws_ok($$select public.muster_board(current_setting('t.m')::uuid)$$, '42501', 'FORBIDDEN', 'a foreman cannot read the whole board');
select tests.authenticate_as(tests.id('u_foreman_b'), 'aal1');
select throws_ok($$select public.foreman_muster(current_setting('t.m')::uuid)$$, '42501', 'FORBIDDEN', 'a foreman of another company is refused');
select tests.authenticate_as(tests.id('u_worker_a1'), 'aal1');
select is((select jsonb_build_object('member', x ->> 'member_id' = current_setting('t.ana'), 'self', (x ->> 'self_reported')::boolean)
             from jsonb_array_elements(public.my_active_musters()) x),
  '{"member": true, "self": true}'::jsonb, 'Ana sees her own muster row and that she reported herself safe');
select is(public.operation_context(current_setting('t.p')::uuid) ->> 'muster_worker_id', tests.id('w_a1')::text,
  'the operations context lets Ana answer for herself only');
select tests.authenticate_as(tests.id('u_worker_b1'), 'aal1');
select is(jsonb_array_length(public.my_active_musters()), 0, 'a worker of another project sees nothing');

-- ---------------------------------------------------------------------------------------------
-- Push: own token only; delivery is metadata, never presence
-- ---------------------------------------------------------------------------------------------
select tests.authenticate_as(tests.id('u_worker_a1'), 'aal1');
select lives_ok($$select public.register_push_token('install-ana-0001', 'ExponentPushToken[abcdefghij0123456789]', 'IOS')$$,
  'Ana registers her phone for alerts');
select throws_ok($$select public.register_push_token('install-ana-0001', 'not-a-token', 'IOS')$$, '22023', 'PUSH_TOKEN_INVALID',
  'anything that is not an Expo push token is refused');
select tests.as_postgres();
select is((select jsonb_agg(t - 'member_id') from jsonb_array_elements(public.edge_muster_push_targets(current_setting('t.m')::uuid)) t),
  '[{"token": "ExponentPushToken[abcdefghij0123456789]", "locale": "en-US"}]'::jsonb, 'only members with a registered phone are push targets');
select is(public.edge_muster_record_push(current_setting('t.m')::uuid,
            jsonb_build_array(jsonb_build_object('member_id', current_setting('t.ana'), 'status', 'ok'))) + 1, 4,
  'Ana''s push is recorded as sent and the other three workers as without a device');
select is((select jsonb_object_agg(status, n) from (select status, count(*) as n from app_private.muster_push_attempts
                                                     where muster_id = current_setting('t.m')::uuid group by status) x),
  '{"SENT": 1, "NO_DEVICE": 3}'::jsonb, 'delivery records per member');
select is(app_private.muster_counts(current_setting('t.m')::uuid) -> 'workers' -> 'verified', '2'::jsonb,
  'a sent push changes no one''s status');

-- ---------------------------------------------------------------------------------------------
-- Close with unresolved people; late offline checks and corrections become amendments
-- ---------------------------------------------------------------------------------------------
select tests.authenticate_as(tests.id('u_a_safety'));
select set_config('t.close2', public.close_muster(current_setting('t.m')::uuid, 'Fire out. Diego and Fernando not seen.', true)::text, false);
select is((select jsonb_build_object(
             'unresolved', (select jsonb_agg(m ->> 'name' order by m ->> 'name') from jsonb_array_elements(report -> 'members') m
                             where m ->> 'final_status' in ('UNACCOUNTED', 'STATUS_UNKNOWN')),
             'push', report -> 'push' -> 'no_device', 'notice', report ->> 'notice',
             'visitors', report -> 'counts' -> 'visitors' -> 'verified')
             from public.muster_reports where muster_id = current_setting('t.m')::uuid),
  '{"unresolved": ["Diego No-Phone", "Fernando Alvarez"], "push": 3, "notice": "SUPPLEMENTAL_NOT_LIFE_SAFETY", "visitors": 1}'::jsonb,
  'the frozen report lists the unresolved people, the visitor count and the push limitations');
select ok((select bool_and(jsonb_array_length(m -> 'responses') > 0) from public.muster_reports r, jsonb_array_elements(r.report -> 'members') m
            where r.muster_id = current_setting('t.m')::uuid and m ->> 'final_status' = 'VERIFIED_ACCOUNTED'),
  'every verified person shows who verified them and how');
select ok((select bool_and(exists (select 1 from public.muster_snapshot_members sm
                                    where sm.id = (m ->> 'member_id')::uuid and sm.muster_id = r.muster_id))
             from public.muster_reports r, jsonb_array_elements(r.report -> 'members') m
            where r.muster_id = current_setting('t.m')::uuid),
  'each report row names its frozen-list entry, so a correction can point at one person');
select tests.as_postgres();
select is(public.edge_muster_respond(current_setting('t.m')::uuid, current_setting('t.diego')::uuid, 'PHYSICAL_VERIFICATION', 'KIOSK',
            tests.id('u_a_attendant'), tests.id('k_a'), now() - interval '1 second', 'b0000000-0000-4000-8000-000000000007', null) - 'status',
  '{"result": "accepted", "late": true}'::jsonb, 'an offline scan made before the close syncs afterwards as an amendment');
select is((select canonical_status::text from public.muster_snapshot_members where id = current_setting('t.diego')::uuid), 'UNACCOUNTED',
  'the closed snapshot is not changed by it');
select is((select previous_digest = (select digest from public.muster_reports where muster_id = current_setting('t.m')::uuid)
             from public.muster_amendments where event_uuid = 'b0000000-0000-4000-8000-000000000007'),
  true, 'the first amendment is chained to the report digest');
select is(public.edge_muster_respond(current_setting('t.m')::uuid, current_setting('t.diego')::uuid, 'PHYSICAL_VERIFICATION', 'KIOSK',
            tests.id('u_a_attendant'), tests.id('k_a'), now() + interval '1 minute', gen_random_uuid(), null) ->> 'reason',
  'MUSTER_CLOSED', 'a check made after the close is refused');
select tests.authenticate_as(tests.id('u_a_safety'));
select throws_ok($$select public.amend_muster(current_setting('t.m')::uuid, null, 'no', gen_random_uuid())$$, '22023', 'REASON_REQUIRED',
  'a correction needs a note');
select is(public.amend_muster(current_setting('t.m')::uuid, null, 'Fernando called in: off site all day', 'b0000000-0000-4000-8000-000000000008') ->> 'duplicate',
  'false', 'the commander adds a signed correction');
select is((select array_agg(kind || ':' || seq order by seq) from public.muster_amendments where muster_id = current_setting('t.m')::uuid),
  array['LATE_RESPONSE:1', 'CORRECTION:2'], 'amendments are numbered in append order');
-- Review on PR #11: concurrent appends can take the lock in another order than their transactions
-- started, so a later append can carry an EARLIER received_at. The chain must follow append order.
select tests.as_postgres();
insert into public.muster_amendments (muster_id, kind, actor_id, observed_at, received_at, note, event_uuid, seq, previous_digest, digest)
select current_setting('t.m')::uuid, 'CORRECTION', tests.id('u_a_safety'), now(), now() - interval '1 hour',
       'Appended third, but its transaction started first', 'b0000000-0000-4000-8000-000000000009', 3, a.digest,
       encode(sha256(convert_to('concurrent append', 'UTF8')), 'hex')
  from public.muster_amendments a where a.muster_id = current_setting('t.m')::uuid and a.seq = 2;
select tests.authenticate_as(tests.id('u_a_safety'));
select is(public.amend_muster(current_setting('t.m')::uuid, null, 'Gate log checked', 'b0000000-0000-4000-8000-000000000010') ->> 'duplicate',
  'false', 'the commander adds another correction');
select is((select jsonb_build_object('seq', a.seq, 'extends_latest', a.previous_digest = (select b.digest from public.muster_amendments b
                                                                                       where b.event_uuid = 'b0000000-0000-4000-8000-000000000009'))
             from public.muster_amendments a where a.event_uuid = 'b0000000-0000-4000-8000-000000000010'),
  '{"seq": 4, "extends_latest": true}'::jsonb,
  'a new amendment extends the latest append, even when that one carries an earlier timestamp (no fork)');
select tests.as_postgres();
select throws_ok($$insert into public.muster_amendments (muster_id, kind, actor_id, observed_at, note, event_uuid, seq, previous_digest, digest)
                   select current_setting('t.m')::uuid, 'CORRECTION', tests.id('u_a_safety'), now(), 'Branching off an old amendment',
                          gen_random_uuid(), 5, a.digest, encode(sha256(convert_to('fork', 'UTF8')), 'hex')
                     from public.muster_amendments a where a.muster_id = current_setting('t.m')::uuid and a.seq = 2$$,
  '23514', null, 'an amendment that does not extend the latest one is refused');
select throws_ok($$update public.muster_amendments set note = 'edited' where muster_id = current_setting('t.m')::uuid$$, null, null,
  'amendments are append-only');
select tests.authenticate_as(tests.id('u_a_super'));
select throws_ok($$select public.amend_muster(current_setting('t.m')::uuid, null, 'Not mine to amend', gen_random_uuid())$$, '42501', 'FORBIDDEN',
  'only the designated role amends');
select is((select jsonb_agg(a -> 'seq') from jsonb_array_elements(public.muster_report(current_setting('t.m')::uuid) -> 'amendments') a),
  '[1, 2, 3, 4]'::jsonb, 'staff read the report with its amendments in append order');
select tests.authenticate_as(tests.id('u_b_super'));
select throws_ok($$select public.muster_report(current_setting('t.m')::uuid)$$, '42501', 'FORBIDDEN', 'GC B cannot read the report');

-- ---------------------------------------------------------------------------------------------
-- A separate incident is explicit; live refresh on the private project topic
-- ---------------------------------------------------------------------------------------------
select tests.as_postgres();
set constraints all immediate;
set constraints all deferred;
create temp table seen_messages on commit drop as select id from realtime.messages;
select tests.authenticate_as(tests.id('u_a_safety'));
select set_config('t.m2', public.start_muster(current_setting('t.p')::uuid, 'Gas leak', 'a0000000-0000-4000-8000-000000000104')::jsonb ->> 'muster_id', false);
select is(public.start_muster(current_setting('t.p')::uuid, 'Separate: crane incident', 'a0000000-0000-4000-8000-000000000105', true) ->> 'created',
  'true', 'the commander can start an explicitly separate incident');
select tests.as_postgres();
set constraints all immediate;
select is((select count(*)::int from realtime.messages where id not in (select id from seen_messages)
            and event = 'MUSTER_CHANGED' and topic = 'project:' || current_setting('t.p')), 1,
  'the starts send one MUSTER_CHANGED message on the private project topic');

-- An archived project cannot start a muster (decision #114).
select tests.as_postgres();
update public.projects set status = 'ARCHIVED' where id = tests.id('p_b1');
select tests.authenticate_as(tests.id('u_b_super'));
select throws_ok($$select public.start_muster(tests.id('p_b1'), 'Fire', gen_random_uuid())$$, '22023', 'PROJECT_NOT_ACTIVE',
  'an archived project cannot start a muster, even for its designated person');

select * from finish();
rollback;
