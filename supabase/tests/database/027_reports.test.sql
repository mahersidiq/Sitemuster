-- Milestone 10: daily company reports, foreman answers, deadline, reissue, worker hours and
-- correction requests, staff decisions and foreman kiosk grants.
-- A version is stored once and never changes; a dispute keeps it exactly as issued; no answer by
-- the deadline is NOT_CONFIRMED (never approved); only the company's own foreman answers; GC B,
-- other foremen and workers are refused; approving a request is atomic with the correction.
begin;
select plan(82);
select tests.seed_world();

select set_config('t.p', tests.id('p_a1')::text, false), set_config('t.c', tests.id('c_a')::text, false),
       set_config('t.fa', tests.id('u_foreman_a')::text, false), set_config('t.fb', tests.id('u_foreman_b')::text, false);

create function pg_temp.summary(p_company uuid, p_date date, p_worker uuid, p_session uuid)
returns jsonb
language sql
as $$
  select jsonb_build_object(
    'schema_version', 1, 'company_id', p_company, 'local_date', p_date, 'time_zone', 'America/Chicago',
    'day_start_at', (p_date::timestamp at time zone 'America/Chicago'),
    'day_end_at', ((p_date + 1)::timestamp at time zone 'America/Chicago'),
    'workers', jsonb_build_array(jsonb_build_object(
      'worker_id', p_worker, 'definite_seconds', 28800, 'uncertain_seconds', 0, 'pending_approval_seconds', 0,
      'needs_review', false,
      'sessions', jsonb_build_array(jsonb_build_object('session_id', p_session, 'definite_seconds', 28800)))),
    'totals', jsonb_build_object('workers', 1, 'definite_seconds', 28800, 'uncertain_seconds', 0,
                                 'pending_approval_seconds', 0, 'sessions_needing_review', 0, 'peak_estimated_count', 1),
    'notice', 'ESTIMATED_ONSITE_NOT_PAYROLL')
$$;
create function pg_temp.report(p_date date, p_version integer default null)
returns uuid
language sql
as $$
  select id from public.daily_company_reports
   where project_id = current_setting('t.p')::uuid and subcontractor_id = current_setting('t.c')::uuid
     and local_date = p_date and report_version = coalesce(p_version, report_version)
   order by report_version desc limit 1
$$;
grant execute on function pg_temp.report(date, integer) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Storage (service role): version 1 once; a report generated after its deadline is NOT_CONFIRMED
-- ---------------------------------------------------------------------------------------------
select is(public.edge_store_reports(current_setting('t.p')::uuid, '2026-11-03',
            jsonb_build_array(jsonb_build_object('company_id', tests.id('c_a'), 'due_at', now() + interval '1 day',
                              'summary', pg_temp.summary(tests.id('c_a'), '2026-11-03', tests.id('w_a1'), tests.id('s_a1'))))),
  1, 'version 1 of the company report is stored');
select is(public.edge_store_reports(current_setting('t.p')::uuid, '2026-11-03',
            jsonb_build_array(jsonb_build_object('company_id', tests.id('c_a'), 'due_at', now() + interval '1 day',
                              'summary', pg_temp.summary(tests.id('c_a'), '2026-11-03', tests.id('w_a2'), tests.id('s_a1'))))),
  0, 'a second generator stores nothing: the first version stands');
select is((select status::text || ' v' || report_version from public.daily_company_reports where id = pg_temp.report('2026-11-03')),
  'PENDING_CONFIRMATION v1', 'the new report waits for the foreman');
select set_config('t.r1', pg_temp.report('2026-11-03')::text, false);
select set_config('t.summary1', (select summary::text from public.daily_company_reports where id = current_setting('t.r1')::uuid), false);
select throws_ok(
  $$select public.edge_store_reports(current_setting('t.p')::uuid, '2026-11-03',
      jsonb_build_array(jsonb_build_object('company_id', tests.id('c_a'), 'due_at', now() + interval '1 day',
                        'summary', pg_temp.summary(tests.id('c_b'), '2026-11-03', tests.id('w_a1'), tests.id('s_a1')))))$$,
  '22023', 'REPORT_SUMMARY_MISMATCH', 'a summary for another company is refused');
