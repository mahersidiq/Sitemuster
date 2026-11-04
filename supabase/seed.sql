-- LOCAL DEVELOPMENT AND CI ONLY.
-- `supabase db reset` applies this file to the local Docker database. It is never applied to the
-- hosted staging/production projects, so nothing here can exist in production.
--
-- Development SMS capture (typed development-only adapter for SMS OTP, HUMAN_CHECKLIST "No-account
-- development rules"): the local Auth server's send_sms hook stores the code in a private table
-- instead of contacting Twilio. Tests and developers read it with direct database access only.
-- Hosted projects have neither this table nor this function: if the hook were ever configured
-- there, sending fails closed (no code is delivered or exposed).

create table if not exists app_private.dev_sms_outbox (
  id bigserial primary key,
  phone text not null,
  otp text not null check (otp ~ '^[0-9]{6}$'),
  created_at timestamptz not null default now()
);
alter table app_private.dev_sms_outbox enable row level security;
revoke all on app_private.dev_sms_outbox from anon, authenticated, service_role;

create or replace function app_private.dev_send_sms_hook(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into app_private.dev_sms_outbox (phone, otp)
  values (event -> 'user' ->> 'phone', event -> 'sms' ->> 'otp');
  return '{}'::jsonb;
end;
$$;

revoke all on function app_private.dev_send_sms_hook(jsonb) from public, anon, authenticated, service_role;
grant usage on schema app_private to supabase_auth_admin;
grant execute on function app_private.dev_send_sms_hook(jsonb) to supabase_auth_admin;

-- LOCAL/CI ONLY: mark this database as development (decision #70). Unmarked databases count as
-- production and refuse draft legal notices; hosted projects never run this seed.
insert into app_private.settings (key, value) values ('environment', 'development')
on conflict (key) do update set value = excluded.value, updated_at = now();
