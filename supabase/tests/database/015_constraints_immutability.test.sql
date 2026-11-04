-- Uniqueness, immutability and data-integrity constraints (Milestone 02 acceptance:
-- "unique session/event constraints tested").
begin;
select plan(35);
select tests.seed_world();

-- Event and session uniqueness.
select throws_ok(
  format($$insert into public.attendance_events (event_uuid, worker_id, project_id, config_version_id, source, direction, observed_at, verification_status, confidence, device_id) values (%L, %L, %L, %L, 'GEOFENCE', 'ENTRY', now(), 'SYSTEM_CONFIRMED', 'MEDIUM', %L)$$,
         tests.id('ev_a1'), tests.id('w_a1'), tests.id('p_a1'), tests.id('cv_a1'), tests.id('d_a1')),
  '23505', null, 'duplicate attendance event UUID is rejected (idempotency)');
select throws_ok(
  format($$insert into public.attendance_sessions (project_id, worker_id, start_at, start_source, config_version_id, status, iana_timezone) values (%L, %L, now(), 'KIOSK_DYNAMIC_BADGE', %L, 'OPEN', 'America/Chicago')$$,
         tests.id('p_a1'), tests.id('w_a1'), tests.id('cv_a1')),
  '23505', null, 'a second open session for the same worker and project is rejected');
select throws_ok(
  format($$insert into public.attendance_sessions (project_id, worker_id, start_at, start_source, config_version_id, status, iana_timezone) values (%L, %L, now(), 'MANUAL', %L, 'UNRESOLVED', 'America/Chicago')$$,
         tests.id('p_a1'), tests.id('w_a1'), tests.id('cv_a1')),
  '23505', null, 'an UNRESOLVED session also blocks a parallel open interval');
update public.attendance_sessions set status = 'CLOSED', end_at = start_at + interval '8 hours', end_source = 'GEOFENCE' where id = tests.id('s_a1');
select lives_ok(
  format($$insert into public.attendance_sessions (project_id, worker_id, start_at, start_source, config_version_id, status, iana_timezone) values (%L, %L, now(), 'FOREMAN', %L, 'OPEN', 'America/Chicago')$$,
         tests.id('p_a1'), tests.id('w_a1'), tests.id('cv_a1')),
  'after closing, a new visit opens a separate session');
select throws_ok(
  format($$update public.attendance_sessions set end_at = start_at - interval '1 minute', end_source = 'MANUAL', status = 'CLOSED' where id = %L$$, tests.id('s_b1')),
  '23514', null, 'a session cannot end before it starts');

select throws_ok(
  format($$insert into app_private.location_event_receipts (event_uuid, device_id, worker_id, project_id, event_type, observed_at, qualification_state, terminal_result) values (%L, %L, %L, %L, 'GEOFENCE_ENTER', now(), 'QUALIFIED', 'accepted'), (%L, %L, %L, %L, 'GEOFENCE_ENTER', now(), 'QUALIFIED', 'accepted')$$,
         '11111111-2222-4333-8444-555555555555', tests.id('d_a1'), tests.id('w_a1'), tests.id('p_a1'),
         '11111111-2222-4333-8444-555555555555', tests.id('d_a1'), tests.id('w_a1'), tests.id('p_a1')),
  '23505', null, 'duplicate native event UUID receipt is rejected');
select throws_ok(
  format($$insert into app_private.location_event_receipts (event_uuid, device_id, worker_id, event_type, observed_at, qualification_state, terminal_result) values (gen_random_uuid(), %L, %L, 'OTHER', now(), 'NOT_APPLICABLE', 'rejected')$$, tests.id('d_a1'), tests.id('w_a1')),
  '23514', null, 'a rejected receipt must carry its reason');
select throws_ok(
  format($$insert into app_private.badge_nonce_redemptions (project_id, device_id, time_step, event_uuid) values (%L, %L, 59000000, gen_random_uuid()), (%L, %L, 59000000, gen_random_uuid())$$,
         tests.id('p_a1'), tests.id('d_a1'), tests.id('p_a1'), tests.id('d_a1')),
  '23505', null, 'an offline badge (device, step, project) can be redeemed only once');