select is(public.edge_store_reports(current_setting('t.p')::uuid, '2026-11-01',
            jsonb_build_array(jsonb_build_object('company_id', tests.id('c_a'), 'due_at', now() - interval '1 hour',
                              'summary', pg_temp.summary(tests.id('c_a'), '2026-11-01', tests.id('w_a1'), tests.id('s_a1'))))),
  1, 'a late report is stored');
select is((select status::text from public.daily_company_reports where id = pg_temp.report('2026-11-01')), 'NOT_CONFIRMED',
  'a report generated after its deadline is NOT_CONFIRMED at once (never auto-approved)');
select ok(exists (select 1 from app_private.audit_logs where action = 'report.generated' and resource_id = current_setting('t.r1')::uuid),
  'generation is audited');
select is(public.edge_store_reports(current_setting('t.p')::uuid, '2026-11-04',
            jsonb_build_array(jsonb_build_object('company_id', tests.id('c_a'), 'due_at', now() + interval '2 days',
                              'summary', pg_temp.summary(tests.id('c_a'), '2026-11-04', tests.id('w_a1'), tests.id('s_a1'))))),
  1, 'another day''s report is stored');

-- ---------------------------------------------------------------------------------------------
-- Reading: staff see every company; the foreman sees and may answer their own; others refused
-- ---------------------------------------------------------------------------------------------
select tests.authenticate_as(tests.id('u_a_super'));
select set_config('t.list', public.report_list(current_setting('t.p')::uuid, '2026-11-03')::text, false);
select is((select jsonb_build_object('company', x ->> 'company_name', 'status', x ->> 'status', 'version', (x ->> 'version')::int,
                                     'can_answer', (x ->> 'can_answer')::boolean, 'ana', x -> 'worker_names' ->> tests.id('w_a1')::text)
             from jsonb_array_elements(current_setting('t.list')::jsonb) x),
  '{"company": "Acme Concrete", "status": "PENDING_CONFIRMATION", "version": 1, "can_answer": false, "ana": "Ana Acosta"}'::jsonb,
  'the superintendent sees the company report with names, but staff never answer for a company');
select is((select x ->> 'status' from jsonb_array_elements(public.report_list(current_setting('t.p')::uuid, '2026-11-02')) x),
  'NOT_CONFIRMED', 'an unanswered report past its deadline reads NOT_CONFIRMED even before the sweep stores it');
select ok(current_setting('t.list') !~ '(phone|"lat|"lng|\+1555)', 'reports carry no phone numbers or coordinates');
select tests.authenticate_as(tests.id('u_foreman_a'), 'aal1');
select is((select (x ->> 'can_answer')::boolean from jsonb_array_elements(public.report_list(current_setting('t.p')::uuid, '2026-11-03')) x),
  true, 'the company''s foreman may answer');
select is(public.report_context(current_setting('t.p')::uuid) -> 'foreman_company_ids', jsonb_build_array(tests.id('c_a')),
  'the foreman''s report context names only their company');
select tests.authenticate_as(tests.id('u_b_super'));
select throws_ok($$select public.report_list(current_setting('t.p')::uuid, '2026-11-03')$$, '42501', 'FORBIDDEN',
  'GC B cannot read project A''s reports');
select is(public.report_context(current_setting('t.p')::uuid), null, 'GC B gets no report context for project A');
select tests.authenticate_as(tests.id('u_foreman_b'), 'aal1');
select throws_ok($$select public.report_list(current_setting('t.p')::uuid, '2026-11-03')$$, '42501', 'FORBIDDEN',
  'a foreman of another company and project is refused');
select tests.authenticate_as(tests.id('u_worker_a1'), 'aal1');
select throws_ok($$select public.report_list(current_setting('t.p')::uuid, '2026-11-03')$$, '42501', 'FORBIDDEN',
  'a worker cannot read company reports');
