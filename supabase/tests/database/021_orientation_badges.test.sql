-- Milestone 05: orientation sessions (rotating + printed QR), join → ORIENTATION_COMPLETED +
-- PENDING (never approval), notice gating, bulk approval ≤ 100, employer confirmation, supervised
-- no-phone profiles, printed badges, device activation and badge-step replay protection.
begin;
select plan(87);
select tests.seed_world();

select tests.create_user('99000000-0000-4000-8000-0000000000b1', null, '15550001111');
select tests.create_user('99000000-0000-4000-8000-0000000000b2', null, '15550001112');
select tests.create_user('99000000-0000-4000-8000-0000000000b3', null, '15550001113');

-- Rotating code for a session and step, computed independently of the app (test superuser only).
create function pg_temp.rot(p_session uuid, p_step bigint) returns text language sql as $$
  select 'SMO1.' || p_session || '.' || p_step || '.' ||
         left(app_private.b64url(extensions.hmac(convert_to('SMO1|' || p_session || '|' || p_step, 'UTF8'),
              (select rotating_secret from app_private.orientation_session_secrets where session_id = p_session), 'sha256')), 22)
$$;

-- Who may start a session.
select tests.authenticate_as(tests.id('u_a_attendant'));
select throws_ok(format($$select public.start_orientation_session(%L, gen_random_uuid())$$, tests.id('p_a1')), '42501', 'FORBIDDEN', 'kiosk attendant cannot start orientation');
select tests.authenticate_as(tests.id('u_b_owner'));
select throws_ok(format($$select public.start_orientation_session(%L, gen_random_uuid())$$, tests.id('p_a1')), '42501', 'FORBIDDEN', 'another GC cannot start orientation on this project');
select tests.authenticate_as(tests.id('u_a_super'), 'aal1');
select throws_ok(format($$select public.start_orientation_session(%L, gen_random_uuid())$$, tests.id('p_a1')), '42501', 'FORBIDDEN', 'superintendent without MFA cannot start orientation');
select tests.authenticate_as(tests.id('u_worker_a1'), 'aal1');
select throws_ok(format($$select public.start_orientation_session(%L, gen_random_uuid())$$, tests.id('p_a1')), '42501', 'FORBIDDEN', 'workers cannot start orientation');

select tests.authenticate_as(tests.id('u_a_super'));
select set_config('t.s1', public.start_orientation_session(tests.id('p_a1'), '11111111-aaaa-4aaa-8aaa-0000000000f1') ->> 'session_id', false);
select is(public.start_orientation_session(tests.id('p_a1'), '11111111-aaaa-4aaa-8aaa-0000000000f1') ->> 'session_id', current_setting('t.s1'), 'a retried start returns the same session');
select ok((public.get_orientation_session(current_setting('t.s1')::uuid) ->> 'static_code') ~ '^[A-Za-z0-9_-]{43}$', 'printed code is 32 random bytes');
select is(jsonb_array_length(public.list_orientation_sessions(tests.id('p_a1'))), 1, 'staff can list recent sessions');

select tests.as_postgres();
select is((select expires_at - starts_at from public.orientation_sessions where id = current_setting('t.s1')::uuid), interval '120 minutes', 'session lasts 120 minutes');
select ok((select s.static_code_hash = pg_catalog.sha256(convert_to(k.static_code, 'UTF8'))
             from public.orientation_sessions s join app_private.orientation_session_secrets k on k.session_id = s.id
            where s.id = current_setting('t.s1')::uuid), 'the session row stores only the hash of the printed code');
select set_config('t.rot', pg_temp.rot(current_setting('t.s1')::uuid, floor(extract(epoch from now()) / 60)::bigint), false);
select set_config('t.rot_prev', pg_temp.rot(current_setting('t.s1')::uuid, floor(extract(epoch from now()) / 60)::bigint - 1), false);
select set_config('t.rot_old', pg_temp.rot(current_setting('t.s1')::uuid, floor(extract(epoch from now()) / 60)::bigint - 2), false);
select set_config('t.static', (select 'SMS1.' || session_id || '.' || static_code from app_private.orientation_session_secrets
                                where session_id = current_setting('t.s1')::uuid), false);