-- Immutability (append-only).
select throws_ok(format($$update public.attendance_events set reason = 'edited' where event_uuid = %L$$, tests.id('ev_a1')), '42501', null, 'attendance events cannot be edited');
select throws_ok(format($$delete from public.attendance_events where event_uuid = %L$$, tests.id('ev_b1')), '42501', null, 'attendance events cannot be deleted');
select lives_ok(
  format($$select set_config('app.retention_purge', 'on', true); delete from public.attendance_events where event_uuid = %L$$, tests.id('ev_b1')),
  'documented retention purge path can delete');
select set_config('app.retention_purge', '', true);
select throws_ok(format($$update public.project_tracking_config_versions set settings_json = '{}' where id = %L$$, tests.id('cv_a1')), '42501', null, 'config versions are immutable');
select throws_ok(format($$update public.project_geofences set radius_m = 300 where config_version_id = %L$$, tests.id('cv_a1')), '42501', null, 'versioned geofences are immutable');
select throws_ok(format($$delete from public.project_work_windows where config_version_id = %L$$, tests.id('cv_a1')), '42501', null, 'versioned work windows are immutable');
select is(
  (select sha256 from public.project_tracking_config_versions where id = tests.id('cv_a1')),
  encode(sha256(convert_to((select settings_json::text from public.project_tracking_config_versions where id = tests.id('cv_a1')), 'UTF8')), 'hex'),
  'config version digest is computed by the server');
select throws_ok(format($$update public.legal_notice_versions set content = 'changed' where id = %L$$, tests.id('n_en')), '42501', null, 'legal notice text is immutable (new version required)');

-- Geofence, timezone and coordinate bounds.
select lives_ok(
  format($$insert into public.project_tracking_config_versions (id, project_id, version_number, effective_at, settings_json) values ('2a000000-0000-4000-8000-0000000000a2', %L, 2, now(), '{}')$$, tests.id('p_a1')),
  'a configuration change is a new immutable version');
select throws_ok(
  format($$insert into public.project_geofences (config_version_id, project_id, center, radius_m) values ('2a000000-0000-4000-8000-0000000000a2', %L, extensions.st_setsrid(extensions.st_makepoint(-95.37, 29.76), 4326)::extensions.geography, 149)$$, tests.id('p_a1')),
  '23514', null, 'geofence radius below 150 m is rejected');
select throws_ok(
  format($$insert into public.project_geofences (config_version_id, project_id, center, radius_m) values ('2a000000-0000-4000-8000-0000000000a2', %L, extensions.st_setsrid(extensions.st_makepoint(-95.37, 29.76), 4326)::extensions.geography, 2001)$$, tests.id('p_a1')),
  '23514', null, 'geofence radius above 2000 m is rejected');
select throws_ok(
  format($$insert into public.projects (organization_id, name, iana_timezone, idempotency_key) values (%L, 'Bad TZ', 'Mars/Olympus', gen_random_uuid())$$, tests.id('org_a')),
  '22023', null, 'unknown IANA timezone is rejected');

-- Muster integrity (spec 12).
select throws_ok(
  format($$insert into public.muster_responses (muster_id, snapshot_member_id, action, channel, observed_at, resulting_status, event_uuid) values (%L, %L, 'SELF_REPORT', 'APP', now(), 'VERIFIED_ACCOUNTED', gen_random_uuid())$$, tests.id('m_a'), tests.id('mm_a1')),
  '23514', null, 'I''M SAFE can never produce VERIFIED_ACCOUNTED');
select throws_ok(
  format($$insert into public.muster_responses (muster_id, snapshot_member_id, action, channel, observed_at, resulting_status, event_uuid) values (%L, %L, 'PHYSICAL_VERIFICATION', 'APP', now(), 'VERIFIED_ACCOUNTED', gen_random_uuid())$$, tests.id('m_a'), tests.id('mm_a1')),
  '23514', null, 'physical verification cannot come from the worker app');