select tests.authenticate_as(tests.id('u_a_super'), 'aal1');
select throws_ok($$select public.report_list(current_setting('t.p')::uuid, '2026-11-03')$$, '42501', 'FORBIDDEN',
  'staff without MFA cannot read reports');

-- ---------------------------------------------------------------------------------------------
-- Answers (service role with the actor the Edge Function derived)
-- ---------------------------------------------------------------------------------------------
select tests.as_postgres();
select throws_ok($$select public.edge_confirm_report(current_setting('t.r1')::uuid, 1, 'CONFIRM', null, null, gen_random_uuid(), current_setting('t.fb')::uuid)$$,
  '42501', 'FORBIDDEN', 'another company''s foreman cannot answer');
select throws_ok($$select public.edge_confirm_report(current_setting('t.r1')::uuid, 1, 'CONFIRM', null, null, gen_random_uuid(), tests.id('u_a_super'))$$,
  '42501', 'FORBIDDEN', 'GC staff cannot answer for a subcontractor (role matrix)');
select throws_ok($$select public.edge_confirm_report(current_setting('t.r1')::uuid, 1, 'DISPUTE', '  ', null, gen_random_uuid(), current_setting('t.fa')::uuid)$$,
  '22023', 'REASON_REQUIRED', 'a dispute needs a reason');
select is(public.edge_confirm_report(current_setting('t.r1')::uuid, 1, 'DISPUTE', 'Ben was here all day, not listed',
                                      null, '0d000000-0000-4000-8000-000000000001', current_setting('t.fa')::uuid) - 'report_id',
  '{"ok": true, "version": 1, "status": "DISPUTED", "duplicate": false}'::jsonb, 'the foreman disputes version 1');
select is((select summary::text from public.daily_company_reports where id = current_setting('t.r1')::uuid), current_setting('t.summary1'),
  'the disputed version keeps its issued content exactly');
select is(public.edge_confirm_report(current_setting('t.r1')::uuid, 1, 'DISPUTE', 'Ben was here all day, not listed',
                                      null, '0d000000-0000-4000-8000-000000000001', current_setting('t.fa')::uuid) ->> 'duplicate',
  'true', 'resending the same answer is a duplicate, not a second answer');
select is(public.edge_confirm_report(current_setting('t.r1')::uuid, 1, 'CONFIRM', null, null, gen_random_uuid(), current_setting('t.fa')::uuid) ->> 'code',
  'REPORT_ALREADY_ANSWERED', 'one answer per version');
select is((select count(*)::int from public.report_confirmations where report_id = current_setting('t.r1')::uuid and comment is not null), 1,
  'exactly one answer is recorded, with its reason');
select ok(exists (select 1 from app_private.audit_logs where action = 'report.dispute' and resource_id = current_setting('t.r1')::uuid),
  'the dispute is audited');

-- ---------------------------------------------------------------------------------------------
-- Reissue (staff, after corrections): a new version; the old one is superseded, never changed
-- ---------------------------------------------------------------------------------------------
select throws_ok($$select public.edge_reissue_report(current_setting('t.p')::uuid, current_setting('t.c')::uuid, '2026-11-03',
                   pg_temp.summary(tests.id('c_a'), '2026-11-03', tests.id('w_a1'), tests.id('s_a1')), now() + interval '1 day', 'x', tests.id('u_a_super'))$$,
  '22023', 'REASON_REQUIRED', 'a reissue needs a reason');
select is(public.edge_reissue_report(current_setting('t.p')::uuid, current_setting('t.c')::uuid, '2026-11-03',
            pg_temp.summary(tests.id('c_a'), '2026-11-03', tests.id('w_a1'), tests.id('s_a1')), now() + interval '1 day',
            'Added Ben after the dispute', tests.id('u_a_super')) ->> 'version', '2', 'version 2 is issued');
