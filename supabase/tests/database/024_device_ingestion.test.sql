-- Milestone 07: device bindings, upload-credential authentication and renewal, ingest helpers,
-- the continuous-coordinate release gate, the worker tracking plan and staff tracking health
-- (docs/spec/03, docs/spec/11; decisions #24, #27, #39, #44, #45, #89–#95).
begin;
select plan(57);
select tests.seed_world();
-- Ids as session settings: usable under every role (the tests schema is postgres-only).
select set_config('t.cv_a1', tests.id('cv_a1')::text, true);
select set_config('t.d_a1', tests.id('d_a1')::text, true);
select set_config('t.d_a1_old', tests.id('d_a1_old')::text, true);
select set_config('t.e_a1', tests.id('e_a1')::text, true);
select set_config('t.n_en', tests.id('n_en')::text, true);
select set_config('t.p_a1', tests.id('p_a1')::text, true);
select set_config('t.p_b1', tests.id('p_b1')::text, true);
select set_config('t.s_a1', tests.id('s_a1')::text, true);
select set_config('t.u_a_super', tests.id('u_a_super')::text, true);
select set_config('t.u_b_super', tests.id('u_b_super')::text, true);
select set_config('t.u_worker_a1', tests.id('u_worker_a1')::text, true);
select set_config('t.u_worker_a2', tests.id('u_worker_a2')::text, true);
select set_config('t.u_worker_b1', tests.id('u_worker_b1')::text, true);
select set_config('t.w_a1', tests.id('w_a1')::text, true);
select set_config('t.w_a2', tests.id('w_a2')::text, true);
select set_config('t.w_b1', tests.id('w_b1')::text, true);

-- Ids for this file.
select set_config('t.d_a2', '5d000000-0000-4000-8000-0000000000a2', true);
select set_config('t.d_a1_new', '5d000000-0000-4000-8000-0000000000a9', true);
select set_config('t.cv_a1_v2', '2a000000-0000-4000-8000-0000000000a2', true);

-- Credentials for the seeded phone d_a1 (worker a1, project p_a1).
insert into app_private.device_upload_credentials (device_id, token_sha256, created_at, expires_at) values
  (current_setting('t.d_a1')::uuid, sha256('m07-active'), now() - interval '1 day', now() + interval '29 days');
insert into app_private.device_upload_credentials (device_id, token_sha256, created_at, expires_at, revoked_at) values
  (current_setting('t.d_a1')::uuid, sha256('m07-revoked'), now() - interval '2 days', now() + interval '28 days', now() - interval '1 hour');
insert into app_private.device_upload_credentials (device_id, token_sha256, created_at, expires_at, overlap_until) values
  (current_setting('t.d_a1')::uuid, sha256('m07-rotated'), now() - interval '10 days', now() + interval '20 days', now() + interval '2 hours');
insert into app_private.device_upload_credentials (device_id, token_sha256, created_at, expires_at) values
  (current_setting('t.d_a1_old')::uuid, sha256('m07-old-phone'), now() - interval '3 days', now() + interval '27 days');

-- ---------------------------------------------------------------------------------------------
-- Bindings are derived from eligibility (decision #89)
-- ---------------------------------------------------------------------------------------------
create function pg_temp.active_bindings(p_device uuid) returns bigint language sql as
  $$ select count(*) from public.device_project_bindings where device_id = p_device and revoked_at is null and enabled $$;

select is(pg_temp.active_bindings(current_setting('t.d_a1')::uuid), 1::bigint,
  'the seeded phone is bound once to its consented, approved project');

update public.tracking_consents set withdrawn_at = now() where worker_id = current_setting('t.w_a1')::uuid and project_id = current_setting('t.p_a1')::uuid;
select is(pg_temp.active_bindings(current_setting('t.d_a1')::uuid), 0::bigint, 'withdrawing consent revokes the binding immediately');
insert into public.tracking_consents (worker_id, project_id, notice_version_id, locale, method, accepted_at)
values (current_setting('t.w_a1')::uuid, current_setting('t.p_a1')::uuid, current_setting('t.n_en')::uuid, 'en-US', 'DIGITAL', now());
select is(pg_temp.active_bindings(current_setting('t.d_a1')::uuid), 1::bigint, 'a new acknowledgement binds the phone again');

update public.worker_enrollments set employer_status = 'PENDING_CONFIRMATION', employer_confirmed_at = null, employer_confirmed_by = null
 where id = current_setting('t.e_a1')::uuid;
select is(pg_temp.active_bindings(current_setting('t.d_a1')::uuid), 0::bigint, 'an unverified employer claim unbinds the phone');
update public.worker_enrollments set employer_status = 'VERIFIED', employer_confirmed_at = now(), employer_confirmed_by = current_setting('t.u_a_super')::uuid
 where id = current_setting('t.e_a1')::uuid;
select is(pg_temp.active_bindings(current_setting('t.d_a1')::uuid), 1::bigint, 'employer verification binds it again');

update public.projects set status = 'PAUSED' where id = current_setting('t.p_a1')::uuid;
select is(pg_temp.active_bindings(current_setting('t.d_a1')::uuid), 0::bigint, 'a paused project is not monitored');
update public.projects set status = 'ACTIVE' where id = current_setting('t.p_a1')::uuid;
select is(pg_temp.active_bindings(current_setting('t.d_a1')::uuid), 1::bigint, 'reactivation restores monitoring');

-- Worker a2 is approved and verified but never acknowledged the notice: a phone is not bound.
insert into public.device_installations (id, worker_id, platform, hardware_installation_hash, app_version)
values (current_setting('t.d_a2')::uuid, current_setting('t.w_a2')::uuid, 'ANDROID', repeat('d', 64), '0.1.0');
select is(pg_temp.active_bindings(current_setting('t.d_a2')::uuid), 0::bigint, 'no binding without an active consent');

-- ---------------------------------------------------------------------------------------------
-- Upload credential authentication (service role only)
-- ---------------------------------------------------------------------------------------------
select set_config('role', 'service_role', true);
select is(public.edge_device_authenticate(sha256('m07-active')) ->> 'status', 'OK', 'a valid secret authenticates');
select is(public.edge_device_authenticate(sha256('m07-active')) ->> 'worker_id', current_setting('t.w_a1')::uuid::text,
  'identity is derived from the credential (worker)');
select is(public.edge_device_authenticate(sha256('m07-active')) ->> 'device_id', current_setting('t.d_a1')::uuid::text,
  'identity is derived from the credential (device)');
select is(public.edge_device_authenticate(sha256('m07-revoked')) ->> 'status', 'REVOKED', 'a revoked secret is refused');
select is(public.edge_device_authenticate(sha256('m07-old-phone')) ->> 'status', 'REVOKED', 'a replaced phone is refused');
select is(public.edge_device_authenticate(sha256('never-issued')) ->> 'status', 'INVALID', 'an unknown secret is refused');
select is(public.edge_device_authenticate('\x00'::bytea) ->> 'status', 'INVALID', 'a malformed hash is refused');
select is((public.edge_device_authenticate(sha256('m07-rotated')) ->> 'renewable')::boolean, false,
  'a rotated secret still uploads during its overlap but cannot renew');
reset role;
update app_private.device_upload_credentials set overlap_until = now() - interval '1 minute' where token_sha256 = sha256('m07-rotated');
select set_config('role', 'service_role', true);
select is(public.edge_device_authenticate(sha256('m07-rotated')) ->> 'status', 'EXPIRED', 'a rotated secret is refused after its overlap');

select is(jsonb_array_length(public.edge_device_authenticate(sha256('m07-active')) -> 'fences'), 1,
  'one fence: the current version of the one bound project');
select is((public.edge_device_authenticate(sha256('m07-active')) #>> '{fences,0,projectId}'), current_setting('t.p_a1')::uuid::text,
  'the fence belongs to the bound project only (never project B)');
select is((public.edge_device_authenticate(sha256('m07-active')) #>> '{fences,0,nativeRadiusM}')::numeric, 200::numeric,
  'native fence radius = site radius 150 + exit hysteresis 50 (decision #45)');
select is((public.edge_device_authenticate(sha256('m07-active')) ->> 'coordinates_allowed')::boolean, true,
  'development databases allow onsite coordinates (egress gate testing)');
reset role;

-- A new configuration version: new arrivals use only the new fence; the still-open v1 session
-- keeps its v1 identifier resolvable for its exit.
insert into public.project_tracking_config_versions (id, project_id, version_number, effective_at, settings_json)
values (current_setting('t.cv_a1_v2')::uuid, current_setting('t.p_a1')::uuid, 2, now(),
        coalesce(tests.full_settings(250, false), '{"geofence_radius_m":250}'::jsonb));
insert into public.project_geofences (config_version_id, project_id, center, radius_m)
values (current_setting('t.cv_a1_v2')::uuid, current_setting('t.p_a1')::uuid,
        extensions.st_setsrid(extensions.st_makepoint(-95.3600, 29.7604), 4326)::extensions.geography, 250);
update public.projects set config_version_id = current_setting('t.cv_a1_v2')::uuid where id = current_setting('t.p_a1')::uuid;
select is((select config_version_id from public.device_project_bindings
            where device_id = current_setting('t.d_a1')::uuid and project_id = current_setting('t.p_a1')::uuid and revoked_at is null),
  current_setting('t.cv_a1_v2')::uuid, 'the binding follows the project''s current configuration');
select set_config('role', 'service_role', true);
select results_eq(
  $$select (f ->> 'configVersionId')::uuid, (f ->> 'current')::boolean
      from jsonb_array_elements(public.edge_device_authenticate(sha256('m07-active')) -> 'fences') f
     order by 2 desc$$,
  format($$values (%L::uuid, true), (%L::uuid, false)$$, current_setting('t.cv_a1_v2'), current_setting('t.cv_a1')::uuid),
  'current fence plus the version of the still-open session');
reset role;
update public.attendance_sessions set status = 'CLOSED', end_at = now(), end_source = 'GEOFENCE' where id = current_setting('t.s_a1')::uuid;
select set_config('role', 'service_role', true);
select results_eq(
  $$select (f ->> 'configVersionId')::uuid from jsonb_array_elements(public.edge_device_authenticate(sha256('m07-active')) -> 'fences') f$$,
  format($$values (%L::uuid)$$, current_setting('t.cv_a1_v2')),
  'once the session is closed, the old boundary is no longer accepted');
reset role;

-- ---------------------------------------------------------------------------------------------
-- Continuous coordinates: release gate (decision #90)
-- ---------------------------------------------------------------------------------------------
update app_private.settings set value = 'production' where key = 'environment';
update public.device_installations set app_version = '0.3.0' where id = current_setting('t.d_a1')::uuid;
select set_config('role', 'service_role', true);
select is((public.edge_device_authenticate(sha256('m07-active')) ->> 'coordinates_allowed')::boolean, false,
  'production refuses continuous coordinates without a real-device privacy sign-off');
reset role;
select ok(app_private.record_location_privacy_signoff('IOS', '0.3.0', 'Test reviewer', 'wire-capture-ios-0.3.0') is not null,
  'the database owner records a sign-off for one platform and app version');
select set_config('role', 'service_role', true);
select is((public.edge_device_authenticate(sha256('m07-active')) ->> 'coordinates_allowed')::boolean, true,
  'the signed-off iOS build may send onsite coordinates');
reset role;
update public.device_installations set app_version = '0.3.1' where id = current_setting('t.d_a1')::uuid;
select set_config('role', 'service_role', true);
select is((public.edge_device_authenticate(sha256('m07-active')) ->> 'coordinates_allowed')::boolean, false,
  'a different build is not covered by another build''s sign-off');
reset role;
select ok(not has_function_privilege('service_role', 'app_private.record_location_privacy_signoff(public.device_platform, text, text, text)', 'EXECUTE')
          and not has_function_privilege('authenticated', 'app_private.record_location_privacy_signoff(public.device_platform, text, text, text)', 'EXECUTE'),
  'no API role can record a privacy sign-off');
update app_private.settings set value = 'development' where key = 'environment';

-- ---------------------------------------------------------------------------------------------
-- Rate limits (60 requests/minute, 600 events/hour per device) and receipts
-- ---------------------------------------------------------------------------------------------
select set_config('role', 'service_role', true);
select is((select count(*) filter (where ok) from (select public.edge_device_rate_limit(current_setting('t.d_a1')::uuid, 25) ok from generate_series(1, 25)) x),
  24::bigint, '600 events per hour: the 25th batch of 25 is refused (HTTP 429)');
select is((select count(*) filter (where ok) from (select public.edge_device_rate_limit(current_setting('t.d_a2')::uuid, 1) ok from generate_series(1, 61)) x),
  60::bigint, '60 requests per minute: the 61st is refused');

select is(public.edge_record_location_terminals(
  '11111111-1111-4111-8111-111111111111',
  jsonb_build_array(jsonb_build_object(
    'event_uuid', '22222222-2222-4222-8222-222222222201', 'device_id', current_setting('t.d_a1')::uuid, 'worker_id', current_setting('t.w_a1')::uuid,
    'project_id', null, 'config_version_id', null, 'event_type', 'GEOFENCE_ENTER',
    'observed_at', now(), 'server_received_at', now(), 'accuracy_m', null,
    'qualification_state', 'NOT_APPLICABLE', 'terminal_result', 'rejected', 'rejection_reason', 'PROJECT_NOT_AUTHORIZED')),
  jsonb_build_array(jsonb_build_object(
    'event_uuid', '22222222-2222-4222-8222-222222222201', 'device_id', current_setting('t.d_a1')::uuid, 'reason', 'PROJECT_NOT_AUTHORIZED',
    'sanitized_payload', jsonb_build_object('event', 'geofence')))), 1,
  'a rejected record is stored durably with its reason and a sanitized quarantine copy');
select is(public.edge_record_location_terminals('11111111-1111-4111-8111-111111111112',
  jsonb_build_array(jsonb_build_object(
    'event_uuid', '22222222-2222-4222-8222-222222222201', 'device_id', current_setting('t.d_a1')::uuid, 'worker_id', current_setting('t.w_a1')::uuid,
    'event_type', 'GEOFENCE_ENTER', 'observed_at', now(), 'server_received_at', now(),
    'qualification_state', 'NOT_APPLICABLE', 'terminal_result', 'rejected', 'rejection_reason', 'PROJECT_NOT_AUTHORIZED')),
  '[]'::jsonb), 0, 'a retried record is idempotent (no second receipt)');
select throws_ok($$select public.edge_record_location_terminals(null,
  jsonb_build_array(jsonb_build_object('event_uuid', gen_random_uuid(), 'latitude', 29.7)), '[]'::jsonb)$$,
  '22023', 'COORDINATES_NOT_PERMITTED', 'a receipt can never carry coordinates');
select throws_ok(format($$select public.edge_record_location_terminals(null, '[]'::jsonb,
  jsonb_build_array(jsonb_build_object('event_uuid', gen_random_uuid(), 'device_id', %L::uuid, 'reason', 'X',
                                       'sanitized_payload', jsonb_build_object('coords', jsonb_build_object('latitude', 1)))))$$, current_setting('t.d_a1')::uuid),
  '23514', null, 'the quarantine refuses coordinates');
select results_eq(
  format($$select (r ->> 'same_device')::boolean from jsonb_array_elements(public.edge_location_receipt_lookup(%L::uuid,
    array['22222222-2222-4222-8222-222222222201'::uuid, gen_random_uuid()])) r$$, current_setting('t.d_a1')::uuid),
  $$values (true)$$, 'receipt lookup finds the durable outcome of this device''s record');
select results_eq(
  format($$select (r ->> 'same_device')::boolean from jsonb_array_elements(public.edge_location_receipt_lookup(%L::uuid,
    array['22222222-2222-4222-8222-222222222201'::uuid])) r$$, current_setting('t.d_a2')),
  $$values (false)$$, 'another device''s uuid is reported as foreign, not as its duplicate');
select is(public.edge_worker_open_session_projects(current_setting('t.w_b1')::uuid), array[current_setting('t.p_b1')::uuid],
  'projects with an active session are listed for the replacement review');

-- ---------------------------------------------------------------------------------------------
-- Renewal (decision #44): token path, user path, overlap, supersession, revocation
-- ---------------------------------------------------------------------------------------------
select is(public.edge_device_renew(sha256('m07-active'), null, sha256('m07-renewed-1'), '0.3.2') ->> 'status', 'OK',
  'the current secret renews headlessly');
reset role;
select ok((select c.rotated_from = (select id from app_private.device_upload_credentials where token_sha256 = sha256('m07-active'))
             and c.expires_at > now() + interval '29 days 23 hours'
             from app_private.device_upload_credentials c where c.token_sha256 = sha256('m07-renewed-1')),
  'the new secret lives 30 days and records what it rotated');
select ok((select c.overlap_until between now() + interval '23 hours 59 minutes' and now() + interval '24 hours 1 minute'
             from app_private.device_upload_credentials c where c.token_sha256 = sha256('m07-active')),
  'the previous secret keeps working for a 24 h overlap');
select set_config('role', 'service_role', true);
select is(public.edge_device_authenticate(sha256('m07-active')) ->> 'status', 'OK', 'in-flight batches with the old secret are still accepted');
select is(public.edge_device_renew(sha256('m07-active'), null, sha256('m07-renewed-x'), null) ->> 'status', 'SUPERSEDED',
  'a superseded secret cannot mint another one');
select is(public.edge_device_renew(sha256('m07-renewed-1'), null, sha256('m07-renewed-2'), null) ->> 'status', 'OK',
  'the newest secret renews again');
select is(public.edge_device_renew(sha256('m07-revoked'), null, sha256('m07-renewed-3'), null) ->> 'status', 'REVOKED',
  'a revoked secret cannot renew');
select is(public.edge_device_renew(null, current_setting('t.u_worker_a1')::uuid, sha256('m07-renewed-4'), null) ->> 'status', 'OK',
  'the signed-in worker renews their own phone in the foreground');
select is(public.edge_device_renew(null, current_setting('t.u_worker_b1')::uuid, sha256('m07-renewed-5'), null) ->> 'status', 'NO_DEVICE',
  'a worker without an active phone cannot renew');
select throws_ok($$select public.edge_device_renew(null, null, sha256('x'), null)$$, '22023', 'INVALID_RENEWAL',
  'exactly one of the secret or the user session is required');
reset role;
select is((select app_version from public.device_installations where id = current_setting('t.d_a1')::uuid), '0.3.2',
  'renewal records the reporting app version');
select ok(exists (select 1 from app_private.audit_logs where action = 'device.credential_renewed' and resource_id = current_setting('t.d_a1')::uuid),
  'every renewal is audited');

-- ---------------------------------------------------------------------------------------------
-- Worker tracking plan (own data only) and staff tracking health
-- ---------------------------------------------------------------------------------------------
select tests.authenticate_as(current_setting('t.u_worker_a1')::uuid, 'aal1');
select is((public.my_tracking_plan('0.3.2') ->> 'device_id')::uuid, current_setting('t.d_a1')::uuid, 'the plan describes the caller''s own phone');
select is((public.my_tracking_plan('0.3.2') #>> '{projects,0,identifier}'),
  (select sdk_identifier from public.project_geofences where config_version_id = current_setting('t.cv_a1_v2')::uuid),
  'the phone registers the current fence identifier');
select is((public.my_tracking_plan('0.3.2') #>> '{credential,status}'), 'OK', 'credential status is reported to the worker');

select tests.authenticate_as(current_setting('t.u_worker_a2')::uuid, 'aal1');
select is((public.my_tracking_plan(null) #>> '{not_monitored,0,reason}'), 'CONSENT_MISSING',
  'an unmonitored approved project explains why');

select tests.authenticate_as(current_setting('t.u_a_super')::uuid);
select throws_ok($$select public.my_tracking_plan(null)$$, '22023', 'WORKER_PROFILE_REQUIRED', 'staff have no tracking plan');
select ok((select bool_and((h ->> 'device') = case when (h ->> 'worker_id')::uuid in (current_setting('t.w_a1')::uuid, current_setting('t.w_a2')::uuid) then 'ACTIVE' else 'NO_DEVICE' end)
             from jsonb_array_elements(public.project_tracking_health(current_setting('t.p_a1')::uuid)) h),
  'assigned staff see device status per approved worker');
select tests.authenticate_as(current_setting('t.u_b_super')::uuid);
select throws_ok(format($$select public.project_tracking_health(%L)$$, current_setting('t.p_a1')::uuid), '42501', null,
  'another GC cannot read project A''s tracking health');

select * from finish();
rollback;
