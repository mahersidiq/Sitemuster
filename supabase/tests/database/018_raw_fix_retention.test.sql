-- Raw onsite fixes: at most 24 h after receipt, daily partitions dropped by the purge (spec 03/05/09).
begin;
select plan(7);
select tests.seed_world();

select ok(app_private.ensure_raw_fix_partitions(current_date, 2) >= 0, 'partition maintenance runs');
select lives_ok(
  format($$insert into app_private.raw_onsite_fixes (event_uuid, project_id, worker_id, point, accuracy_m, observed_at, received_at, expires_at)
           values (gen_random_uuid(), %L, %L, extensions.st_setsrid(extensions.st_makepoint(-95.3698, 29.7604), 4326)::extensions.geography, 10, now(), now(), now() + interval '23 hours')$$,
         tests.id('p_a1'), tests.id('w_a1')),
  'a raw fix expiring within 24 h is stored');
select throws_ok(
  format($$insert into app_private.raw_onsite_fixes (event_uuid, project_id, worker_id, point, accuracy_m, observed_at, received_at, expires_at)
           values (gen_random_uuid(), %L, %L, extensions.st_setsrid(extensions.st_makepoint(-95.3698, 29.7604), 4326)::extensions.geography, 10, now(), now(), now() + interval '25 hours')$$,
         tests.id('p_a1'), tests.id('w_a1')),
  '23514', null, 'a raw fix may never be kept longer than 24 h after receipt');
select is((select count(*)::int from app_private.raw_onsite_fixes), 1, 'one raw fix present before purge');
select ok(app_private.purge_expired_raw_fixes(now() + interval '3 days') >= 1, 'purge removes expired partitions/rows');
select is((select count(*)::int from app_private.raw_onsite_fixes), 0, 'no raw coordinates remain after expiry');
select is(
  (select count(*)::int from pg_inherits i join pg_class p on p.oid = i.inhparent
    where p.relname = 'raw_onsite_fixes' and p.relnamespace = 'app_private'::regnamespace),
  0, 'expired daily partitions are dropped entirely');

select * from finish();
rollback;