select set_config('t.r2', pg_temp.report('2026-11-03', 2)::text, false);
select is((select jsonb_build_object('v1', (select status from public.daily_company_reports where id = current_setting('t.r1')::uuid),
                                     'v2', status, 'supersedes', supersedes_id = current_setting('t.r1')::uuid)
             from public.daily_company_reports where id = current_setting('t.r2')::uuid),
  '{"v1": "SUPERSEDED", "v2": "PENDING_CONFIRMATION", "supersedes": true}'::jsonb,
  'version 1 is superseded and version 2 waits for an answer');
select ok(exists (select 1 from app_private.audit_logs where action = 'report.reissued' and resource_id = current_setting('t.r2')::uuid
                     and metadata ->> 'reason' = 'Added Ben after the dispute' and metadata ->> 'previous_version' = '1'),
  'the reissue is audited with actor, reason and the previous version');
select is(public.edge_confirm_report(current_setting('t.r1')::uuid, 1, 'CONFIRM', null, null, gen_random_uuid(), current_setting('t.fa')::uuid) ->> 'code',
  'REPORT_VERSION_STALE', 'an answer to a superseded version is refused');
select tests.authenticate_as(tests.id('u_a_super'));
select is((select jsonb_build_object('version', (x ->> 'version')::int, 'earlier', x -> 'earlier_versions',
                                     'answers', (select jsonb_agg(a ->> 'action' || ' v' || (a ->> 'version')) from jsonb_array_elements(x -> 'answers') a))
             from jsonb_array_elements(public.report_list(current_setting('t.p')::uuid, '2026-11-03')) x),
  '{"version": 2, "earlier": [{"version": 1, "status": "SUPERSEDED"}], "answers": ["DISPUTE v1"]}'::jsonb,
  'the list shows the newest version with earlier versions and the earlier answers kept');

-- ---------------------------------------------------------------------------------------------
-- Correction submission: proposals become pending FOREMAN_REQUEST corrections
-- ---------------------------------------------------------------------------------------------
select tests.as_postgres();
select throws_ok($$select public.edge_confirm_report(pg_temp.report('2026-11-04'), 1, 'SUBMIT_CORRECTION', 'Wrong worker',
                   jsonb_build_array(jsonb_build_object('worker_id', tests.id('w_b1'), 'session_id', null,
                                     'proposed_start_at', '2026-11-04T13:00:00Z', 'proposed_end_at', '2026-11-04T21:00:00Z')),
                   gen_random_uuid(), current_setting('t.fa')::uuid)$$,
  '22023', 'WORKER_NOT_IN_REPORT', 'a proposal may only name workers of this report');
select throws_ok($$select public.edge_confirm_report(pg_temp.report('2026-11-04'), 1, 'SUBMIT_CORRECTION', repeat('x', 1001),
                   jsonb_build_array(jsonb_build_object('worker_id', tests.id('w_a1'), 'session_id', tests.id('s_a1'),
                                     'proposed_start_at', null, 'proposed_end_at', now() - interval '1 hour')),
                   gen_random_uuid(), current_setting('t.fa')::uuid)$$,
  '22023', 'REASON_TOO_LONG', 'a reason longer than the stored correction reason (1,000) is refused up front (review on PR #10)');
select is((select count(*)::int from public.attendance_corrections where channel = 'FOREMAN_REQUEST'), 0,
  'and nothing was recorded for it');
select throws_ok($$select public.edge_confirm_report(pg_temp.report('2026-11-04'), 1, 'SUBMIT_CORRECTION', 'Nothing proposed',
                   '[]'::jsonb, gen_random_uuid(), current_setting('t.fa')::uuid)$$,
  '22023', 'PROPOSAL_REQUIRED', 'a correction needs at least one proposal');
select is(public.edge_confirm_report(current_setting('t.r2')::uuid, 2, 'SUBMIT_CORRECTION', 'Ana left at 3 pm',
            jsonb_build_array(jsonb_build_object('worker_id', tests.id('w_a1'), 'session_id', tests.id('s_a1'),
                              'proposed_start_at', null, 'proposed_end_at', (now() - interval '1 hour'), 'note', 'left early')),
            '0d000000-0000-4000-8000-000000000002', current_setting('t.fa')::uuid) ->> 'status',
  'CORRECTION_REQUESTED', 'the foreman submits a correction for version 2');
