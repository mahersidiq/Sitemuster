-- Milestone 12 (part 2): the secrets inventory and its protection, the remaining rate limits
-- (report exports, phone activation), security flags (flag, never erase) and secrets hygiene
-- (docs/spec/09-security-privacy.md; decisions #132–#135; docs/security/secrets-audit.md).
begin;
select plan(44);
select tests.seed_world();

-- ---------------------------------------------------------------------------------------------
-- Secrets audit: every secret-like column is known, hashed, encrypted or private
-- ---------------------------------------------------------------------------------------------
select is(
  (select coalesce(array_agg(x order by x), '{}'::text[]) from (
     select c.table_schema || '.' || c.table_name || '.' || c.column_name as x
       from information_schema.columns c
       join information_schema.tables t
         on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
      where c.table_schema in ('public', 'app_private')
        and c.column_name ~* '(^|_)(secret|secrets|token|tokens|password|passcode|otp|pin|credential|credentials|nonce|mac|key|code|hash|sha256|ciphertext|signature)(_|$)') s
    where x not in (
      -- One-way SHA-256 of a random value (the value itself is never stored)
      'app_private.device_upload_credentials.token_sha256', 'app_private.orientation_invites.invite_token_hash',
      'app_private.orientation_join_grants.token_hash', 'public.organization_invitations.token_hash',
      'public.orientation_sessions.static_code_hash', 'public.worker_badges.opaque_badge_hash',
      'public.device_installations.hardware_installation_hash',
      -- Encrypted at rest with an Edge Function secret (AES-256-GCM)
      'app_private.device_badge_secrets.secret_ciphertext', 'app_private.device_badge_secrets.key_version',
      -- Private, short-lived plaintext (needed to show the QR / send the push); deleted on close or revoke
      'app_private.orientation_session_secrets.rotating_secret', 'app_private.orientation_session_secrets.static_code',
      'app_private.push_tokens.expo_token',
      -- Local development only (supabase/seed.sql; never on a hosted project)
      'app_private.dev_sms_outbox.otp',
      -- Not secrets: integrity hashes, idempotency keys, references and setting names
      'public.legal_notice_versions.content_hash', 'public.muster_events.roster_snapshot_hash',
      'public.project_tracking_config_versions.sha256', 'public.muster_events.incident_key',
      'public.orientation_sessions.rotating_secret_id', 'app_private.settings.key',
      'public.muster_events.idempotency_key', 'public.organizations.idempotency_key',
      'public.orientation_sessions.idempotency_key', 'public.project_tracking_config_versions.idempotency_key',
      'public.projects.idempotency_key', 'public.visitor_visits.exit_idempotency_key',
      'public.visitor_visits.idempotency_key', 'public.worker_profiles.idempotency_key')),
  '{}'::text[],
  'every secret-like column is in the audited inventory (docs/security/secrets-audit.md)');
select is(
  (select count(*)::int
     from unnest(array['device_upload_credentials', 'device_badge_secrets', 'orientation_session_secrets',
                       'orientation_join_grants', 'orientation_invites', 'push_tokens', 'security_flags',
                       'rate_limit_buckets', 'account_deletion_requests', 'retention_holds']) t(name)
     cross join unnest(array['anon', 'authenticated', 'service_role']) r(role)
    where has_table_privilege(r.role, 'app_private.' || t.name, 'SELECT,INSERT,UPDATE,DELETE')),
  0, 'no API role can read or write the private secret tables directly');
select is(
  (select count(*)::int
     from (values ('organization_invitations', 'token_hash'), ('orientation_sessions', 'static_code_hash'),
                  ('orientation_sessions', 'rotating_secret_id'), ('worker_badges', 'opaque_badge_hash'),
                  ('device_installations', 'hardware_installation_hash')) v(t, c)
     cross join unnest(array['anon', 'authenticated']) r(role)
    where has_column_privilege(r.role, 'public.' || v.t, v.c, 'SELECT')),
  0, 'hash columns in shared tables are not readable through the API');
select is(
  (select count(*)::int from pg_constraint k join pg_namespace n on n.oid = k.connamespace
    where k.contype = 'c' and n.nspname in ('public', 'app_private')
      and pg_get_constraintdef(k.oid) ~ 'length\((token_sha256|token_hash|invite_token_hash|static_code_hash|opaque_badge_hash)\) = 32'),
  6, 'every stored credential hash is exactly a 32-byte SHA-256');

-- ---------------------------------------------------------------------------------------------
-- Rate-limit saturation becomes a flag; flags are evidence (never edited, never auto-erased)
-- ---------------------------------------------------------------------------------------------
select is(array[app_private.consume_rate_limit('test_bucket', 'subject-1', 2, 3600),
                app_private.consume_rate_limit('test_bucket', 'subject-1', 2, 3600),
                app_private.consume_rate_limit('test_bucket', 'subject-1', 2, 3600)],
  array[true, true, false], 'a per-subject limit allows up to the limit, then refuses');
select is(array[app_private.consume_rate_limit_units('test_units', 'device-1', 5, 8, 3600),
                app_private.consume_rate_limit_units('test_units', 'device-1', 5, 8, 3600)],
  array[true, false], 'a unit budget refuses a batch that would not fit');
select is((select hits from app_private.rate_limit_buckets where bucket = 'test_units' and subject = 'device-1'), 5,
  'the refused batch is not counted');
select ok((select denied_at is not null from app_private.rate_limit_buckets where bucket = 'test_units' and subject = 'device-1'),
  'the refusal is remembered');
select is(app_private.record_security_flags(), 2, 'both saturated subjects are flagged');
select is(app_private.record_security_flags(), 0, 'flagging again raises nothing new');
select is((select array[hits, limit_hits] from app_private.security_flags where bucket = 'test_bucket'), array[3, 2],
  'the flag keeps how far over the limit the subject went');
select throws_ok($$update app_private.security_flags set hits = 0 where bucket = 'test_bucket'$$,
  '42501', 'SECURITY_FLAG_IMMUTABLE', 'flag evidence cannot be edited');
select throws_ok($$delete from app_private.security_flags where bucket = 'test_bucket'$$,
  '42501', 'SECURITY_FLAG_OPEN', 'an open flag cannot be deleted');
select is((app_private.privacy_maintenance(now() + interval '3 days') ->> 'rate_limit_buckets_purged')::int >= 2, true,
  'old buckets are purged by the hourly job');
select is((select count(*)::int from app_private.security_flags where bucket in ('test_bucket', 'test_units')), 2,
  'the flags survive the purge (evidence is not erased)');

-- ---------------------------------------------------------------------------------------------
-- Report exports: the worker's own hours (CSV source) and staff report generation
-- ---------------------------------------------------------------------------------------------
select tests.authenticate_as(tests.id('u_worker_a1'), 'aal1');
select is(public.my_attendance(tests.id('p_a1'), now() - interval '7 days', now()) -> 'project' ->> 'name', 'Alpha Tower',
  'the worker reads their own hours');
select tests.as_postgres();
insert into app_private.rate_limit_buckets (bucket, subject, window_start, hits, limit_hits)
values ('attendance_export_hour', tests.id('w_a1')::text,
        date_bin(interval '1 hour', now(), timestamptz '2000-01-01'), 300, 300)
on conflict (bucket, subject, window_start) do update set hits = 300, limit_hits = 300;
select tests.authenticate_as(tests.id('u_worker_a1'), 'aal1');
select throws_ok(format($$select public.my_attendance(%L, now() - interval '7 days', now())$$, tests.id('p_a1')),
  '22023', 'RATE_LIMITED', 'the hourly export budget is enforced per worker');
select tests.authenticate_as(tests.id('u_a_super'));
select is(public.consume_report_budget(), true, 'staff report generation has an hourly budget');
select tests.as_postgres();
update app_private.rate_limit_buckets set hits = 240
 where bucket = 'report_hour' and subject = tests.id('u_a_super')::text;
select tests.authenticate_as(tests.id('u_a_super'));
select is(public.consume_report_budget(), false, 'past the budget the daily-reports function answers 429');
select tests.authenticate_as_anon();
select throws_ok($$select public.consume_report_budget()$$, '42501', null, 'anonymous callers have no report budget');
select tests.as_postgres();
select is((select count(*)::int from app_private.security_flags where bucket in ('attendance_export_hour', 'report_hour')), 0,
  'not flagged yet (flags are raised by the hourly job or a health check)');
select is(app_private.record_security_flags(), 2, 'both export limits are flagged for review');

-- ---------------------------------------------------------------------------------------------
-- Phone activation: rate-limited, refused once account deletion was requested
-- ---------------------------------------------------------------------------------------------
insert into app_private.rate_limit_buckets (bucket, subject, window_start, hits, limit_hits)
values ('device_activate_hour', tests.id('u_worker_a1')::text,
        date_bin(interval '1 hour', now(), timestamptz '2000-01-01'), 10, 10);
select set_config('t.u_worker_a1', tests.id('u_worker_a1')::text, true);
select set_config('t.u_worker_a2', tests.id('u_worker_a2')::text, true);
select set_config('role', 'service_role', true);
select throws_ok(format($$select public.edge_activate_device(%L, gen_random_uuid(), 'IOS', repeat('c', 64), '1.0', '\x00'::bytea, 1::smallint, decode(repeat('ab', 32), 'hex'))$$,
                        current_setting('t.u_worker_a1')),
  '22023', 'RATE_LIMITED', 'at most ten activations an hour per person');
reset role;
select tests.as_postgres();
select ok((select active from public.device_installations where id = tests.id('d_a1')), 'the current phone stays active');
insert into app_private.account_deletion_requests (auth_user_id, worker_profile_id, process_after)
values (tests.id('u_worker_a2'), tests.id('w_a2'), now() + interval '1 day');
select set_config('role', 'service_role', true);
select throws_ok(format($$select public.edge_activate_device(%L, gen_random_uuid(), 'IOS', repeat('d', 64), '1.0', '\x00'::bytea, 1::smallint, decode(repeat('cd', 32), 'hex'))$$,
                        current_setting('t.u_worker_a2')),
  '42501', 'FORBIDDEN', 'a person who asked to delete their account cannot activate a phone');
reset role;
select tests.as_postgres();
select is((select count(*)::int from public.device_installations where worker_id = tests.id('w_a2')), 0,
  'no device or credential was created for them');
select tests.authenticate_as(tests.id('u_worker_a2'), 'aal1');
select is(public.get_my_access() ->> 'account_deletion_pending', 'true',
  'signing in again during the deletion window: the app is told the account is being deleted');
select is(public.get_my_access() ->> 'worker_profile_id', null, 'and is shown no worker profile');
select tests.authenticate_as(tests.id('u_worker_a1'), 'aal1');
select is(public.get_my_access() ->> 'account_deletion_pending', 'false', 'everyone else is unaffected');
select tests.as_postgres();

-- ---------------------------------------------------------------------------------------------
-- Secrets hygiene (hourly)
-- ---------------------------------------------------------------------------------------------
select tests.authenticate_as(tests.id('u_a_super'));
select set_config('t.session', public.start_orientation_session(tests.id('p_a1'), gen_random_uuid()) ->> 'session_id', true);
select tests.as_postgres();
select is((select count(*)::int from app_private.orientation_session_secrets where session_id = current_setting('t.session')::uuid), 1,
  'an open orientation session holds its QR secrets');
insert into app_private.device_badge_secrets (device_id, secret_ciphertext, key_version, revoked_at) values
  (tests.id('d_a1_old'), '\x01'::bytea, 1, now() - interval '25 hours'),
  (tests.id('d_a1'), '\x02'::bytea, 1, null);
insert into app_private.push_tokens (auth_user_id, installation_id, expo_token, platform, revoked_at) values
  (tests.id('u_worker_a1'), 'install-old-0001', 'ExponentPushToken[old-revoked]', 'IOS', now() - interval '25 hours'),
  (tests.id('u_worker_a1'), 'install-new-0002', 'ExponentPushToken[current]', 'IOS', null);
insert into app_private.orientation_join_grants (token_hash, user_id, session_id, created_at, expires_at)
values (decode(repeat('ee', 32), 'hex'), tests.id('u_worker_a1'), current_setting('t.session')::uuid,
        now() - interval '9 days', now() - interval '8 days');
select is(app_private.purge_expired_secrets(now() + interval '3 hours') ->> 'orientation_sessions_expired', '1',
  'a session that ran past its 120 minutes is expired by the job');
select is((select status::text from public.orientation_sessions where id = current_setting('t.session')::uuid), 'EXPIRED',
  'it is marked EXPIRED');
select is((select count(*)::int from app_private.orientation_session_secrets where session_id = current_setting('t.session')::uuid), 0,
  'its rotating key and printed code are deleted');
select is((select array_agg(device_id order by device_id) from app_private.device_badge_secrets
            where device_id in (tests.id('d_a1_old'), tests.id('d_a1'))), array[tests.id('d_a1')],
  'a badge key revoked more than a day ago is deleted; the active one stays');
select is((select array_agg(expo_token) from app_private.push_tokens where auth_user_id = tests.id('u_worker_a1')),
  array['ExponentPushToken[current]'], 'a revoked push token is deleted after a day; the current one stays');
select is((select count(*)::int from app_private.orientation_join_grants where token_hash = decode(repeat('ee', 32), 'hex')), 0,
  'expired orientation join passes are deleted after a week');

-- ---------------------------------------------------------------------------------------------
-- Operator: list and review flags (MFA, reason, audit; pseudonymous ids only)
-- ---------------------------------------------------------------------------------------------
select set_config('t.flag', (select id::text from app_private.security_flags where bucket = 'test_bucket'), true);
select tests.authenticate_as(tests.id('u_a_owner'));
select throws_ok($$select public.operator_list_security_flags('weekly flag review')$$, '42501', 'FORBIDDEN',
  'customers cannot read security flags');
select tests.authenticate_as(tests.id('u_operator'), 'aal1');
select throws_ok($$select public.operator_list_security_flags('weekly flag review')$$, '42501', 'FORBIDDEN',
  'the operator needs MFA');
select tests.authenticate_as(tests.id('u_operator'));
select is((select count(*)::int from jsonb_array_elements(public.operator_list_security_flags('weekly flag review')) f
            where f ->> 'bucket' in ('test_bucket', 'test_units', 'attendance_export_hour', 'report_hour', 'device_activate_hour')), 5,
  'the operator lists the open flags');
select ok(public.operator_list_security_flags('weekly flag review')::text !~* '(Acosta|Avila|\+1555|example\.test|29\.76|-95\.36)',
  'flags carry pseudonymous ids and counts only');
select is(public.operator_review_security_flag(current_setting('t.flag')::uuid, 'synthetic test traffic', 'flag review') ->> 'status',
  'REVIEWED', 'the operator records a review with a note');
select throws_ok(format($$select public.operator_review_security_flag(%L, 'again', 'flag review')$$, current_setting('t.flag')),
  '22023', 'ALREADY_REVIEWED', 'a review is recorded once');
select ok(public.operator_health('weekly health review') ?& array['security_flags_open', 'secrets_overdue'],
  'the health check shows open flags and overdue secrets');
select tests.as_postgres();
select is((select count(*)::int from app_private.platform_operator_actions
            where platform_user_id = tests.id('u_operator') and action in ('SECURITY_FLAGS_LIST', 'SECURITY_FLAG_REVIEW')), 3,
  'every flag list and review is audited');

select * from finish();
rollback;