select set_config('t.es_notice', (select id::text from public.legal_notice_versions where document_id = 'WORKER_LOCATION_DISCLOSURE_ES_V1'), false);

-- Worker preview.
select tests.authenticate_as('99000000-0000-4000-8000-0000000000b1', 'aal1');
select is(public.preview_orientation(current_setting('t.rot'), 'en-US') ->> 'project_name', 'Alpha Tower', 'worker previews the project from the rotating QR');
select is(public.preview_orientation(current_setting('t.rot_prev'), 'en-US') ->> 'project_name', 'Alpha Tower', 'the previous 60-second code is still accepted (±1 step)');
select is(public.preview_orientation(current_setting('t.static'), 'es-US') -> 'notice' ->> 'document_id', 'WORKER_LOCATION_DISCLOSURE_ES_V1', 'printed QR shows the Spanish disclosure');
select is(public.preview_orientation(current_setting('t.static'), 'es-US') -> 'notice' ->> 'review_status', 'DRAFT_REQUIRES_HUMAN_REVIEW', 'draft legal text is labelled as draft');
select is(public.preview_orientation(current_setting('t.rot_old'), 'en-US') ->> 'error', 'ORIENTATION_CODE_EXPIRED', 'a rotating code older than one step is rejected');
select is(public.preview_orientation(regexp_replace(current_setting('t.rot'), '.$', case when right(current_setting('t.rot'), 1) = 'A' then 'B' else 'A' end), 'en-US') ->> 'error',
          'ORIENTATION_CODE_INVALID', 'a forged rotating code is rejected');
select is(public.preview_orientation('https://evil.example/join', 'en-US') ->> 'error', 'ORIENTATION_CODE_INVALID', 'anything that is not a SiteMuster code is rejected');
select set_config('t.join_static', public.preview_orientation(current_setting('t.static'), 'en-US') ->> 'join_token', false);
select set_config('t.join_rot', public.preview_orientation(current_setting('t.rot'), 'en-US') ->> 'join_token', false);
select ok(current_setting('t.join_static') ~ '^[A-Za-z0-9_-]{43}$', 'a valid scan returns a join pass for this person');

-- Completing orientation.
select throws_ok(format($$select public.complete_orientation(%L, 'en-US', 'Ana Worker', null, 'Acme Drywall', 'Drywall', 'Luis Worker', '+15550002222', 'Brother', %L, false)$$, current_setting('t.join_static'), tests.id('n_en')),
  '22023', 'CONSENT_REQUIRED', 'acknowledging the disclosure is required');
select throws_ok(format($$select public.complete_orientation(%L, 'en-US', 'Ana Worker', null, 'Acme Drywall', 'Drywall', 'Luis Worker', '+15550002222', 'Brother', %L, true)$$, current_setting('t.join_static'), current_setting('t.es_notice')),
  '22023', 'NOTICE_OUTDATED', 'the accepted notice must be the current one for the chosen language');
select throws_ok(format($$select public.complete_orientation(%L, 'en-US', 'Ana Worker', null, 'Acme Drywall', 'Drywall', '', '', null, %L, true)$$, current_setting('t.join_static'), tests.id('n_en')),
  '22023', 'EMERGENCY_CONTACT_REQUIRED', 'an emergency contact is required');
select throws_ok(format($$select public.complete_orientation(%L, 'en-US', 'Ana Worker', null, null, 'Drywall', 'Luis Worker', '+15550002222', null, %L, true)$$, current_setting('t.join_static'), tests.id('n_en')),
  '22023', 'COMPANY_REQUIRED', 'an employer is required');