select is((select jsonb_build_object('status', status, 'channel', channel, 'version', proposed_json -> 'report_version',
                                     'original', original_json ? 'start_at')
             from public.attendance_corrections where requested_by = current_setting('t.fa')::uuid),
  '{"status": "PENDING", "channel": "FOREMAN_REQUEST", "version": 2, "original": true}'::jsonb,
  'the proposal is a pending FOREMAN_REQUEST with the original kept for audit');

-- ---------------------------------------------------------------------------------------------
-- Deadline: no answer by 12:00 next workday → NOT_CONFIRMED
-- ---------------------------------------------------------------------------------------------
insert into public.daily_company_reports (project_id, subcontractor_id, local_date, report_version, summary, due_at)
values (current_setting('t.p')::uuid, current_setting('t.c')::uuid, '2026-10-30', 1,
        pg_temp.summary(tests.id('c_a'), '2026-10-30', tests.id('w_a1'), tests.id('s_a1')), now() - interval '1 minute');
select is(public.edge_confirm_report(pg_temp.report('2026-10-30'), 1, 'CONFIRM', null, null, gen_random_uuid(), current_setting('t.fa')::uuid) ->> 'code',
  'REPORT_DEADLINE_PASSED', 'an answer after the deadline is refused');
select is((select status::text from public.daily_company_reports where id = pg_temp.report('2026-10-30')), 'NOT_CONFIRMED',
  'and the overdue report is stored NOT_CONFIRMED');
select is(app_private.report_deadline_sweep(now()), 2, 'the sweep marks the two seeded overdue reports NOT_CONFIRMED');
select is((select count(*)::int from public.daily_company_reports where status = 'PENDING_CONFIRMATION' and due_at <= now()), 0,
  'no overdue report is left waiting');
select tests.authenticate_as(tests.id('u_foreman_a'), 'aal1');
select is((select jsonb_agg(x ->> 'local_date') from jsonb_array_elements(public.my_pending_reports()) x), '["2026-11-04"]'::jsonb,
  'the foreman''s pending list holds only reports still open for an answer');
select tests.authenticate_as(tests.id('u_foreman_b'), 'aal1');
select is(jsonb_array_length(public.my_pending_reports()), 0, 'foreman B sees none of company A''s reports');

-- ---------------------------------------------------------------------------------------------
-- Integrity guards
-- ---------------------------------------------------------------------------------------------
select tests.as_postgres();
select throws_ok($$update public.daily_company_reports set status = 'PENDING_CONFIRMATION' where id = current_setting('t.r2')::uuid$$,
  '42501', 'report status cannot move from CORRECTION_REQUESTED to PENDING_CONFIRMATION', 'an answered report never reopens');
select throws_ok($$update public.daily_company_reports set summary = summary || '{"edited": true}' where id = current_setting('t.r2')::uuid$$,
  '42501', 'report versions are immutable; issue a new version', 'a version''s content never changes');
select throws_ok($$update public.daily_company_reports set due_at = now() + interval '9 days' where id = pg_temp.report('2026-11-04')$$,
  '42501', 'report versions are immutable; issue a new version', 'the deadline cannot be moved');
select throws_ok($$delete from public.daily_company_reports where id = current_setting('t.r1')::uuid$$,
  null, null, 'reports are never deleted');

-- ---------------------------------------------------------------------------------------------
-- Worker: own hours and correction requests
-- ---------------------------------------------------------------------------------------------
select tests.authenticate_as(tests.id('u_worker_a1'), 'aal1');
select set_config('t.mine', public.my_attendance(current_setting('t.p')::uuid, now() - interval '7 days', now())::text, false);
select is((select jsonb_build_object('tz', current_setting('t.mine')::jsonb -> 'project' ->> 'time_zone',
                                     'sessions', (select jsonb_agg(s ->> 'id') from jsonb_array_elements(current_setting('t.mine')::jsonb -> 'sessions') s))),
  jsonb_build_object('tz', 'America/Chicago', 'sessions', jsonb_build_array(tests.id('s_a1'))),
  'the worker gets only their own sessions and the project time zone');
