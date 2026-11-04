-- Device credentials (decisions #13, #24, #27, #44): hashed tokens only, 30-day lifetime,
-- immediate revocation, 24 h rotation overlap, one active personal device per worker.
begin;
select plan(13);
select tests.seed_world();

-- Credentials are stored as SHA-256 only.
insert into app_private.device_upload_credentials (id, device_id, token_sha256, created_at, expires_at) values
  ('c0000000-0000-4000-8000-000000000001', tests.id('d_a1'), sha256('token-active'), now() - interval '1 day', now() + interval '29 days');
insert into app_private.device_upload_credentials (device_id, token_sha256, created_at, expires_at, revoked_at) values
  (tests.id('d_a1'), sha256('token-revoked'), now() - interval '2 days', now() + interval '28 days', now() - interval '1 hour');
insert into app_private.device_upload_credentials (device_id, token_sha256, created_at, expires_at) values
  (tests.id('d_a1'), sha256('token-expired'), now() - interval '31 days', now() - interval '1 day');
insert into app_private.device_upload_credentials (device_id, token_sha256, created_at, expires_at) values
  (tests.id('d_a1_old'), sha256('token-old-device'), now() - interval '1 day', now() + interval '29 days');
insert into app_private.device_upload_credentials (device_id, token_sha256, created_at, expires_at, overlap_until) values
  (tests.id('d_a1'), sha256('token-rotated'), now() - interval '10 days', now() + interval '20 days', now() + interval '23 hours');

select results_eq(
  $$select device_id, worker_id from app_private.resolve_upload_credential(sha256('token-active'))$$,
  format($$values (%L::uuid, %L::uuid)$$, tests.id('d_a1'), tests.id('w_a1')),
  'a valid token resolves to its device and worker (server-derived identity)');
select is_empty($$select 1 from app_private.resolve_upload_credential(sha256('token-revoked'))$$, 'revoked token is rejected immediately');
select is_empty($$select 1 from app_private.resolve_upload_credential(sha256('token-expired'))$$, 'expired token is rejected');
select is_empty($$select 1 from app_private.resolve_upload_credential(sha256('token-old-device'))$$, 'token of a replaced (inactive) device is rejected');
select isnt_empty($$select 1 from app_private.resolve_upload_credential(sha256('token-rotated'))$$, 'rotated token is accepted inside its 24 h overlap');
select is_empty($$select 1 from app_private.resolve_upload_credential(sha256('token-rotated'), now() + interval '24 hours')$$, 'rotated token is rejected after the overlap');
select is_empty($$select 1 from app_private.resolve_upload_credential(sha256('never-issued'))$$, 'unknown token is rejected');

select throws_ok(
  $$insert into app_private.device_upload_credentials (device_id, token_sha256, created_at, expires_at) values ('5d000000-0000-4000-8000-0000000000a1', sha256('too-long'), now(), now() + interval '31 days')$$,
  '23514', null, 'credential lifetime cannot exceed 30 days');
select throws_ok(
  $$insert into public.device_installations (worker_id, platform, hardware_installation_hash) values ('4a000000-0000-4000-8000-0000000000a1', 'IOS', repeat('c', 64))$$,
  '23505', null, 'only one active personal device per worker');
select throws_ok(
  format($$insert into public.device_project_bindings (device_id, project_id, enrollment_id) values (%L, %L, %L)$$, tests.id('d_a1'), tests.id('p_b1'), tests.id('e_b1')),
  '23514', null, 'a device cannot bind to another worker''s enrollment or project');

-- Neither the worker nor staff can ever read credential material.
select tests.authenticate_as(tests.id('u_worker_a1'), 'aal1');
select throws_ok('select token_sha256 from app_private.device_upload_credentials', '42501', null, 'worker cannot read credential hashes');
select throws_ok('select hardware_installation_hash from public.device_installations', '42501', null, 'worker cannot read the installation hash column');
select tests.authenticate_as(tests.id('u_a_super'));
select throws_ok('select 1 from app_private.device_badge_secrets', '42501', null, 'staff cannot read badge secrets');

select tests.as_postgres();
select * from finish();
rollback;
