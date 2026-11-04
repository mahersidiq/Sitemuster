-- Milestone 04 · Organizations, projects, immutable configuration versions, circles, work windows,
-- lifecycle, staff invitations and rate-limited address lookup (docs/spec/06, 01, 02, 05).

create extension if not exists pg_trgm with schema extensions;

alter table public.project_tracking_config_versions add column idempotency_key uuid;
create unique index config_versions_idempotency_uq
  on public.project_tracking_config_versions (project_id, idempotency_key) where idempotency_key is not null;

alter table public.organization_invitations
  add column emergency_designated boolean not null default false,
  add column can_configure_project boolean not null default false,
  add column can_assign_staff boolean not null default false,
  add column can_approve_corrections boolean not null default false;

-- ---------------------------------------------------------------------------------------------
-- Locked defaults (mirror of packages/shared TRACKING_DEFAULTS; parity-tested) and validation
-- ---------------------------------------------------------------------------------------------
create function app_private.tracking_defaults()
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'geofence_radius_m', 150,
    'exit_hysteresis_m', 50,
    'entry_dwell_seconds', 600,
    'min_qualified_inside_fixes', 2,
    'max_horizontal_accuracy_m', 75,
    'location_fresh_seconds', 600,
    'presence_unknown_seconds', 1200,
    'queue_auto_reconcile_age_hours', 72,
    'max_device_clock_skew_seconds', 300,
    'raw_fix_retention_hours_after_close', 24,
    'moving_sample_target_seconds', 90,
    'stationary_sample_target_seconds', 300,
    'onsite_distance_filter_m', 25,
    'foreground_position_recheck_cooldown_seconds', 300,
    'native_stationary_stop_timeout_seconds', 300,
    'work_window_grace_minutes', 60,
    'shift_closeout_grace_minutes', 60,
    'operates_24_7', false,
    'always_open_24h_review_open_hours', 16,
    'always_open_24h_review_stale_minutes', 20,
    'foreman_confirm_deadline_local', '12:00',
    'worker_app_badge_ttl_seconds', 30
  )
$$;

create function app_private.hhmm_minutes(p_value text)
returns integer
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_value is null or p_value !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
    raise exception 'INVALID_WORK_WINDOW_TIME' using errcode = '22023';
  end if;
  return split_part(p_value, ':', 1)::integer * 60 + split_part(p_value, ':', 2)::integer;
end;
$$;

-- Validates and normalizes work windows: [{weekday 1-7, local_start_time "HH:MM", local_end_time "HH:MM"}].
-- crosses_midnight is derived; overlapping windows (including across midnight and Sunday→Monday)
-- are rejected. A 24/7 project needs no windows; any other project needs at least one.
create function app_private.normalize_work_windows(p_windows jsonb, p_operates_24_7 boolean)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_item jsonb;
  v_out jsonb := '[]'::jsonb;
  v_weekday integer;
  v_start integer;
  v_end integer;
  v_intervals integer[][] := '{}';
  i integer;
  j integer;
  s1 integer; e1 integer; s2 integer; e2 integer;