select throws_ok(format($$select public.complete_orientation(%L, 'en-US', 'Ana Worker', %L, null, 'Drywall', 'Luis Worker', '+15550002222', null, %L, true)$$, current_setting('t.join_static'), tests.id('c_b'), tests.id('n_en')),
  '22023', 'COMPANY_NOT_ON_PROJECT', 'a company from another project cannot be claimed');
select is(public.complete_orientation(current_setting('t.join_static'), 'en-US', 'Ana Worker', null, 'Acme Drywall', 'Drywall', 'Luis Worker', '+15550002222', 'Brother', tests.id('n_en'), true) ->> 'enrollment_status',
  'PENDING', 'the printed QR leads to ORIENTATION_COMPLETED + PENDING, never approval');
select is(public.my_enrollments() -> 0 ->> 'employer_status', 'PENDING_CONFIRMATION', 'the claimed employer is unconfirmed');
select is(public.complete_orientation(current_setting('t.join_rot'), 'en-US', 'Ana Worker', null, 'acme drywall', 'Drywall', 'Luis Worker', '+15550002222', 'Brother', tests.id('n_en'), true) ->> 'enrollment_status',
  'PENDING', 'the rotating QR also never approves');
select is(jsonb_array_length(public.my_enrollments()), 1, 'joining again does not create a second enrollment');
select is(public.get_my_emergency_contact() ->> 'name', 'Luis Worker', 'the worker reads their own emergency contact');
select lives_ok($$select public.update_my_emergency_contact('Rosa Worker', '+15550004444', 'Sister')$$, 'the worker can replace their emergency contact');
select is(public.complete_orientation(current_setting('t.rot'), 'en-US', 'Ana Worker', null, 'Acme Drywall', 'Drywall', 'Luis Worker', '+15550002222', 'Brother', tests.id('n_en'), true) ->> 'error',
  'ORIENTATION_CODE_INVALID', 'completing needs the join pass from the scan, never a raw QR code');

select tests.as_postgres();
select set_config('t.w_new', (select id::text from public.worker_profiles where auth_user_id = '99000000-0000-4000-8000-0000000000b1'), false);
select set_config('t.e_new', (select id::text from public.worker_enrollments where worker_id = current_setting('t.w_new')::uuid), false);
select is((select count(*)::int from public.orientation_records where worker_profile_id = current_setting('t.w_new')::uuid), 2, 'each completion is recorded as ORIENTATION_COMPLETED');
select is((select method::text from public.tracking_consents where worker_id = current_setting('t.w_new')::uuid and withdrawn_at is null), 'DIGITAL', 'the digital acknowledgement references the notice version');
select is((select phone from public.worker_profiles where id = current_setting('t.w_new')::uuid), '+15550001111', 'the profile phone comes from the verified sign-in, not from the form');
select is((select verified_status::text from public.subcontractor_companies where canonical_name = 'Acme Drywall'), 'PENDING', 'a new company is created once and stays unverified');
select is((select count(*)::int from public.emergency_contacts where worker_profile_id = current_setting('t.w_new')::uuid), 1, 'one emergency contact is kept per worker');

