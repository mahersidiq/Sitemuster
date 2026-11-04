-- Milestone 02 · Extensions, private schema and deny-by-default privileges.
-- docs/spec/05-data-model.md, 09-security-privacy.md, decision #39.

create extension if not exists postgis with schema extensions;

-- Server-only objects (credentials, receipts, raw fixes, audit) live in app_private, which the
-- Data API never exposes. `authenticated` only needs USAGE so RLS policies can call the
-- security-definer helper predicates defined here; no table in app_private is granted to it.
create schema if not exists app_private;
revoke all on schema app_private from public;
grant usage on schema app_private to authenticated, service_role;

-- Deny by default: objects created by `postgres` from now on are NOT automatically granted to the
-- Data API roles. Every grant in later migrations is explicit and tested (pgTAP 002_privileges).
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated, service_role;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated, service_role;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated, service_role;
alter default privileges for role postgres in schema app_private revoke all on tables from anon, authenticated, service_role;
alter default privileges for role postgres in schema app_private revoke all on functions from anon, authenticated, service_role;
-- Functions are executable by PUBLIC by default in PostgreSQL; remove that global default.
alter default privileges for role postgres revoke execute on functions from public;