begin
  if p_windows is null or jsonb_typeof(p_windows) <> 'array' then
    raise exception 'INVALID_WORK_WINDOWS' using errcode = '22023';
  end if;
  if jsonb_array_length(p_windows) > 42 then
    raise exception 'TOO_MANY_WORK_WINDOWS' using errcode = '22023';
  end if;
  if not p_operates_24_7 and jsonb_array_length(p_windows) = 0 then
    raise exception 'WORK_WINDOW_REQUIRED' using errcode = '22023';
  end if;
  for v_item in select value from jsonb_array_elements(p_windows) loop
    if jsonb_typeof(v_item -> 'weekday') <> 'number' then
      raise exception 'INVALID_WORK_WINDOW_WEEKDAY' using errcode = '22023';
    end if;
    v_weekday := (v_item ->> 'weekday')::integer;
    if v_weekday < 1 or v_weekday > 7 then
      raise exception 'INVALID_WORK_WINDOW_WEEKDAY' using errcode = '22023';
    end if;
    v_start := app_private.hhmm_minutes(v_item ->> 'local_start_time');
    v_end := app_private.hhmm_minutes(v_item ->> 'local_end_time');
    if v_start = v_end then
      raise exception 'EMPTY_WORK_WINDOW' using errcode = '22023';
    end if;
    v_intervals := v_intervals || array[[
      (v_weekday - 1) * 1440 + v_start,
      (v_weekday - 1) * 1440 + v_start + case when v_end > v_start then v_end - v_start else v_end + 1440 - v_start end
    ]];
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'weekday', v_weekday,
      'local_start_time', v_item ->> 'local_start_time',
      'local_end_time', v_item ->> 'local_end_time',
      'crosses_midnight', v_end < v_start
    ));
  end loop;
  for i in 1 .. coalesce(array_length(v_intervals, 1), 0) loop
    for j in i + 1 .. coalesce(array_length(v_intervals, 1), 0) loop
      s1 := v_intervals[i][1]; e1 := v_intervals[i][2];
      s2 := v_intervals[j][1]; e2 := v_intervals[j][2];
      if (s1 < e2 and s2 < e1)
         or (s1 < e2 + 10080 and s2 + 10080 < e1)
         or (s1 + 10080 < e2 and s2 < e1 + 10080) then
        raise exception 'OVERLAPPING_WORK_WINDOWS' using errcode = '22023';
      end if;
    end loop;
  end loop;
  return (
    select coalesce(jsonb_agg(w order by (w ->> 'weekday')::integer, w ->> 'local_start_time'), '[]'::jsonb)
      from jsonb_array_elements(v_out) w
  );
end;
$$;

