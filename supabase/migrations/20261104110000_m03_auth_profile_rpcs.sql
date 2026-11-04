-- Milestone 03 · Owner-only identity RPCs used for role-aware routing and the profile language
-- picker. Each returns ONLY the caller's own data; authorization for everything else stays in RLS.

-- Role summary for routing. The client uses it to choose screens; the server still enforces every
-- read/write independently (RLS and privileged functions).
create function public.get_my_access()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_worker uuid;
  v_result jsonb;
begin
  if v_uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  select w.id into v_worker
    from public.worker_profiles w
   where w.auth_user_id = v_uid and w.deleted_at is null;

  select jsonb_build_object(
    'user_id', v_uid,
    'aal', coalesce(auth.jwt() ->> 'aal', 'aal1'),
    'email_verified', coalesce(u.email is not null and u.email_confirmed_at is not null, false),
    'phone_verified', coalesce(u.phone is not null and u.phone_confirmed_at is not null, false),
    'is_platform_operator', app_private.is_platform_operator(),
    'worker_profile_id', v_worker,
    'is_foreman', exists (
      select 1 from public.subcontractor_members m
       where m.worker_profile_id = v_worker and m.role = 'FOREMAN' and m.verification_status = 'VERIFIED'
         and m.valid_from <= now() and (m.valid_until is null or m.valid_until > now())
    ),
    'org_roles', coalesce((
      select jsonb_agg(jsonb_build_object('organization_id', m.organization_id, 'role', m.role) order by m.organization_id, m.role)
        from public.organization_members m
       where m.user_id = v_uid and m.membership_status = 'ACTIVE'
    ), '[]'::jsonb),
    'project_roles', coalesce((
      select jsonb_agg(jsonb_build_object('project_id', s.project_id, 'role', s.role) order by s.project_id, s.role)
        from public.project_staff s
       where s.user_id = v_uid and s.status = 'ACTIVE'
    ), '[]'::jsonb)
  )
  into v_result
  from auth.users u
  where u.id = v_uid;

  return v_result;
end;
$$;

-- The caller's own worker profile including contact fields hidden from table reads.
create function public.get_my_profile()
returns table (
  id uuid,
  legal_name text,
  email text,
  phone text,
  primary_language public.locale_code,
  managed_identity boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select w.id, w.legal_name, w.email, w.phone, w.primary_language, w.managed_identity
    from public.worker_profiles w
   where w.auth_user_id = auth.uid() and w.deleted_at is null
     and not app_private.is_platform_operator()
$$;

-- Persist the chosen UI language on the caller's worker profile (used for push/SMS templates).
create function public.set_my_language(p_locale public.locale_code)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_updated integer;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  update public.worker_profiles
     set primary_language = p_locale
   where auth_user_id = auth.uid() and deleted_at is null;
  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$$;

revoke all on function public.get_my_access() from public, anon, service_role;
revoke all on function public.get_my_profile() from public, anon, service_role;
revoke all on function public.set_my_language(public.locale_code) from public, anon, service_role;
grant execute on function public.get_my_access() to authenticated;
grant execute on function public.get_my_profile() to authenticated;
grant execute on function public.set_my_language(public.locale_code) to authenticated;
