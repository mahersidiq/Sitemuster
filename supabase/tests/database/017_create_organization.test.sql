-- "Create GC organization: Owner-account only" — verified email + MFA staff; idempotent.
begin;
select plan(11);
select tests.seed_world();

select tests.create_user('99000000-0000-4000-8000-000000000001', 'new.gc@example.test');
select tests.authenticate_as('99000000-0000-4000-8000-000000000001');
select lives_ok(
  $$select public.create_organization('New GC LLC', '77777777-7777-4777-8777-777777777777')$$,
  'verified staff with MFA can create an organization');
select is(
  public.create_organization('New GC LLC (retry)', '77777777-7777-4777-8777-777777777777'),
  (select id from public.organizations where name = 'New GC LLC'),
  'retry with the same idempotency key returns the same organization');
select is((select count(*)::int from public.organizations where name like 'New GC LLC%'), 1, 'no duplicate organization from a retry');
select results_eq(
  $$select role::text from public.organization_members where user_id = '99000000-0000-4000-8000-000000000001'$$,
  array['OWNER'], 'creator becomes the OWNER member');
select throws_ok($$select public.create_organization('   ', gen_random_uuid())$$, '23514', null, 'blank names are rejected');
select throws_ok($$select public.create_organization('No key', null)$$, '22023', null, 'idempotency key is mandatory');

select tests.as_postgres();
select is(
  (select count(*)::int from app_private.audit_logs where action = 'organization.created' and actor_id = '99000000-0000-4000-8000-000000000001'),
  1, 'creation is audited exactly once');

select tests.authenticate_as('99000000-0000-4000-8000-000000000001', 'aal1');
select throws_ok($$select public.create_organization('No MFA', gen_random_uuid())$$, '42501', null, 'MFA (aal2) is required');

select tests.authenticate_as(tests.id('u_worker_a1'), 'aal2');
select throws_ok($$select public.create_organization('Worker Org', gen_random_uuid())$$, '42501', null, 'phone-only worker accounts cannot create organizations');

select tests.as_postgres();
select tests.create_user('99000000-0000-4000-8000-000000000002', 'unverified@example.test');
update auth.users set email_confirmed_at = null where id = '99000000-0000-4000-8000-000000000002';
select tests.authenticate_as('99000000-0000-4000-8000-000000000002');
select throws_ok($$select public.create_organization('Unverified', gen_random_uuid())$$, '42501', null, 'unverified email cannot create organizations');

select tests.authenticate_as_anon();
select throws_ok($$select public.create_organization('Anon', gen_random_uuid())$$, '42501', null, 'anonymous callers cannot create organizations');

select tests.as_postgres();
select * from finish();
rollback;