-- Complete merged settings for one version: locked defaults + the four V1 overrides (decision #64).
create function app_private.build_settings(
  p_radius_m numeric,
  p_entry_dwell_seconds integer,
  p_max_horizontal_accuracy_m numeric,
  p_operates_24_7 boolean,
  p_windows jsonb
)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_radius_m is null or p_radius_m < 150 or p_radius_m > 2000 then
    raise exception 'RADIUS_OUT_OF_BOUNDS' using errcode = '22023';
  end if;
  if p_entry_dwell_seconds is null or p_entry_dwell_seconds < 300 or p_entry_dwell_seconds > 3600 then
    raise exception 'DWELL_OUT_OF_BOUNDS' using errcode = '22023';
  end if;
  if p_max_horizontal_accuracy_m is null or p_max_horizontal_accuracy_m < 20 or p_max_horizontal_accuracy_m > 100 then
    raise exception 'ACCURACY_OUT_OF_BOUNDS' using errcode = '22023';
  end if;
  return app_private.tracking_defaults()
    || jsonb_build_object(
      'geofence_radius_m', p_radius_m,
      'entry_dwell_seconds', p_entry_dwell_seconds,
      'max_horizontal_accuracy_m', p_max_horizontal_accuracy_m,
      'operates_24_7', coalesce(p_operates_24_7, false),
      'work_windows', app_private.normalize_work_windows(coalesce(p_windows, '[]'::jsonb), coalesce(p_operates_24_7, false))
    );
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Authorization helpers for configuration and staffing
-- ---------------------------------------------------------------------------------------------
create function app_private.can_configure_project(p_project uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app_private.is_aal2() and (
    app_private.is_org_admin(app_private.project_organization(p_project))
    or app_private.has_project_role(p_project, array['SUPER']::public.project_staff_role[])
    or exists (
      select 1 from public.project_staff s
       where s.project_id = p_project and s.user_id = auth.uid() and s.status = 'ACTIVE'
         and s.role = 'PM' and s.can_configure_project
    )
  )
$$;

create function app_private.can_assign_staff(p_project uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app_private.is_aal2() and (
    app_private.is_org_admin(app_private.project_organization(p_project))
    or exists (
      select 1 from public.project_staff s
       where s.project_id = p_project and s.user_id = auth.uid() and s.status = 'ACTIVE'
         and s.role = 'PM' and s.can_assign_staff
    )
  )
$$;

-- ---------------------------------------------------------------------------------------------
-- Rate limiting (server-side; spec 09 "Rate-limit ... operator functions, ... exports")
-- ---------------------------------------------------------------------------------------------
create table app_private.rate_limit_buckets (
  bucket text not null check (length(bucket) <= 64),
  subject text not null check (length(subject) <= 128),
  window_start timestamptz not null,
  hits integer not null default 0,
  primary key (bucket, subject, window_start)
);
alter table app_private.rate_limit_buckets enable row level security;
revoke all on app_private.rate_limit_buckets from anon, authenticated, service_role;

create function app_private.consume_rate_limit(p_bucket text, p_subject text, p_limit integer, p_window_seconds integer)
returns boolean
language sql
security definer
set search_path = ''
as $$
  insert into app_private.rate_limit_buckets (bucket, subject, window_start, hits)
  values (p_bucket, p_subject, date_bin(make_interval(secs => p_window_seconds), now(), timestamptz '2000-01-01'), 1)
  on conflict (bucket, subject, window_start) do update set hits = app_private.rate_limit_buckets.hits + 1
  returning hits <= p_limit
$$;

-- Address search is for staff who create/configure projects; 30/minute and 300/hour per user.
create function public.address_lookup_allowed()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or not app_private.tenant_access_allowed() or not app_private.is_aal2() then
    return jsonb_build_object('allowed', false, 'reason', 'FORBIDDEN');
  end if;
  if not exists (
       select 1 from public.organization_members m
        where m.user_id = v_uid and m.membership_status = 'ACTIVE' and m.role in ('OWNER', 'ADMIN'))
     and not exists (
       select 1 from public.project_staff s
        where s.user_id = v_uid and s.status = 'ACTIVE' and (s.role = 'SUPER' or (s.role = 'PM' and s.can_configure_project))) then
    return jsonb_build_object('allowed', false, 'reason', 'FORBIDDEN');
  end if;
  if not app_private.consume_rate_limit('address_lookup_minute', v_uid::text, 30, 60)
     or not app_private.consume_rate_limit('address_lookup_hour', v_uid::text, 300, 3600) then
    return jsonb_build_object('allowed', false, 'reason', 'RATE_LIMITED');
  end if;
  return jsonb_build_object('allowed', true, 'reason', null);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Project creation (v1 config, circle, windows) — idempotent, audited
-- ---------------------------------------------------------------------------------------------
create function public.create_project(
  p_organization_id uuid,
  p_name text,
  p_project_number text,
  p_address text,
  p_center_lat double precision,
  p_center_lng double precision,
  p_iana_timezone text,
  p_radius_m numeric,
  p_operates_24_7 boolean,
  p_work_windows jsonb,
  p_idempotency_key uuid,
  p_entry_dwell_seconds integer default 600,
  p_max_horizontal_accuracy_m numeric default 75
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_project uuid;
  v_version uuid;
  v_settings jsonb;
begin
  if v_uid is null or not app_private.can_manage_organization(p_organization_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_idempotency_key is null then
    raise exception 'IDEMPOTENCY_KEY_REQUIRED' using errcode = '22023';
  end if;
  select id into v_project from public.projects
   where organization_id = p_organization_id and idempotency_key = p_idempotency_key;
  if v_project is not null then
    return v_project;
  end if;
  if length(btrim(coalesce(p_name, ''))) not between 1 and 200 then
    raise exception 'NAME_REQUIRED' using errcode = '22023';
  end if;
  if length(coalesce(p_project_number, '')) > 64 then
    raise exception 'PROJECT_NUMBER_TOO_LONG' using errcode = '22023';
  end if;
  if p_iana_timezone is null
     or not exists (select 1 from pg_catalog.pg_timezone_names where name = p_iana_timezone) then
    raise exception 'INVALID_TIMEZONE' using errcode = '22023';
  end if;
  if p_center_lat is null or p_center_lng is null
     or p_center_lat < -90 or p_center_lat > 90 or p_center_lng < -180 or p_center_lng > 180 then
    raise exception 'INVALID_COORDINATES' using errcode = '22023';
  end if;

  v_settings := app_private.build_settings(p_radius_m, p_entry_dwell_seconds, p_max_horizontal_accuracy_m, p_operates_24_7, p_work_windows);

  insert into public.projects (organization_id, name, project_number, address, iana_timezone, status, created_by, idempotency_key)
  values (p_organization_id, btrim(p_name), nullif(btrim(p_project_number), ''), nullif(btrim(p_address), ''),
          p_iana_timezone, 'DRAFT', v_uid, p_idempotency_key)
  returning id into v_project;

  insert into public.project_tracking_config_versions
    (project_id, version_number, effective_at, created_by, reason, settings_json, sha256, operates_24_7, idempotency_key)
  values (v_project, 1, now(), v_uid, 'Project created', v_settings, repeat('0', 64), coalesce(p_operates_24_7, false), p_idempotency_key)
  returning id into v_version;

  insert into public.project_geofences (config_version_id, project_id, center, radius_m, exit_hysteresis_m)
  values (v_version, v_project,
          extensions.st_setsrid(extensions.st_makepoint(p_center_lng, p_center_lat), 4326)::extensions.geography,
          p_radius_m, (v_settings ->> 'exit_hysteresis_m')::numeric);

  insert into public.project_work_windows (config_version_id, weekday, local_start_time, local_end_time, crosses_midnight, sort_order)
  select v_version, (w ->> 'weekday')::smallint, (w ->> 'local_start_time')::time, (w ->> 'local_end_time')::time,
         (w ->> 'crosses_midnight')::boolean, (row_number() over ())::smallint
    from jsonb_array_elements(v_settings -> 'work_windows') w;

  update public.projects set config_version_id = v_version where id = v_project;

  -- The creator is assigned as PM with configuration and staffing delegation (decision #65).
  insert into public.project_staff (project_id, user_id, role, can_configure_project, can_assign_staff, added_by)
  values (v_project, v_uid, 'PM', true, true, v_uid);

  perform app_private.write_audit('USER', v_uid, 'project.created', p_organization_id, v_project, 'project', v_project,
                                  null, jsonb_build_object('config_version', 1));
  return v_project;
end;
$$;

-- Overlap (own organization only; never reveals other tenants) and similar-name warnings.
create function public.check_project_site(
  p_organization_id uuid,
  p_name text,
  p_center_lat double precision,
  p_center_lng double precision,
  p_radius_m numeric,
  p_exclude_project uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_point extensions.geography;
begin
  if not app_private.can_manage_organization(p_organization_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  v_point := extensions.st_setsrid(extensions.st_makepoint(p_center_lng, p_center_lat), 4326)::extensions.geography;
  return jsonb_build_object(
    'overlaps', coalesce((
      select jsonb_agg(jsonb_build_object('project_id', p.id, 'name', p.name,
                                          'distance_m', round(extensions.st_distance(g.center, v_point)::numeric, 0))
                       order by extensions.st_distance(g.center, v_point))
        from public.projects p
        join public.project_geofences g on g.config_version_id = p.config_version_id
       where p.organization_id = p_organization_id
         and p.status <> 'ARCHIVED'
         and p.id is distinct from p_exclude_project
         and extensions.st_dwithin(g.center, v_point, g.radius_m + g.exit_hysteresis_m + p_radius_m + 50)
    ), '[]'::jsonb),
    'similar_names', coalesce((
      select jsonb_agg(jsonb_build_object('project_id', p.id, 'name', p.name))
        from public.projects p
       where p.organization_id = p_organization_id
         and p.id is distinct from p_exclude_project
         and extensions.similarity(lower(p.name), lower(btrim(p_name))) >= 0.5
    ), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Configuration change = new immutable version; open sessions keep their version (decision #29)
-- ---------------------------------------------------------------------------------------------
create function public.update_project_config(
  p_project_id uuid,
  p_center_lat double precision,
  p_center_lng double precision,
  p_radius_m numeric,
  p_operates_24_7 boolean,
  p_work_windows jsonb,
  p_entry_dwell_seconds integer,
  p_max_horizontal_accuracy_m numeric,
  p_reason text,
  p_confirm_sensitive boolean,
  p_idempotency_key uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_existing uuid;
  v_current public.project_tracking_config_versions%rowtype;
  v_geofence public.project_geofences%rowtype;
  v_settings jsonb;
  v_version uuid;
  v_number integer;
  v_sensitive text[] := '{}';
  v_status public.project_status;
begin
  if v_uid is null or not app_private.can_configure_project(p_project_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_idempotency_key is null then
    raise exception 'IDEMPOTENCY_KEY_REQUIRED' using errcode = '22023';
  end if;
  select id into v_existing from public.project_tracking_config_versions
   where project_id = p_project_id and idempotency_key = p_idempotency_key;
  if v_existing is not null then
    return v_existing;
  end if;

  -- Serialize concurrent changes to the same project.
  select status into v_status from public.projects where id = p_project_id for update;
  if v_status in ('COMPLETED', 'ARCHIVED') then
    raise exception 'PROJECT_CLOSED' using errcode = '22023';
  end if;
  if p_center_lat is null or p_center_lng is null
     or p_center_lat < -90 or p_center_lat > 90 or p_center_lng < -180 or p_center_lng > 180 then
    raise exception 'INVALID_COORDINATES' using errcode = '22023';
  end if;
  select v.* into v_current from public.project_tracking_config_versions v
    join public.projects p on p.config_version_id = v.id where p.id = p_project_id;
  select * into v_geofence from public.project_geofences where config_version_id = v_current.id;

  v_settings := app_private.build_settings(p_radius_m, p_entry_dwell_seconds, p_max_horizontal_accuracy_m, p_operates_24_7, p_work_windows);

  -- Sensitive changes need explicit confirmation and a reason (spec 06 "Authority and access").
  if (v_settings ->> 'operates_24_7')::boolean <> v_current.operates_24_7 then v_sensitive := v_sensitive || 'OPERATES_24_7'::text; end if;
  if p_entry_dwell_seconds < (v_current.settings_json ->> 'entry_dwell_seconds')::integer then v_sensitive := v_sensitive || 'DWELL_REDUCED'::text; end if;
  if p_max_horizontal_accuracy_m > (v_current.settings_json ->> 'max_horizontal_accuracy_m')::numeric then v_sensitive := v_sensitive || 'ACCURACY_LOOSENED'::text; end if;
  if p_radius_m > v_geofence.radius_m then v_sensitive := v_sensitive || 'GEOFENCE_ENLARGED'::text; end if;
  if extensions.st_distance(v_geofence.center,
       extensions.st_setsrid(extensions.st_makepoint(p_center_lng, p_center_lat), 4326)::extensions.geography) > 1 then
    v_sensitive := v_sensitive || 'GEOFENCE_MOVED'::text;
  end if;
  if cardinality(v_sensitive) > 0 and (not coalesce(p_confirm_sensitive, false) or length(btrim(coalesce(p_reason, ''))) < 3) then
    raise exception 'SENSITIVE_CHANGE_REQUIRES_CONFIRMATION: %', array_to_string(v_sensitive, ',') using errcode = '22023';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'REASON_REQUIRED' using errcode = '22023';
  end if;

  select coalesce(max(version_number), 0) + 1 into v_number
    from public.project_tracking_config_versions where project_id = p_project_id;

  insert into public.project_tracking_config_versions
    (project_id, version_number, effective_at, created_by, reason, settings_json, sha256, operates_24_7, idempotency_key)
  values (p_project_id, v_number, now(), v_uid, btrim(p_reason), v_settings, repeat('0', 64),
          (v_settings ->> 'operates_24_7')::boolean, p_idempotency_key)
  returning id into v_version;

  insert into public.project_geofences (config_version_id, project_id, center, radius_m, exit_hysteresis_m)
  values (v_version, p_project_id,
          extensions.st_setsrid(extensions.st_makepoint(p_center_lng, p_center_lat), 4326)::extensions.geography,
          p_radius_m, (v_settings ->> 'exit_hysteresis_m')::numeric);

  insert into public.project_work_windows (config_version_id, weekday, local_start_time, local_end_time, crosses_midnight, sort_order)
  select v_version, (w ->> 'weekday')::smallint, (w ->> 'local_start_time')::time, (w ->> 'local_end_time')::time,
         (w ->> 'crosses_midnight')::boolean, (row_number() over ())::smallint
    from jsonb_array_elements(v_settings -> 'work_windows') w;

  update public.projects set config_version_id = v_version where id = p_project_id;

  perform app_private.write_audit('USER', v_uid, 'project.config_version_created', app_private.project_organization(p_project_id),
                                  p_project_id, 'config_version', v_version, null,
                                  jsonb_build_object('version_number', v_number, 'sensitive', to_jsonb(v_sensitive)));
  return v_version;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Lifecycle: DRAFT → ACTIVE ⇄ PAUSED → COMPLETED → ARCHIVED (DRAFT may also be ARCHIVED)
-- ---------------------------------------------------------------------------------------------
create function public.set_project_status(p_project_id uuid, p_status public.project_status, p_reason text)
returns public.project_status
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_current public.project_status;
begin
  if v_uid is null or not app_private.can_configure_project(p_project_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  select status into v_current from public.projects where id = p_project_id for update;
  if v_current = p_status then
    return v_current;
  end if;
  if not (
    (v_current = 'DRAFT' and p_status in ('ACTIVE', 'ARCHIVED'))
    or (v_current = 'ACTIVE' and p_status in ('PAUSED', 'COMPLETED'))
    or (v_current = 'PAUSED' and p_status in ('ACTIVE', 'COMPLETED'))
    or (v_current = 'COMPLETED' and p_status = 'ARCHIVED')
  ) then
    raise exception 'INVALID_STATUS_TRANSITION' using errcode = '22023';
  end if;
  if p_status in ('COMPLETED', 'ARCHIVED') and length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'REASON_REQUIRED' using errcode = '22023';
  end if;
  update public.projects set status = p_status where id = p_project_id;
  perform app_private.write_audit('USER', v_uid, 'project.status_changed', app_private.project_organization(p_project_id),
                                  p_project_id, 'project', p_project_id, null,
                                  jsonb_build_object('from', v_current, 'to', p_status,
                                                     'reason', nullif(btrim(coalesce(p_reason, '')), '')));
  return p_status;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Staff invitations (bound to a verified email; accepted only by that email with MFA)
-- ---------------------------------------------------------------------------------------------
create function public.invite_project_staff(
  p_project_id uuid,
  p_email text,
  p_role public.project_staff_role,
  p_emergency_designated boolean default false,
  p_can_configure_project boolean default false,
  p_can_assign_staff boolean default false,
  p_can_approve_corrections boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_org uuid := app_private.project_organization(p_project_id);
  v_email text := lower(btrim(p_email));
  v_id uuid;
begin
  if v_uid is null or not app_private.can_assign_staff(p_project_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' then
    raise exception 'INVALID_EMAIL' using errcode = '22023';
  end if;
  -- Elevated delegations may only be granted by an organization owner/admin (decision #65).
  if (p_emergency_designated or p_can_configure_project or p_can_assign_staff or p_can_approve_corrections)
     and not app_private.is_org_admin(v_org) then
    raise exception 'DELEGATION_REQUIRES_ORG_ADMIN' using errcode = '42501';
  end if;
  if (select status from public.projects where id = p_project_id) = 'ARCHIVED' then
    raise exception 'PROJECT_CLOSED' using errcode = '22023';
  end if;
  insert into public.organization_invitations
    (organization_id, project_id, target_email, project_role, expires_at, token_hash, invited_by,
     emergency_designated, can_configure_project, can_assign_staff, can_approve_corrections)
  values (v_org, p_project_id, v_email, p_role, now() + interval '7 days',
          extensions.digest(extensions.gen_random_bytes(32), 'sha256'), v_uid,
          coalesce(p_emergency_designated, false), coalesce(p_can_configure_project, false),
          coalesce(p_can_assign_staff, false), coalesce(p_can_approve_corrections, false))
  returning id into v_id;
  perform app_private.write_audit('USER', v_uid, 'staff.invited', v_org, p_project_id, 'invitation', v_id, null,
                                  jsonb_build_object('role', p_role));
  return v_id;
end;
$$;

create function public.invite_org_admin(p_organization_id uuid, p_email text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_email text := lower(btrim(p_email));
  v_id uuid;
begin
  if v_uid is null or not app_private.is_aal2() or not app_private.is_org_owner(p_organization_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' then
    raise exception 'INVALID_EMAIL' using errcode = '22023';
  end if;
  insert into public.organization_invitations (organization_id, target_email, role, expires_at, token_hash, invited_by)
  values (p_organization_id, v_email, 'ADMIN', now() + interval '7 days',
          extensions.digest(extensions.gen_random_bytes(32), 'sha256'), v_uid)
  returning id into v_id;
  perform app_private.write_audit('USER', v_uid, 'org_admin.invited', p_organization_id, null, 'invitation', v_id);
  return v_id;
end;
$$;

-- Pending invitations addressed to the caller's verified email.
create function public.list_my_invitations()
returns table (
  invitation_id uuid,
  organization_id uuid,
  organization_name text,
  project_id uuid,
  project_name text,
  org_role public.org_role,
  project_role public.project_staff_role,
  expires_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select i.id, i.organization_id, o.name, i.project_id, p.name, i.role, i.project_role, i.expires_at
    from public.organization_invitations i
    join public.organizations o on o.id = i.organization_id
    left join public.projects p on p.id = i.project_id
    join auth.users u on u.id = auth.uid()
   where u.email is not null and u.email_confirmed_at is not null
     and i.target_email = lower(u.email)
     and i.used_at is null and i.revoked_at is null and i.expires_at > now()
     and app_private.tenant_access_allowed()
   order by i.expires_at
$$;

create function public.accept_invitation(p_invitation_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_inv public.organization_invitations%rowtype;
  v_email text;
begin
  if v_uid is null or not app_private.tenant_access_allowed() or not app_private.is_aal2() then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  select lower(u.email) into v_email from auth.users u
   where u.id = v_uid and u.email_confirmed_at is not null;
  select * into v_inv from public.organization_invitations where id = p_invitation_id for update;
  if v_inv.id is null or v_email is null or v_inv.target_email <> v_email then
    raise exception 'INVITATION_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_inv.used_at is not null or v_inv.revoked_at is not null or v_inv.expires_at <= now() then
    raise exception 'INVITATION_NOT_ACTIVE' using errcode = '22023';
  end if;
  if v_inv.project_id is null then
    insert into public.organization_members (organization_id, user_id, role, added_by)
    select v_inv.organization_id, v_uid, v_inv.role, v_inv.invited_by
     where not exists (select 1 from public.organization_members m
                        where m.organization_id = v_inv.organization_id and m.user_id = v_uid
                          and m.role = v_inv.role and m.membership_status = 'ACTIVE');
  else
    insert into public.project_staff (project_id, user_id, role, emergency_designated, can_configure_project,
                                      can_assign_staff, can_approve_corrections, added_by)
    select v_inv.project_id, v_uid, v_inv.project_role, v_inv.emergency_designated, v_inv.can_configure_project,
           v_inv.can_assign_staff, v_inv.can_approve_corrections, v_inv.invited_by
     where not exists (select 1 from public.project_staff s
                        where s.project_id = v_inv.project_id and s.user_id = v_uid
                          and s.role = v_inv.project_role and s.status = 'ACTIVE');
  end if;
  update public.organization_invitations set used_at = now() where id = p_invitation_id;
  perform app_private.write_audit('USER', v_uid, 'invitation.accepted', v_inv.organization_id, v_inv.project_id,
                                  'invitation', p_invitation_id);
end;
$$;

create function public.revoke_invitation(p_invitation_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_inv public.organization_invitations%rowtype;
begin
  select * into v_inv from public.organization_invitations where id = p_invitation_id for update;
  if v_inv.id is null
     or not (
       (v_inv.project_id is not null and app_private.can_assign_staff(v_inv.project_id))
       or (v_inv.project_id is null and app_private.is_aal2() and app_private.is_org_owner(v_inv.organization_id))
     ) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  update public.organization_invitations set revoked_at = now() where id = p_invitation_id and revoked_at is null;
  perform app_private.write_audit('USER', v_uid, 'invitation.revoked', v_inv.organization_id, v_inv.project_id,
                                  'invitation', p_invitation_id);
end;
$$;

create function public.remove_project_staff(p_staff_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_project uuid;
begin
  select project_id into v_project from public.project_staff where id = p_staff_id;
  if v_project is null or not app_private.can_assign_staff(v_project) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'REASON_REQUIRED' using errcode = '22023';
  end if;
  update public.project_staff set status = 'REVOKED', revoked_at = now()
   where id = p_staff_id and status = 'ACTIVE';
  perform app_private.write_audit('USER', v_uid, 'staff.removed', app_private.project_organization(v_project),
                                  v_project, 'project_staff', p_staff_id);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Read models for the mobile app (authorization identical to RLS)
-- ---------------------------------------------------------------------------------------------
create function public.list_my_projects()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', p.id, 'organization_id', p.organization_id, 'organization_name', o.name,
           'name', p.name, 'project_number', p.project_number, 'status', p.status,
           'address', p.address, 'iana_timezone', p.iana_timezone,
           'config_version', v.version_number, 'radius_m', g.radius_m, 'operates_24_7', v.operates_24_7
         ) order by p.status, p.name), '[]'::jsonb)
    from public.projects p
    join public.organizations o on o.id = p.organization_id
    left join public.project_tracking_config_versions v on v.id = p.config_version_id
    left join public.project_geofences g on g.config_version_id = p.config_version_id
   where app_private.can_view_roster(p.id)
$$;

create function public.get_project_detail(p_project_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if not app_private.can_view_roster(p_project_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  select jsonb_build_object(
    'project', jsonb_build_object('id', p.id, 'organization_id', p.organization_id, 'name', p.name,
                                  'project_number', p.project_number, 'address', p.address,
                                  'iana_timezone', p.iana_timezone, 'status', p.status),
    'config', jsonb_build_object(
      'version_id', v.id, 'version_number', v.version_number, 'effective_at', v.effective_at,
      'settings', v.settings_json, 'sha256', v.sha256,
      'center_lat', extensions.st_y(g.center::extensions.geometry),
      'center_lng', extensions.st_x(g.center::extensions.geometry),
      'radius_m', g.radius_m, 'exit_hysteresis_m', g.exit_hysteresis_m),
    'versions', (select coalesce(jsonb_agg(jsonb_build_object('version_number', h.version_number,
                   'effective_at', h.effective_at, 'reason', h.reason) order by h.version_number desc), '[]'::jsonb)
                   from public.project_tracking_config_versions h where h.project_id = p.id),
    'staff', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'user_id', s.user_id, 'role', s.role,
                'emergency_designated', s.emergency_designated, 'email', u.email) order by s.role), '[]'::jsonb)
                from public.project_staff s join auth.users u on u.id = s.user_id
               where s.project_id = p.id and s.status = 'ACTIVE'),
    -- Pending invitation e-mails are visible only to people who may manage project staff.
    'invitations', case when app_private.can_assign_staff(p.id) then
                    (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'email', i.target_email,
                      'role', i.project_role, 'expires_at', i.expires_at) order by i.created_at desc), '[]'::jsonb)
                      from public.organization_invitations i
                     where i.project_id = p.id and i.used_at is null and i.revoked_at is null and i.expires_at > now())
                   else '[]'::jsonb end,
    'permissions', jsonb_build_object('can_configure', app_private.can_configure_project(p.id),
                                      'can_assign_staff', app_private.can_assign_staff(p.id))
  )
  into v_result
  from public.projects p
  left join public.project_tracking_config_versions v on v.id = p.config_version_id
  left join public.project_geofences g on g.config_version_id = p.config_version_id
  where p.id = p_project_id;
  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Grants (explicit allowlist; pgTAP 001 asserts the exact set)
-- ---------------------------------------------------------------------------------------------
revoke all on function app_private.tracking_defaults(), app_private.hhmm_minutes(text),
  app_private.normalize_work_windows(jsonb, boolean),
  app_private.build_settings(numeric, integer, numeric, boolean, jsonb),
  app_private.consume_rate_limit(text, text, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function app_private.can_configure_project(uuid), app_private.can_assign_staff(uuid) to authenticated;
revoke all on function public.address_lookup_allowed(), public.create_project(uuid, text, text, text, double precision, double precision, text, numeric, boolean, jsonb, uuid, integer, numeric),
  public.check_project_site(uuid, text, double precision, double precision, numeric, uuid),
  public.update_project_config(uuid, double precision, double precision, numeric, boolean, jsonb, integer, numeric, text, boolean, uuid),
  public.set_project_status(uuid, public.project_status, text),
  public.invite_project_staff(uuid, text, public.project_staff_role, boolean, boolean, boolean, boolean),
  public.invite_org_admin(uuid, text), public.list_my_invitations(), public.accept_invitation(uuid),
  public.revoke_invitation(uuid), public.remove_project_staff(uuid, text), public.list_my_projects(),
  public.get_project_detail(uuid)
  from public, anon, service_role;
grant execute on function public.address_lookup_allowed(), public.create_project(uuid, text, text, text, double precision, double precision, text, numeric, boolean, jsonb, uuid, integer, numeric),
  public.check_project_site(uuid, text, double precision, double precision, numeric, uuid),
  public.update_project_config(uuid, double precision, double precision, numeric, boolean, jsonb, integer, numeric, text, boolean, uuid),
  public.set_project_status(uuid, public.project_status, text),
  public.invite_project_staff(uuid, text, public.project_staff_role, boolean, boolean, boolean, boolean),
  public.invite_org_admin(uuid, text), public.list_my_invitations(), public.accept_invitation(uuid),
  public.revoke_invitation(uuid), public.remove_project_staff(uuid, text), public.list_my_projects(),
  public.get_project_detail(uuid)
  to authenticated;
