-- Milestone 03 owner-only identity RPCs: return only the caller's own data.
begin;
select plan(13);
select tests.seed_world();

select tests.authenticate_as(tests.id('u_worker_a1'), 'aal1');
select is((public.get_my_access() ->> 'worker_profile_id')::uuid, tests.id('w_a1'), 'worker access summary returns own profile id');
select is(public.get_my_access() ->> 'aal', 'aal1', 'access summary reports the session assurance level');
select is(public.get_my_access() -> 'org_roles', '[]'::jsonb, 'worker has no organization roles');
select results_eq('select phone from public.get_my_profile()', array['+15550000201'], 'worker reads own phone through the owner-only RPC');
select is((select count(*)::int from public.get_my_profile()), 1, 'exactly one profile (the caller''s)');
select ok(public.set_my_language('es-US'), 'worker saves Spanish as profile language');
select tests.as_postgres();
select is((select primary_language::text from public.worker_profiles where id = tests.id('w_a1')), 'es-US', 'language persisted on the worker profile');
select is((select primary_language::text from public.worker_profiles where id = tests.id('w_a2')), 'en-US', 'other workers untouched');

select tests.authenticate_as(tests.id('u_foreman_a'), 'aal1');
select ok((public.get_my_access() ->> 'is_foreman')::boolean, 'verified foreman is flagged for routing');

select tests.authenticate_as(tests.id('u_a_super'));
select is(public.get_my_access() -> 'project_roles', format('[{"role": "SUPER", "project_id": "%s"}]', tests.id('p_a1'))::jsonb, 'staff access lists own project roles only');
select is((select count(*)::int from public.get_my_profile()), 0, 'staff without a worker profile gets no profile row');
select ok(not public.set_my_language('en-US'), 'staff without a worker profile: language saved client-side only');

select tests.authenticate_as(tests.id('u_operator'));
select ok((public.get_my_access() ->> 'is_platform_operator')::boolean, 'operator account is identified so the app can refuse it');

select tests.as_postgres();
select * from finish();
rollback;
