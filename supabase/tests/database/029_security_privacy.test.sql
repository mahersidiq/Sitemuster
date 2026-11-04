-- Milestone 12: legal approval gates, consent off/on and renewal, account deletion and purge,
-- privacy maintenance, rate limits and the platform operator RPCs (docs/spec/09, 02, 05, 08;
-- decisions #123–#131).
begin;
select plan(73);
select tests.seed_world();

select set_config('t.muster_en', (select id::text from public.legal_notice_versions where document_id = 'MUSTER_SAFETY_LIMITATIONS_EN_V1'), true);
select set_config('t.muster_es', (select id::text from public.legal_notice_versions where document_id = 'MUSTER_SAFETY_LIMITATIONS_ES_V1'), true);
select set_config('t.muster_en_hash', (select content_hash from public.legal_notice_versions where document_id = 'MUSTER_SAFETY_LIMITATIONS_EN_V1'), true);
select set_config('t.muster_es_hash', (select content_hash from public.legal_notice_versions where document_id = 'MUSTER_SAFETY_LIMITATIONS_ES_V1'), true);

-- ---------------------------------------------------------------------------------------------
-- Platform operator: MFA, a reason, audit, and never people or positions
-- ---------------------------------------------------------------------------------------------
select tests.authenticate_as(tests.id('u_a_super'));
select throws_ok($$select public.operator_health('routine check')$$, '42501', 'FORBIDDEN', 'staff are not platform operators');
select tests.authenticate_as(tests.id('u_operator'), 'aal1');
select throws_ok($$select public.operator_health('routine check')$$, '42501', 'FORBIDDEN', 'an operator needs MFA (aal2)');
select tests.authenticate_as(tests.id('u_operator'));
select throws_ok($$select public.operator_health('  ')$$, '22023', 'REASON_REQUIRED', 'every operator action needs a reason');
select ok(public.operator_health('weekly health review') ?& array['jobs', 'location_receipts_last_hour', 'account_deletions'],
  'health returns counts, receipts and job runs');
select ok(public.operator_health('weekly health review')::text !~* '(Acosta|Avila|\+1555|example\.test|29\.76|-95\.36)',
  'health carries no names, phones, emails or coordinates');
select is(jsonb_array_length(public.operator_org_lookup('Alpha', 'support ticket 42')), 1, 'org lookup finds the organization');
select ok(public.operator_org_lookup('Alpha', 'support ticket 42')::text !~* '(Acosta|Avila|\+1555|example\.test|29\.76|-95\.36)',
  'org lookup returns metadata and counts only');
select is((select count(*)::int from public.latest_onsite_positions), 0, 'the operator reads no positions');
select is((select count(*)::int from public.emergency_contacts), 0, 'the operator reads no emergency contacts');
select throws_ok(format($$select public.project_map(%L)$$, tests.id('p_a1')), '42501', null, 'the operator cannot open the live map');
select throws_ok(format($$select public.muster_board(%L)$$, tests.id('m_a')), '42501', null, 'the operator cannot read a muster roster');
select tests.as_postgres();
select is((select count(*)::int from app_private.platform_operator_actions
            where platform_user_id = tests.id('u_operator') and length(reason) >= 3), 4,
  'every successful operator call is recorded with its reason');

-- ---------------------------------------------------------------------------------------------
-- Legal approvals: exact text, named reviewer, forward only; bilingual production gate
-- ---------------------------------------------------------------------------------------------
delete from app_private.settings;  -- an unmarked database is production
select tests.authenticate_as(tests.id('u_a_safety'));
select throws_ok(format($$select public.start_muster(%L, 'Drill', gen_random_uuid(), true)$$, tests.id('p_a1')),
  '22023', 'LEGAL_NOTICE_NOT_APPROVED', 'production refuses a muster while its safety limitations are drafts');
select tests.authenticate_as(tests.id('u_operator'));
select throws_ok(format($$select public.operator_approve_legal_notice(%L, %L, 'Avery Counsel', 'Safety counsel', 'Review 11', 'counsel signed off')$$,
                        current_setting('t.muster_en'), repeat('0', 64)),
  '22023', 'CONTENT_HASH_MISMATCH', 'an approval binds to the exact reviewed text');
select throws_ok(format($$select public.operator_approve_legal_notice(%L, %L, '', 'Safety counsel', null, 'counsel signed off')$$,
                        current_setting('t.muster_en'), current_setting('t.muster_en_hash')),
  '22023', 'REVIEWER_REQUIRED', 'an approval names the human reviewer');
select is(public.operator_approve_legal_notice(current_setting('t.muster_en')::uuid, current_setting('t.muster_en_hash'),
                                               'Avery Counsel', 'Safety counsel', 'Review 11', 'counsel signed off') ->> 'review_status',
  'APPROVED', 'the operator records the English approval');
select tests.authenticate_as(tests.id('u_a_safety'));
select throws_ok(format($$select public.start_muster(%L, 'Drill', gen_random_uuid(), true)$$, tests.id('p_a1')),
  '22023', 'LEGAL_NOTICE_NOT_APPROVED', 'one language is not enough: the Spanish text is still a draft');
select tests.authenticate_as(tests.id('u_operator'));
select lives_ok(format($$select public.operator_approve_legal_notice(%L, %L, 'Bea Consejera', 'Bilingual safety counsel', 'Review 11', 'counsel signed off')$$,
                       current_setting('t.muster_es'), current_setting('t.muster_es_hash')),
  'the operator records the Spanish approval');
select tests.authenticate_as(tests.id('u_a_safety'));
select is(public.start_muster(tests.id('p_a1'), 'Drill', gen_random_uuid(), true) ->> 'created', 'true',
  'with both languages approved, production allows the muster');
select tests.as_postgres();
select throws_ok(format($$update public.legal_notice_versions set reviewer_name = 'Someone Else' where id = %L$$, current_setting('t.muster_en')),
  '42501', null, 'approval details never change');
select throws_ok(format($$update public.legal_notice_versions set review_status = 'DRAFT_REQUIRES_HUMAN_REVIEW' where id = %L$$, current_setting('t.muster_en')),
  '42501', null, 'an approved text cannot go back to draft');
insert into app_private.settings (key, value) values ('environment', 'development');

-- A material change asks for consent again; a minor one does not.
insert into public.legal_notice_versions (id, document_id, locale, document_type, version, content, material_change) values
  ('aa000000-0000-4000-8000-0000000000e2', 'TEST_WORKER_NOTICE_EN_V2', 'en-US', 'WORKER_LOCATION_DISCLOSURE', 2, 'Synthetic test notice v2 (material change).', true);
select tests.authenticate_as(tests.id('u_operator'));
select is((public.operator_approve_legal_notice('aa000000-0000-4000-8000-0000000000e2',
             (select encode(sha256(convert_to('Synthetic test notice v2 (material change).', 'UTF8')), 'hex')),
             'Avery Counsel', 'Employment counsel', null, 'new notice version approved') ->> 'renewals_required')::int, 1,
  'approving a materially changed notice asks the worker who accepted v1 to accept it again');
select tests.as_postgres();
select is((select count(*)::int from public.device_project_bindings where device_id = tests.id('d_a1') and revoked_at is null), 0,
  'location stops until the worker accepts the new notice');
select tests.authenticate_as(tests.id('u_worker_a1'), 'aal1');
select is((select r ->> 'reason' from jsonb_array_elements(public.my_tracking_plan() -> 'not_monitored') r
            where r ->> 'project_id' = tests.id('p_a1')::text), 'CONSENT_RENEWAL_REQUIRED', 'the phone is told why');
select is((select (c -> 'renewal_notice' ->> 'id') from jsonb_array_elements(public.my_consents()) c), 'aa000000-0000-4000-8000-0000000000e2',
  'the worker is shown the new notice to accept');
select throws_ok(format($$select public.set_my_location_consent(%L, true)$$, tests.id('p_a1')),
  '22023', 'CONSENT_RENEWAL_REQUIRED', 'location cannot simply be switched back on before accepting');
select is(public.renew_my_consent(tests.id('p_a1'), 'aa000000-0000-4000-8000-0000000000e2', true) ->> 'location_enabled', 'true',
  'accepting the new notice turns location back on');
select tests.as_postgres();
select is((select count(*)::int from public.device_project_bindings where device_id = tests.id('d_a1') and revoked_at is null), 1,
  'the phone is bound to the project again');
select is((select count(*)::int from public.tracking_consents where worker_id = tests.id('w_a1') and withdrawal_reason = 'REPLACED'), 1,
  'the earlier acknowledgement is kept as history');
insert into public.legal_notice_versions (id, document_id, locale, document_type, version, content, material_change) values
  ('aa000000-0000-4000-8000-0000000000e3', 'TEST_WORKER_NOTICE_EN_V3', 'en-US', 'WORKER_LOCATION_DISCLOSURE', 3, 'Synthetic test notice v3 (typo fix).', false);
select tests.authenticate_as(tests.id('u_operator'));
select is((public.operator_approve_legal_notice('aa000000-0000-4000-8000-0000000000e3',
             (select encode(sha256(convert_to('Synthetic test notice v3 (typo fix).', 'UTF8')), 'hex')),
             'Avery Counsel', 'Employment counsel', null, 'typo fix approved') ->> 'renewals_required')::int, 0,
  'a non-material correction does not ask anyone to accept again');

-- ---------------------------------------------------------------------------------------------
-- Location off/on per project: kiosk and foreman stay available
-- ---------------------------------------------------------------------------------------------
select tests.authenticate_as(tests.id('u_worker_a1'), 'aal1');
select is(public.set_my_location_consent(tests.id('p_a1'), false) ->> 'location_enabled', 'false', 'the worker switches location off');
select tests.as_postgres();
select is((select count(*)::int from public.device_project_bindings where device_id = tests.id('d_a1') and revoked_at is null), 0,
  'the phone stops uploading for that project at once');
select is((select (w ->> 'eligible')::boolean from jsonb_array_elements(public.edge_operation_workers(tests.id('p_a1'), array[tests.id('w_a1')])) w),
  true, 'kiosk and foreman attendance stay available (spec 09)');
select tests.authenticate_as(tests.id('u_worker_a1'), 'aal1');
select is((select r ->> 'reason' from jsonb_array_elements(public.my_tracking_plan() -> 'not_monitored') r
            where r ->> 'project_id' = tests.id('p_a1')::text), 'LOCATION_WITHDRAWN', 'the phone shows location as switched off');
select is(public.set_my_location_consent(tests.id('p_a1'), true) ->> 'location_enabled', 'true', 'and back on');
select tests.authenticate_as(tests.id('u_worker_a2'), 'aal1');
select throws_ok(format($$select public.set_my_location_consent(%L, false)$$, tests.id('p_a1')),
  '22023', 'CONSENT_REQUIRED', 'a worker changes only their own consent');
select ok(length(public.legal_document_text('ACCOUNT_DELETION_RETENTION', 'es-US') ->> 'content') > 200,
  'the deletion text is readable in the worker''s language');
select is(public.legal_document_text('ACCOUNT_DELETION_RETENTION', 'es-US') ->> 'document_id', 'ACCOUNT_DELETION_RETENTION_ES_V1',
  'it is the Spanish draft');
select throws_ok($$select public.legal_document_text('WORKER_LOCATION_DISCLOSURE', 'en-US')$$, '42501', 'FORBIDDEN',
  'only the global texts are served this way');

-- ---------------------------------------------------------------------------------------------
-- Account deletion: immediate revocation, then identity removal
-- ---------------------------------------------------------------------------------------------
select tests.as_postgres();
insert into public.device_installations (id, worker_id, platform, hardware_installation_hash, active)
values ('5d000000-0000-4000-8000-0000000000a2', tests.id('w_a2'), 'ANDROID', repeat('c', 64), true);
insert into app_private.device_upload_credentials (device_id, token_sha256, expires_at)
values ('5d000000-0000-4000-8000-0000000000a2', sha256('worker-a2-upload-token'::bytea), now() + interval '20 days');
insert into app_private.push_tokens (auth_user_id, installation_id, expo_token, platform)
values (tests.id('u_worker_a2'), 'install-a2-0001', 'ExponentPushToken[workera2token0001]', 'ANDROID');
insert into public.attendance_sessions (id, project_id, worker_id, employer_snapshot_id, start_at, end_at, start_source, end_source,
                                        config_version_id, status, iana_timezone)
values ('6a000000-0000-4000-8000-0000000000a2', tests.id('p_a1'), tests.id('w_a2'), tests.id('c_a'), now() - interval '2 days',
        now() - interval '2 days' + interval '8 hours', 'FOREMAN', 'FOREMAN', tests.id('cv_a1'), 'CLOSED', 'America/Chicago');

select is(public.edge_request_account_deletion(tests.id('u_worker_a2'), 'aal1') ->> 'status', 'REQUESTED', 'a worker asks to delete their account');
select is((select count(*)::int from app_private.device_upload_credentials
            where device_id = '5d000000-0000-4000-8000-0000000000a2' and revoked_at is null), 0, 'the upload credential is revoked at once');
select is((select active from public.device_installations where id = '5d000000-0000-4000-8000-0000000000a2'), false, 'the phone is deactivated');
select is((select count(*)::int from app_private.push_tokens where auth_user_id = tests.id('u_worker_a2') and revoked_at is null), 0,
  'muster alerts stop');
select is((select enrollment_status::text from public.worker_enrollments where id = tests.id('e_a2')), 'REVOKED', 'the enrollment is revoked');
select is(public.edge_request_account_deletion(tests.id('u_worker_a2'), 'aal1') ->> 'duplicate', 'true', 'asking twice is the same request');
select tests.authenticate_as(tests.id('u_worker_a2'), 'aal1');
select is((select count(*)::int from public.worker_profiles), 0, 'even an unexpired session reads nothing any more');
select tests.as_postgres();
select throws_ok(format($$select public.edge_request_account_deletion(%L, 'aal2')$$, tests.id('u_a_owner')),
  '22023', 'ORG_OWNER_TRANSFER_REQUIRED', 'an organization owner transfers the organization first');
select throws_ok(format($$select public.edge_request_account_deletion(%L, 'aal2')$$, tests.id('u_operator')),
  '42501', 'FORBIDDEN', 'a platform operator is not deleted through the app');
select is(app_private.process_account_deletions(now()), 0, 'nothing is removed before the 24-hour window');
select is(app_private.process_account_deletions(now() + interval '25 hours'), 1, 'the request is processed after it');
select is((select legal_name ~ '^Deleted worker #[0-9a-f]{8}$' and phone is null and auth_user_id is null and deleted_at is not null
             from public.worker_profiles where id = tests.id('w_a2')), true, 'the identity is replaced by a pseudonym');
select is((select count(*)::int from auth.users where id = tests.id('u_worker_a2')), 0, 'the sign-in account is gone');
select is((select count(*)::int from public.attendance_sessions where worker_id = tests.id('w_a2')), 0,
  'without a documented retention basis the attendance is deleted');

-- A documented retention basis keeps attendance under the pseudonym; a legal hold postpones.
select tests.authenticate_as(tests.id('u_operator'));
select ok(public.operator_set_retention_hold(tests.id('org_a'), null, 'CONTRACT_RETENTION', 'Prime contract §12 requires 2-year time records',
                                             'customer provided the contract clause') ? 'hold_id',
  'the operator records a contract retention basis for the organization');
select set_config('t.legal_hold', (public.operator_set_retention_hold(tests.id('org_a'), tests.id('p_a1'), 'LEGAL_HOLD',
                                    'Incident 2026-11-01 investigation', 'counsel requested a hold') ->> 'hold_id'), true);
select tests.as_postgres();
select is(public.edge_request_account_deletion(tests.id('u_worker_a1'), 'aal1') ->> 'status', 'REQUESTED', 'a worker under a legal hold asks to delete');
select is(app_private.process_account_deletions(now() + interval '25 hours'), 0, 'the legal hold postpones identity removal');
select tests.authenticate_as(tests.id('u_operator'));
select ok(public.operator_release_retention_hold(current_setting('t.legal_hold')::uuid, 'investigation closed') ? 'released_at',
  'the hold is released');
select tests.as_postgres();
select is(app_private.process_account_deletions(now() + interval '25 hours'), 1, 'then the identity is removed');
select is((select count(*)::int from public.attendance_sessions where worker_id = tests.id('w_a1')), 1,
  'attendance is kept under the contract basis');
select is((select legal_name ~ '^Deleted worker #' from public.worker_profiles where id = tests.id('w_a1')), true,
  'and points only at the pseudonym');
select is((select count(*)::int from public.emergency_contacts where worker_profile_id = tests.id('w_a1')), 0, 'the emergency contact is removed');
select is((select count(*)::int from public.latest_onsite_positions where worker_id = tests.id('w_a1')), 0, 'the last position is removed');

-- A staff member's assignments end at once.
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret)
values (gen_random_uuid(), tests.id('u_a_super'), 'phone', 'totp', 'verified', now(), now(), 'JBSWY3DPEHPK3PXQ');
select throws_ok(format($$select public.edge_request_account_deletion(%L, 'aal1')$$, tests.id('u_a_super')),
  '42501', 'MFA_REQUIRED', 'someone with an authenticator must use it to delete their account');
