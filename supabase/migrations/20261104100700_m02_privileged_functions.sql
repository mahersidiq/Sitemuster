-- Milestone 02 · Minimal privileged functions: audit writer, organization creation, device
-- credential resolution, raw-fix partition maintenance and purge.

-- ---------------------------------------------------------------------------------------------
-- Audit writer (internal; minimal, coordinate-free metadata enforced by table constraint)
-- ---------------------------------------------------------------------------------------------
create function app_private.write_audit(
  p_actor_type public.audit_actor_type,
  p_actor_id uuid,
  p_action text,
  p_organization_id uuid default null,
  p_project_id uuid default null,
  p_resource_type text default null,
  p_resource_id uuid default null,
  p_request_id uuid default null,
  p_metadata jsonb default '{}'::jsonb
)
returns uuid
language sql
security definer
set search_path = ''
as $$
  insert into app_private.audit_logs
    (actor_type, actor_id, organization_id, project_id, action, resource_type, resource_id, request_id, metadata)
  values
    (p_actor_type, p_actor_id, p_organization_id, p_project_id, p_action, p_resource_type, p_resource_id, p_request_id, coalesce(p_metadata, '{}'::jsonb))
  returning id
$$;

-- ---------------------------------------------------------------------------------------------
-- Create GC organization (role matrix: "Owner-account only").
-- Staff only: verified email + MFA (aal2); never a platform operator. Idempotent per caller key:
-- a retried request returns the same organization instead of creating a duplicate.
-- ---------------------------------------------------------------------------------------------
create function public.create_organization(
  p_name text,
  p_idempotency_key uuid,
  p_address text default null,
  p_business_email text default null,
  p_phone text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_org uuid;
begin
  if v_uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if app_private.is_platform_operator() then
    raise exception 'platform operators cannot create tenant organizations' using errcode = '42501';
  end if;
  if not app_private.is_aal2() then
    raise exception 'multi-factor authentication required' using errcode = '42501';
  end if;
  if not exists (select 1 from auth.users u where u.id = v_uid and u.email is not null and u.email_confirmed_at is not null) then
    raise exception 'verified staff email required' using errcode = '42501';
  end if;
  if p_idempotency_key is null then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  select o.id into v_org from public.organizations o
   where o.owner_user_id = v_uid and o.idempotency_key = p_idempotency_key;
  if v_org is not null then
    return v_org;
  end if;

  insert into public.organizations (name, address, business_email, phone, owner_user_id, idempotency_key)
  values (btrim(p_name), p_address, p_business_email, p_phone, v_uid, p_idempotency_key)
  on conflict (owner_user_id, idempotency_key) do nothing
  returning id into v_org;

  if v_org is null then
    -- Concurrent retry won the race; return the row it created.
    select o.id into v_org from public.organizations o
     where o.owner_user_id = v_uid and o.idempotency_key = p_idempotency_key;
    return v_org;
  end if;

  insert into public.organization_members (organization_id, user_id, role, added_by)
  values (v_org, v_uid, 'OWNER', v_uid);

  perform app_private.write_audit('USER', v_uid, 'organization.created', v_org, null, 'organization', v_org);
  return v_org;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Device upload credential resolution (used by the ingest Edge Function in Milestone 07).
-- Valid only when: not revoked, not expired (or inside the 24 h rotation overlap of a rotated
-- token), and the device is the worker's ACTIVE device. Returns no row otherwise (=> HTTP 401).
-- ---------------------------------------------------------------------------------------------
create function app_private.resolve_upload_credential(p_token_sha256 bytea, p_at timestamptz default now())
returns table (credential_id uuid, device_id uuid, worker_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, d.id, d.worker_id
    from app_private.device_upload_credentials c
    join public.device_installations d on d.id = c.device_id
    join public.worker_profiles w on w.id = d.worker_id
   where c.token_sha256 = p_token_sha256
     and c.revoked_at is null
     and d.active
     and w.deleted_at is null
     and case
           -- a rotated (superseded) token stays usable for exactly its 24 h overlap window
           when c.overlap_until is not null then p_at < c.overlap_until
           else p_at < c.expires_at
         end
$$;

-- ---------------------------------------------------------------------------------------------
-- Raw onsite fix partitions (daily, by expires_at) and purge.
-- ---------------------------------------------------------------------------------------------
create function app_private.ensure_raw_fix_partitions(p_from date default current_date, p_days integer default 3)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  d date;
  v_name text;
  v_created integer := 0;
begin
  if p_days < 1 or p_days > 31 then
    raise exception 'p_days must be between 1 and 31' using errcode = '22023';
  end if;
  for i in 0 .. p_days - 1 loop
    d := p_from + i;
    v_name := 'raw_onsite_fixes_' || to_char(d, 'YYYYMMDD');
    if to_regclass('app_private.' || v_name) is null then
      execute format(
        'create table app_private.%I partition of app_private.raw_onsite_fixes for values from (%L) to (%L)',
        v_name, d::timestamptz, (d + 1)::timestamptz
      );
      execute format('alter table app_private.%I enable row level security', v_name);
      execute format('revoke all on app_private.%I from anon, authenticated, service_role', v_name);
      v_created := v_created + 1;
    end if;
  end loop;
  return v_created;
end;
$$;

-- Drops every daily partition whose whole range has expired and deletes expired rows from the
-- current partition. Returns the number of partitions dropped plus rows deleted.
create function app_private.purge_expired_raw_fixes(p_now timestamptz default now())
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  v_count bigint := 0;
  v_deleted bigint;
begin
  for r in
    select c.relname, pg_catalog.pg_get_expr(c.relpartbound, c.oid) as bound
      from pg_catalog.pg_inherits i
      join pg_catalog.pg_class c on c.oid = i.inhrelid
      join pg_catalog.pg_class p on p.oid = i.inhparent
      join pg_catalog.pg_namespace n on n.oid = p.relnamespace
     where n.nspname = 'app_private' and p.relname = 'raw_onsite_fixes'
  loop
    -- Partition upper bound is the day after its name date (UTC midnight boundaries).
    if (to_date(substr(r.relname, length('raw_onsite_fixes_') + 1), 'YYYYMMDD') + 1)::timestamptz <= p_now then
      execute format('drop table app_private.%I', r.relname);
      v_count := v_count + 1;
    end if;
  end loop;
  delete from app_private.raw_onsite_fixes where expires_at <= p_now;
  get diagnostics v_deleted = row_count;
  return v_count + v_deleted;
end;
$$;

-- Pre-create partitions for today and the next two days (inserts also call ensure first).
select app_private.ensure_raw_fix_partitions(current_date, 3);

-- Grants: only what clients need. Server-only functions stay private (no grants).
revoke all on function public.create_organization(text, uuid, text, text, text) from public, anon, service_role;
grant execute on function public.create_organization(text, uuid, text, text, text) to authenticated;