-- The join pass is bound to the person and the open session, not to the 60-second QR step
-- (review finding on PR #5): reading the notice for half an hour does not lock the worker out.
select ok((select count(*) = 1 from app_private.orientation_join_grants
            where token_hash = pg_catalog.sha256(convert_to(current_setting('t.join_rot'), 'UTF8'))), 'only the hash of the join pass is stored');
update app_private.orientation_join_grants set created_at = now() - interval '30 minutes'
 where token_hash = pg_catalog.sha256(convert_to(current_setting('t.join_rot'), 'UTF8'));
select tests.authenticate_as('99000000-0000-4000-8000-0000000000b3', 'aal1');
select is(public.complete_orientation(current_setting('t.join_rot'), 'en-US', 'Eve Other', null, 'Acme Drywall', 'Drywall', 'Luis Worker', '+15550002222', null, tests.id('n_en'), true) ->> 'error',
  'ORIENTATION_CODE_INVALID', 'another person cannot use someone else''s join pass');
select tests.authenticate_as('99000000-0000-4000-8000-0000000000b1', 'aal1');
select is(public.complete_orientation(current_setting('t.join_rot'), 'en-US', 'Ana Worker', null, 'Acme Drywall', 'Drywall', 'Rosa Worker', '+15550004444', 'Sister', tests.id('n_en'), true) ->> 'enrollment_status',
  'PENDING', 'a worker who spent 30 minutes on the form still completes with their join pass');
select tests.as_postgres();

-- Production refuses draft notices; an unmarked database is production.
delete from app_private.settings;
select is(app_private.deployment_environment(), 'production', 'an unmarked database is treated as production');
select tests.authenticate_as('99000000-0000-4000-8000-0000000000b1', 'aal1');
select throws_ok(format($$select public.complete_orientation(%L, 'en-US', 'Ana Worker', null, 'Acme Drywall', 'Drywall', 'Rosa Worker', '+15550004444', null, %L, true)$$, current_setting('t.join_rot'), tests.id('n_en')),
  '22023', 'CONSENT_NOTICE_NOT_APPROVED', 'production refuses acceptance of a draft notice');
select is((public.preview_orientation(current_setting('t.rot'), 'en-US') ->> 'notice_acceptable')::boolean, false, 'preview tells the app the notice cannot be accepted yet');
select tests.as_postgres();
update public.legal_notice_versions set review_status = 'APPROVED', approved_at = now() where id = tests.id('n_en');
select tests.authenticate_as('99000000-0000-4000-8000-0000000000b1', 'aal1');
select lives_ok(format($$select public.complete_orientation(%L, 'en-US', 'Ana Worker', null, 'Acme Drywall', 'Drywall', 'Rosa Worker', '+15550004444', null, %L, true)$$, current_setting('t.join_rot'), tests.id('n_en')),
  'an approved notice is accepted in production');
select tests.as_postgres();
insert into app_private.settings (key, value) values ('environment', 'development');

-- Closing and expiry.
select tests.authenticate_as(tests.id('u_a_super'));
select lives_ok(format($$select public.close_orientation_session(%L)$$, current_setting('t.s1')), 'staff closes the session');
select tests.authenticate_as('99000000-0000-4000-8000-0000000000b1', 'aal1');
select is(public.preview_orientation(current_setting('t.static'), 'en-US') ->> 'error', 'ORIENTATION_SESSION_CLOSED', 'the printed QR stops working when the session closes');
select is(public.complete_orientation(current_setting('t.join_static'), 'en-US', 'Ana Worker', null, 'Acme Drywall', 'Drywall', 'Rosa Worker', '+15550004444', null, tests.id('n_en'), true) ->> 'error',
  'ORIENTATION_SESSION_CLOSED', 'a join pass stops working when the session closes');
select tests.as_postgres();
select is((select count(*)::int from app_private.orientation_session_secrets where session_id = current_setting('t.s1')::uuid), 0, 'session secrets are deleted when the session closes');
select is((select count(*)::int from app_private.orientation_join_grants where session_id = current_setting('t.s1')::uuid and expires_at > now()), 0, 'join passes expire when the session closes');
select tests.authenticate_as(tests.id('u_a_safety'));
select set_config('t.s2', public.start_orientation_session(tests.id('p_a1'), gen_random_uuid()) ->> 'session_id', false);
select tests.as_postgres();
select throws_ok(format($$insert into public.orientation_sessions (project_id, expires_at) values (%L, now() + interval '1 hour')$$, tests.id('p_a1')),
  '23505', null, 'the database allows only one open orientation session per project');
select set_config('t.static2', (select 'SMS1.' || session_id || '.' || static_code from app_private.orientation_session_secrets where session_id = current_setting('t.s2')::uuid), false);
update public.orientation_sessions set starts_at = now() - interval '3 hours', expires_at = now() - interval '1 hour' where id = current_setting('t.s2')::uuid;
select tests.authenticate_as('99000000-0000-4000-8000-0000000000b1', 'aal1');
select is(public.preview_orientation(current_setting('t.static2'), 'en-US') ->> 'error', 'ORIENTATION_SESSION_CLOSED', 'an expired 120-minute session is rejected');

-- Rate limit counts failed attempts too (failures are returned, not raised).
select tests.authenticate_as('99000000-0000-4000-8000-0000000000b2', 'aal1');
select is((select count(*)::int from generate_series(1, 30) g where public.preview_orientation('SMO1.bad', 'en-US') ->> 'error' = 'ORIENTATION_CODE_INVALID'), 30, 'thirty failed attempts are answered');
select is(public.preview_orientation('SMO1.bad', 'en-US') ->> 'error', 'RATE_LIMITED', 'the 31st attempt in a minute is rate limited');

-- Staff review.
select tests.authenticate_as(tests.id('u_a_attendant'));
select ok(jsonb_array_length(public.list_project_enrollments(tests.id('p_a1'))) >= 5, 'assigned kiosk attendant sees the project roster');
select ok(public.list_project_enrollments(tests.id('p_a1'))::text !~ '"(phone|email|emergency[a-z_]*)"', 'the roster carries no phone, e-mail or emergency contact');
select throws_ok(format($$select public.bulk_approve_enrollments(%L, array[%L]::uuid[])$$, tests.id('p_a1'), current_setting('t.e_new')), '42501', 'FORBIDDEN', 'kiosk attendant cannot approve');
select tests.authenticate_as(tests.id('u_b_owner'));
select throws_ok(format($$select public.list_project_enrollments(%L)$$, tests.id('p_a1')), '42501', 'FORBIDDEN', 'another GC cannot read the roster');
select throws_ok(format($$select public.bulk_approve_enrollments(%L, array[%L]::uuid[])$$, tests.id('p_a1'), current_setting('t.e_new')), '42501', 'FORBIDDEN', 'another GC cannot approve');
select tests.authenticate_as('99000000-0000-4000-8000-0000000000b1', 'aal1');
select throws_ok(format($$select public.list_project_enrollments(%L)$$, tests.id('p_a1')), '42501', 'FORBIDDEN', 'workers cannot read the roster');

select tests.authenticate_as(tests.id('u_a_super'));
select throws_ok(format($$select public.bulk_approve_enrollments(%L, array(select gen_random_uuid() from generate_series(1, 101)))$$, tests.id('p_a1')),
  '22023', 'TOO_MANY_ENROLLMENTS', 'more than 100 per operation is refused');
select set_config('t.results', public.bulk_approve_enrollments(tests.id('p_a1'),
  array[current_setting('t.e_new')::uuid, tests.id('e_a1')] || array(select gen_random_uuid() from generate_series(1, 98)))::text, false);
select is(jsonb_array_length(current_setting('t.results')::jsonb), 100, 'bulk approval of 100 returns one result per person');
select is((select r ->> 'result' from jsonb_array_elements(current_setting('t.results')::jsonb) r where r ->> 'enrollment_id' = current_setting('t.e_new')), 'APPROVED', 'the oriented worker is approved');
select is((select r ->> 'result' from jsonb_array_elements(current_setting('t.results')::jsonb) r where r ->> 'enrollment_id' = tests.id('e_a1')::text), 'ALREADY_APPROVED', 'an approved worker is reported as already approved');
select is((select count(*)::int from jsonb_array_elements(current_setting('t.results')::jsonb) r where r ->> 'result' = 'NOT_FOUND'), 98, 'unknown ids are reported, never silently skipped');
select is(public.bulk_confirm_employer(tests.id('p_a1'), array[current_setting('t.e_new')::uuid], 'VERIFIED') -> 0 ->> 'result', 'VERIFIED', 'employer confirmation is a separate action');
select is(public.bulk_confirm_employer(tests.id('p_a1'), array[current_setting('t.e_new')::uuid], 'VERIFIED') -> 0 ->> 'result', 'UNCHANGED', 'confirming twice changes nothing');
select throws_ok(format($$select public.bulk_confirm_employer(%L, array[%L]::uuid[], 'PENDING_CONFIRMATION')$$, tests.id('p_a1'), current_setting('t.e_new')), '22023', 'INVALID_DECISION', 'only VERIFIED or REJECTED can be decided');

-- Supervised no-phone worker.
select tests.authenticate_as(tests.id('u_a_attendant'));
select is(public.get_project_notice(tests.id('p_a1'), 'es-US') -> 'notice' ->> 'id', current_setting('t.es_notice'), 'the supervisor gets the same disclosure to read aloud');
select set_config('t.managed', public.create_managed_worker(tests.id('p_a1'), 'Pedro Sin Telefono', tests.id('c_a'), null, 'Labor', 'Maria', '+15550003333', 'Wife', 'es-US',
  current_setting('t.es_notice')::uuid, true, '11111111-aaaa-4aaa-8aaa-0000000000f2')::text, false);
select is(current_setting('t.managed')::jsonb ->> 'enrollment_status', 'PENDING', 'supervised onboarding creates a PENDING enrollment (approval stays separate)');
select is(public.create_managed_worker(tests.id('p_a1'), 'Pedro Sin Telefono', tests.id('c_a'), null, 'Labor', 'Maria', '+15550003333', 'Wife', 'es-US',
  current_setting('t.es_notice')::uuid, true, '11111111-aaaa-4aaa-8aaa-0000000000f2') ->> 'worker_id', current_setting('t.managed')::jsonb ->> 'worker_id', 'a retry returns the same managed worker');
select tests.as_postgres();
select ok((select managed_identity and auth_user_id is null and phone is null and email is null from public.worker_profiles
            where id = (current_setting('t.managed')::jsonb ->> 'worker_id')::uuid), 'the no-phone worker has no fabricated account, phone or e-mail');
select is((select method::text || ':' || (reviewing_actor = tests.id('u_a_attendant'))::text from public.tracking_consents
            where worker_id = (current_setting('t.managed')::jsonb ->> 'worker_id')::uuid), 'SUPERVISED:true', 'the supervised acknowledgement records who read the notice');
select tests.authenticate_as(tests.id('u_a_super'));
select throws_ok(format($$select public.decide_enrollment(%L, 'REJECTED', '')$$, current_setting('t.managed')::jsonb ->> 'enrollment_id'), '22023', 'REASON_REQUIRED', 'rejecting needs a reason');
select is(public.decide_enrollment((current_setting('t.managed')::jsonb ->> 'enrollment_id')::uuid, 'REJECTED', 'Duplicate person')::text, 'REJECTED', 'a pending enrollment can be rejected with a reason');

-- Printed badges.
select tests.authenticate_as(tests.id('u_a_attendant'));
select throws_ok(format($$select public.issue_printed_badge(%L, %L)$$, tests.id('p_a1'), current_setting('t.managed')::jsonb ->> 'worker_id'), '22023', 'ENROLLMENT_NOT_APPROVED', 'printed badges only for approved workers');
select set_config('t.badge', public.issue_printed_badge(tests.id('p_a1'), tests.id('w_managed'))::text, false);
select ok((current_setting('t.badge')::jsonb ->> 'code') ~ '^SMP1\.[A-Za-z0-9_-]{32}$', 'the printed badge is an opaque code without personal data');
select tests.as_postgres();
select ok((select opaque_badge_hash = pg_catalog.sha256(convert_to(current_setting('t.badge')::jsonb ->> 'code', 'UTF8')) from public.worker_badges
            where id = (current_setting('t.badge')::jsonb ->> 'badge_id')::uuid), 'only the hash of the printed badge is stored');
select tests.authenticate_as(tests.id('u_a_attendant'));
select set_config('t.badge2', public.issue_printed_badge(tests.id('p_a1'), tests.id('w_managed'))::text, false);
select tests.as_postgres();
select is((select count(*)::int from public.worker_badges where worker_id = tests.id('w_managed') and badge_kind = 'PRINTED' and active), 1, 'reissuing revokes the previous printed badge');
select throws_ok(format($$insert into public.worker_badges (worker_id, badge_kind, opaque_badge_hash) values (%L, 'PRINTED', extensions.gen_random_bytes(32))$$, tests.id('w_managed')),
  '23505', null, 'the database allows only one active printed badge per worker');
select tests.authenticate_as(tests.id('u_b_owner'));
select throws_ok(format($$select public.issue_printed_badge(%L, %L)$$, tests.id('p_a1'), tests.id('w_managed')), '42501', 'FORBIDDEN', 'another GC cannot issue badges for this project');
select tests.authenticate_as(tests.id('u_a_attendant'));
select lives_ok(format($$select public.revoke_printed_badge(%L, %L, 'Badge lost on site')$$, tests.id('p_a1'), current_setting('t.badge2')::jsonb ->> 'badge_id'), 'an attendant revokes a lost printed badge with a reason');

-- Device activation and badge redemption (Edge Functions only).
select tests.authenticate_as(tests.id('u_worker_a1'), 'aal1');
select throws_ok(format($$select public.edge_activate_device(%L, gen_random_uuid(), 'IOS', repeat('a', 64), '1.0', '\x00'::bytea, 1::smallint, '\x00'::bytea)$$, tests.id('u_worker_a1')),
  '42501', null, 'apps cannot call device activation directly');
select tests.as_postgres();
select set_config('t.u_worker_a1', tests.id('u_worker_a1')::text, false), set_config('t.u_a_owner', tests.id('u_a_owner')::text, false),
       set_config('t.p_a1', tests.id('p_a1')::text, false), set_config('t.d_a1', tests.id('d_a1')::text, false);
select set_config('role', 'service_role', true);
select is(public.edge_activate_device(current_setting('t.u_worker_a1')::uuid, '99000000-0000-4000-8000-0000000000d9', 'IOS', repeat('b', 64), '1.0',
            decode(repeat('ab', 44), 'hex'), 1::smallint, decode(repeat('cd', 32), 'hex')) ->> 'replaced_device_id',
          current_setting('t.d_a1'), 'activating a new phone replaces the previous device');
select throws_ok(format($$select public.edge_activate_device(%L, gen_random_uuid(), 'ANDROID', repeat('c', 64), '1.0', '\x00'::bytea, 1::smallint, decode(repeat('ef', 32), 'hex'))$$, current_setting('t.u_a_owner')::uuid),
  '22023', 'WORKER_PROFILE_REQUIRED', 'only workers with a profile can activate a tracking device');
select is(public.edge_redeem_badge_step(current_setting('t.p_a1')::uuid, '99000000-0000-4000-8000-0000000000d9', 59766667, '99000000-0000-4000-8000-0000000000e1', null, null), 'accepted', 'the first scan of a badge step is accepted');
select is(public.edge_redeem_badge_step(current_setting('t.p_a1')::uuid, '99000000-0000-4000-8000-0000000000d9', 59766667, '99000000-0000-4000-8000-0000000000e1', null, null), 'duplicate', 'the same kiosk event sent again is a duplicate');
select is(public.edge_redeem_badge_step(current_setting('t.p_a1')::uuid, '99000000-0000-4000-8000-0000000000d9', 59766667, '99000000-0000-4000-8000-0000000000e2', null, null), 'replay', 'the same badge step in another event is a replay');
reset role;
select tests.as_postgres();
select ok((select not active and replaced_by = '99000000-0000-4000-8000-0000000000d9' from public.device_installations where id = tests.id('d_a1')), 'the previous device is inactive and linked to its replacement');
select is((select count(*)::int from app_private.device_upload_credentials where device_id = tests.id('d_a1') and revoked_at is null), 0, 'the previous device upload credentials are revoked');
select is((select count(*)::int from public.device_installations where worker_id = tests.id('w_a1') and active), 1, 'one active personal device per worker');

select * from finish();
rollback;