select is(public.edge_request_account_deletion(tests.id('u_a_super'), 'aal2') ->> 'status', 'REQUESTED', 'a superintendent asks to delete');
select is((select count(*)::int from public.project_staff where user_id = tests.id('u_a_super') and status = 'ACTIVE'), 0,
  'their project assignments are revoked at once');

-- ---------------------------------------------------------------------------------------------
-- Operator device, invitation and MFA tools
-- ---------------------------------------------------------------------------------------------
insert into public.organization_invitations (id, organization_id, target_email, role, expires_at, token_hash)
values ('ac000000-0000-4000-8000-0000000000a1', tests.id('org_a'), 'new.admin@example.test', 'ADMIN', now() + interval '1 day',
        sha256('invitation-token'::bytea));
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret)
values (gen_random_uuid(), tests.id('u_a_pm'), 'lost phone', 'totp', 'verified', now(), now(), 'JBSWY3DPEHPK3PXP');
select tests.authenticate_as(tests.id('u_operator'));
select ok((public.operator_resend_invitation('ac000000-0000-4000-8000-0000000000a1', 'admin did not see the invite') ->> 'expires_at')::timestamptz
            > now() + interval '7 days', 'a pending invitation is re-armed for 7 more days');
select is((public.operator_reset_staff_mfa(tests.id('u_a_pm'), 'identity verified by video call, ticket 77') ->> 'factors_removed')::int, 1,
  'a staff member who lost their authenticator can enroll again');