select ok(current_setting('t.mine') !~ '(Avila|Banks|phone|"lat|"lng)', 'no other worker''s data and no coordinates');
select throws_ok($$select public.my_attendance(tests.id('p_b1'), now() - interval '7 days', now())$$, '42501', 'FORBIDDEN',
  'a worker cannot read another project''s attendance');
select throws_ok($$select public.my_attendance(current_setting('t.p')::uuid, now() - interval '90 days', now())$$, '22023', 'RANGE_INVALID',
  'at most 62 days per request');
select is(public.request_attendance_correction(current_setting('t.p')::uuid, tests.id('s_a1'), null, now() - interval '1 hour',
            'I left at 2 pm', '0e000000-0000-4000-8000-000000000001') - 'request_id',
  '{"status": "PENDING", "duplicate": false}'::jsonb, 'the worker asks to correct their own session');
select is(public.request_attendance_correction(current_setting('t.p')::uuid, tests.id('s_a1'), null, now() - interval '1 hour',
            'I left at 2 pm', '0e000000-0000-4000-8000-000000000001') ->> 'duplicate', 'true',
  'a resent request is a duplicate');
select throws_ok($$select public.request_attendance_correction(current_setting('t.p')::uuid, tests.id('s_b1'), null, now() - interval '1 hour', 'not mine', gen_random_uuid())$$,
  '22023', 'SESSION_NOT_FOUND', 'a worker cannot ask to change someone else''s session');
select throws_ok($$select public.request_attendance_correction(current_setting('t.p')::uuid, tests.id('s_a1'), null, now() + interval '2 hours', 'later', gen_random_uuid())$$,
  '22023', 'TIME_IN_FUTURE', 'a proposed time cannot be in the future');
select throws_ok($$select public.request_attendance_correction(current_setting('t.p')::uuid, null, now() - interval '5 hours', null, 'missing day', gen_random_uuid())$$,
  '22023', 'MISSING_VISIT_NEEDS_BOTH_TIMES', 'a missing visit needs an arrival and a departure');
select throws_ok($$select public.request_attendance_correction(current_setting('t.p')::uuid, tests.id('s_a1'), null, now() - interval '1 hour', 'no', gen_random_uuid())$$,
  '22023', 'REASON_REQUIRED', 'a request needs a reason');
select is((select jsonb_agg(r ->> 'status') from jsonb_array_elements(public.my_attendance(current_setting('t.p')::uuid, now() - interval '7 days', now()) -> 'requests') r),
  '["PENDING"]'::jsonb, 'the worker sees their request and its status');
select tests.authenticate_as(tests.id('u_a_super'));
select throws_ok($$select public.request_attendance_correction(current_setting('t.p')::uuid, tests.id('s_a1'), null, now() - interval '1 hour', 'staff', gen_random_uuid())$$,
  '42501', 'FORBIDDEN', 'staff use the manual correction, not a worker request');

-- ---------------------------------------------------------------------------------------------
-- Staff decisions
-- ---------------------------------------------------------------------------------------------
select set_config('t.requests', public.correction_requests(current_setting('t.p')::uuid)::text, false);
select is((select jsonb_agg(r ->> 'channel' || ' ' || (r ->> 'status') order by r ->> 'channel')
             from jsonb_array_elements(current_setting('t.requests')::jsonb) r),
  '["FOREMAN_REQUEST PENDING", "WORKER_REQUEST PENDING"]'::jsonb, 'the superintendent sees both pending requests');