select throws_ok(
  format($$insert into public.muster_events (project_id, incident_label, idempotency_key) values (%L, 'Second', gen_random_uuid())$$, tests.id('p_a1')),
  '23505', null, 'concurrent second ACTIVE muster for the same incident is rejected');
select lives_ok(
  format($$insert into public.muster_events (project_id, incident_label, incident_key, idempotency_key) values (%L, 'Separate incident', 'gas-leak-2', gen_random_uuid())$$, tests.id('p_a1')),
  'an explicitly distinct incident may run in parallel');
update public.muster_snapshot_members set canonical_status = 'VERIFIED_ACCOUNTED' where id = tests.id('mm_a1');
select throws_ok(format($$update public.muster_snapshot_members set canonical_status = 'SELF_REPORTED_SAFE' where id = %L$$, tests.id('mm_a1')), '42501', null, 'verified status cannot be silently downgraded');
update public.muster_events set status = 'CLOSED', ended_at = now() where id = tests.id('m_a');
select throws_ok(format($$update public.muster_events set incident_label = 'edited' where id = %L$$, tests.id('m_a')), '42501', null, 'a closed muster is immutable');
select throws_ok(format($$update public.muster_snapshot_members set canonical_status = 'STATUS_UNKNOWN' where id = %L$$, tests.id('mm_v')), '42501', null, 'a closed muster snapshot is immutable');

-- Last owner protection.
select throws_ok(
  format($$delete from public.organization_members where organization_id = %L and role = 'OWNER'$$, tests.id('org_b')),
  '23514', null, 'the last active owner cannot be removed');

-- Enrollment, consent and identity rules.
select throws_ok(
  format($$insert into public.worker_enrollments (project_id, worker_id, enrollment_status, approved_by, approval_at) values (%L, %L, 'APPROVED', %L, now())$$, tests.id('p_b1'), tests.id('w_a2'), tests.id('u_b_super')),
  '23514', null, 'approval without a recorded orientation is rejected');
select throws_ok(
  format($$insert into public.worker_enrollments (project_id, worker_id) values (%L, %L)$$, tests.id('p_a1'), tests.id('w_a1')),
  '23505', null, 'one active enrollment per worker and project');
select throws_ok(
  format($$insert into public.tracking_consents (worker_id, project_id, notice_version_id, locale, method, accepted_at) values (%L, %L, %L, 'es-US', 'DIGITAL', now())$$, tests.id('w_a2'), tests.id('p_a1'), tests.id('n_en')),
  '23514', null, 'consent locale must match the notice version');
select throws_ok(
  format($$insert into public.worker_profiles (auth_user_id, legal_name, managed_identity) values (%L, 'Fake', true)$$, tests.id('u_outsider')),
  '23514', null, 'a managed (no-phone) identity never carries an invented auth account');

-- Privacy constraints on diagnostic data.
select throws_ok(
  $$insert into app_private.location_ingest_quarantine (reason, sanitized_payload) values ('INVALID_RECORD', '{"uuid":"x","extras":{"coords":{"latitude":1,"longitude":2}}}')$$,
  '23514', null, 'quarantine refuses payloads containing coordinates');
select throws_ok(
  $$insert into app_private.audit_logs (actor_type, action, metadata) values ('SYSTEM', 'test.event', '{"lat": 29.7}')$$,
  '23514', null, 'audit metadata refuses coordinates');
select throws_ok(
  format($$insert into public.daily_company_reports (project_id, subcontractor_id, local_date, report_version, summary, due_at) values (%L, %L, '2026-11-01', 1, '{"position": [1,2]}', now())$$, tests.id('p_a1'), tests.id('c_a')),
  '23514', null, 'daily report summaries refuse coordinates');

select * from finish();
rollback;
