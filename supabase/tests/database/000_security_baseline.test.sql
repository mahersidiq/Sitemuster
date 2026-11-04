-- Milestone 01 security baseline (docs/spec/05-data-model.md, 09-security-privacy.md).
-- These invariants hold for every table added by later milestones:
--   1. every table in the exposed `public` schema has row level security enabled;
--   2. no policy grants blanket access with USING (true) / WITH CHECK (true);
--   3. the anonymous role holds no table privileges in `public`.
begin;
create extension if not exists pgtap with schema extensions;

select plan(4);

select is(
  (select count(*)::int from pg_catalog.pg_tables where schemaname = 'public' and not rowsecurity),
  0,
  'every public table has row level security enabled'
);

select is(
  (select count(*)::int
     from pg_catalog.pg_policies
    where schemaname = 'public'
      and (coalesce(qual, '') = 'true' or coalesce(with_check, '') = 'true')),
  0,
  'no public policy uses a blanket USING (true) / WITH CHECK (true)'
);

select is(
  (select count(*)::int
     from information_schema.role_table_grants
    where table_schema = 'public' and grantee = 'anon'),
  0,
  'the anon role has no table privileges in public'
);

select ok(
  exists (select 1 from pg_catalog.pg_available_extensions where name = 'postgis'),
  'PostGIS is available for circular geofence geometry (Milestone 02)'
);

select * from finish();
rollback;