select set_config('t.wr', (select r ->> 'request_id' from jsonb_array_elements(current_setting('t.requests')::jsonb) r where r ->> 'channel' = 'WORKER_REQUEST'), false);
select set_config('t.fr', (select r ->> 'request_id' from jsonb_array_elements(current_setting('t.requests')::jsonb) r where r ->> 'channel' = 'FOREMAN_REQUEST'), false);
select tests.authenticate_as(tests.id('u_a_attendant'));
select throws_ok($$select public.correction_requests(current_setting('t.p')::uuid)$$, '42501', 'FORBIDDEN',
  'a kiosk attendant cannot decide corrections');
select tests.authenticate_as(tests.id('u_b_super'));
select throws_ok($$select public.reject_correction_request(current_setting('t.wr')::uuid, 'not ours')$$, '42501', 'FORBIDDEN',
  'GC B cannot decide project A''s requests');
select tests.authenticate_as(tests.id('u_a_super'));
select throws_ok($$select public.reject_correction_request(current_setting('t.wr')::uuid, ' ')$$, '22023', 'REASON_REQUIRED',
  'a rejection needs a reason');
select lives_ok($$select public.reject_correction_request(current_setting('t.wr')::uuid, 'Badge log shows 5 pm')$$, 'the superintendent rejects');
select is((select status::text || ': ' || decision_reason from public.attendance_corrections where id = current_setting('t.wr')::uuid),
  'REJECTED: Badge log shows 5 pm', 'the rejection keeps its reason');
select throws_ok($$select public.reject_correction_request(current_setting('t.wr')::uuid, 'again')$$, '22023', 'REQUEST_ALREADY_DECIDED',
  'a decided request stays decided');

-- Approval happens in the reconciler commit (STAFF_MANUAL row naming the request).
select tests.as_postgres();
insert into public.attendance_corrections (session_id, project_id, worker_id, channel, requested_by, approved_by, reason,
                                           original_json, proposed_json, status, action_at, event_uuid)
values (tests.id('s_a1'), current_setting('t.p')::uuid, tests.id('w_a1'), 'STAFF_MANUAL', tests.id('u_a_super'), tests.id('u_a_super'),
        'Approved foreman correction', '{}', jsonb_build_object('end_at', now() - interval '1 hour', 'request_id', current_setting('t.fr')),
        'APPROVED', now(), '0f000000-0000-4000-8000-000000000001');
select is((select jsonb_build_object('status', status, 'by', approved_by = tests.id('u_a_super'), 'event', resolved_by_event)
             from public.attendance_corrections where id = current_setting('t.fr')::uuid),
  '{"status": "APPROVED", "by": true, "event": "0f000000-0000-4000-8000-000000000001"}'::jsonb,
  'the manual correction that names the request approves it in the same transaction');
select throws_ok($$insert into public.attendance_corrections (session_id, project_id, worker_id, channel, requested_by, approved_by, reason,
                   original_json, proposed_json, status, action_at, event_uuid)
                   values (tests.id('s_a1'), current_setting('t.p')::uuid, tests.id('w_a1'), 'STAFF_MANUAL', tests.id('u_a_super'), tests.id('u_a_super'),
                   'Approve the rejected one', '{}', jsonb_build_object('request_id', current_setting('t.wr')), 'APPROVED', now(), gen_random_uuid())$$,
  '55000', 'CORRECTION_REQUEST_NOT_PENDING', 'a rejected request cannot be approved afterwards');
select tests.authenticate_as(tests.id('u_worker_a1'), 'aal1');
select set_config('t.wr2', public.request_attendance_correction(current_setting('t.p')::uuid, null, now() - interval '30 hours',
                    now() - interval '22 hours', 'Forgot to scan yesterday', gen_random_uuid()) ->> 'request_id', false);
select tests.as_postgres();
select throws_ok($$insert into public.attendance_corrections (session_id, project_id, worker_id, channel, requested_by, approved_by, reason,
                   original_json, proposed_json, status, action_at, event_uuid)
                   values (null, current_setting('t.p')::uuid, tests.id('w_a2'), 'STAFF_MANUAL', tests.id('u_a_super'), tests.id('u_a_super'),
                   'Wrong worker', '{}', jsonb_build_object('request_id', current_setting('t.wr2')), 'APPROVED', now(), gen_random_uuid())$$,
  '55000', 'CORRECTION_REQUEST_NOT_PENDING', 'a correction for another worker cannot approve the request');