select throws_ok(format($$select public.operator_reset_staff_mfa(%L, 'self service')$$, tests.id('u_operator')),
  '42501', 'FORBIDDEN', 'an operator never resets an operator');

-- ---------------------------------------------------------------------------------------------
-- Privacy maintenance and rate limits
-- ---------------------------------------------------------------------------------------------
select tests.as_postgres();
select app_private.ensure_raw_fix_partitions(current_date - 1, 3);
insert into app_private.raw_onsite_fixes (event_uuid, project_id, worker_id, point, accuracy_m, observed_at, received_at, expires_at) values
  (gen_random_uuid(), tests.id('p_b1'), tests.id('w_b1'), extensions.st_setsrid(extensions.st_makepoint(-74.0061, 40.7129), 4326)::extensions.geography,
   10, now() - interval '23 hours', now() - interval '23 hours', now() - interval '1 hour'),
  (gen_random_uuid(), tests.id('p_b1'), tests.id('w_b1'), extensions.st_setsrid(extensions.st_makepoint(-74.0061, 40.7129), 4326)::extensions.geography,
   10, now(), now(), now() + interval '20 hours');
insert into app_private.rate_limit_buckets (bucket, subject, window_start, hits) values ('old_bucket', 'x', now() - interval '3 days', 5);
select ok((app_private.privacy_maintenance(now()) ->> 'raw_fixes_purged')::int >= 1, 'the hourly maintenance purges expired raw fixes');
select is((select count(*)::int from app_private.raw_onsite_fixes), 1, 'a fix younger than its 24-hour limit stays until it expires');
select is((select count(*)::int from app_private.rate_limit_buckets where bucket = 'old_bucket'), 0, 'old rate-limit counters are removed');
select is((select count(*)::int from cron.job where jobname = 'sitemuster-privacy-maintenance' and schedule = '17 * * * *'), 1,
  'the maintenance runs every hour');
insert into app_private.rate_limit_buckets (bucket, subject, window_start, hits)
values ('push_token_hour', tests.id('u_worker_b1')::text, date_bin(interval '1 hour', now(), timestamptz '2000-01-01'), 20);
select tests.authenticate_as(tests.id('u_worker_b1'), 'aal1');
select throws_ok($$select public.register_push_token('install-b1-0001', 'ExponentPushToken[workerb1token0001]', 'IOS')$$,
  '22023', 'RATE_LIMITED', 'push registration is rate limited per person');

select * from finish();
rollback;