select is((select status::text from public.attendance_corrections where id = current_setting('t.wr2')::uuid), 'PENDING',
  'and the request stays pending');

-- ---------------------------------------------------------------------------------------------
-- Foreman kiosk grants (own crew only, decision #107)
-- ---------------------------------------------------------------------------------------------
select tests.authenticate_as(tests.id('u_a_super'));
select is(public.foreman_kiosk_grants(current_setting('t.p')::uuid),
  jsonb_build_array(jsonb_build_object('foreman_profile_id', tests.id('w_fa'), 'name', 'Fernando Alvarez', 'company_id', tests.id('c_a'),
                                       'company_name', 'Acme Concrete', 'can_operate_kiosk', false)),
  'the superintendent sees the project''s foremen and their kiosk grant');
select throws_ok($$select public.set_foreman_kiosk_grant(current_setting('t.p')::uuid, tests.id('c_a'), tests.id('w_fa'), true, '')$$,
  '22023', 'REASON_REQUIRED', 'a grant change needs a reason');
select throws_ok($$select public.set_foreman_kiosk_grant(current_setting('t.p')::uuid, tests.id('c_b'), tests.id('w_fb'), true, 'Bolt crew')$$,
  '22023', 'FOREMAN_NOT_FOUND', 'only foremen of companies approved on this project can be granted');
select lives_ok($$select public.set_foreman_kiosk_grant(current_setting('t.p')::uuid, tests.id('c_a'), tests.id('w_fa'), true, 'Scans his crew at the gate')$$,
  'the superintendent grants the kiosk to the Acme foreman');
select tests.authenticate_as(tests.id('u_foreman_a'), 'aal1');
select is(public.operation_context(current_setting('t.p')::uuid) ->> 'kiosk', 'OWN_CREW', 'the foreman may now scan their own crew');
select tests.authenticate_as(tests.id('u_a_super'));
select lives_ok($$select public.set_foreman_kiosk_grant(current_setting('t.p')::uuid, tests.id('c_a'), tests.id('w_fa'), false, 'Attendant is back')$$,
  'the grant is removed');
select tests.authenticate_as(tests.id('u_foreman_a'), 'aal1');
select is(public.operation_context(current_setting('t.p')::uuid) ->> 'kiosk', null, 'and the foreman can no longer scan');
select tests.authenticate_as(tests.id('u_b_super'));
select throws_ok($$select public.set_foreman_kiosk_grant(current_setting('t.p')::uuid, tests.id('c_a'), tests.id('w_fa'), true, 'not mine')$$,
  '42501', 'FORBIDDEN', 'GC B cannot grant on project A');
select tests.as_postgres();
select is((select array_agg(action order by occurred_at, action) from app_private.audit_logs where action like 'foreman.kiosk_%'),
  array['foreman.kiosk_granted', 'foreman.kiosk_revoked'], 'grant changes are audited');

-- ---------------------------------------------------------------------------------------------
-- Live refresh: one REPORT_CHANGED message per project at commit (ids only)
-- ---------------------------------------------------------------------------------------------
set constraints all immediate;
set constraints all deferred;
create temp table seen_messages on commit drop as select id from realtime.messages;
select public.edge_store_reports(current_setting('t.p')::uuid, '2026-11-05',
         jsonb_build_array(jsonb_build_object('company_id', tests.id('c_a'), 'due_at', now() + interval '3 days',
                           'summary', pg_temp.summary(tests.id('c_a'), '2026-11-05', tests.id('w_a1'), tests.id('s_a1')))));
set constraints all immediate;
select is((select array_agg(event || ' ' || (topic = 'project:' || current_setting('t.p'))::text) from realtime.messages
            where id not in (select id from seen_messages)),
  array['REPORT_CHANGED true'], 'a new report tells open report screens to refetch, on the private project topic');

select * from finish();
rollback;
