-- Milestone 12 (part 2): secrets hygiene, the remaining rate limits and security flags
-- (docs/spec/09-security-privacy.md "Session and key management", "Server security": rate-limit
-- … badge issue/scan, invites, operator functions, attendance ingestion and report exports; "On
-- suspicious activity, flag and alert, do not automatically erase evidence"; decisions #132–#135).
--
-- 1. Rate-limit buckets remember their limit and the first refusal; a subject that reaches a limit
--    is copied into append-only security flags before the bucket is purged (never auto-erased).
-- 2. Report exports: the worker's own attendance (the CSV source) and staff report generation are
--    rate-limited per person.
-- 3. Phone activation: rate-limited per person and refused once account deletion was requested.
-- 4. Secrets hygiene (hourly): orientation sessions that ran past 120 minutes are expired and their
--    QR secrets deleted; revoked badge keys and revoked push tokens are deleted after 24 hours;
--    expired orientation join passes after 7 days.
-- 5. Operator RPCs to list and review flags (MFA, reason, audited; pseudonymous ids only).

-- ---------------------------------------------------------------------------------------------
-- 1. Rate-limit saturation → security flags
-- ---------------------------------------------------------------------------------------------
alter table app_private.rate_limit_buckets
  add column limit_hits integer check (limit_hits is null or limit_hits > 0),
  add column denied_at timestamptz;

-- Same contract as Milestone 04 (true = allowed). A call over the limit is refused; when the caller
-- then raises RATE_LIMITED the increment rolls back, so "reached the limit" (hits >= limit_hits) is
-- what remains visible; callers that return a refusal instead keep denied_at.
create or replace function app_private.consume_rate_limit(p_bucket text, p_subject text, p_limit integer, p_window_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hits integer;
begin
  insert into app_private.rate_limit_buckets as b (bucket, subject, window_start, hits, limit_hits)
  values (p_bucket, p_subject,
          date_bin(make_interval(secs => p_window_seconds), now(), timestamptz '2000-01-01'), 1, p_limit)
  on conflict (bucket, subject, window_start) do update
     set hits = b.hits + 1,
         limit_hits = excluded.limit_hits,
         denied_at = case when b.hits + 1 > excluded.limit_hits then coalesce(b.denied_at, now()) else b.denied_at end
  returning hits into v_hits;
  return v_hits <= p_limit;
end;
$$;

-- Same contract as Milestone 07 (units are only counted when they fit). A refusal is remembered.
create or replace function app_private.consume_rate_limit_units(
  p_bucket text,
  p_subject text,
  p_units integer,
  p_limit integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_window timestamptz := date_bin(make_interval(secs => p_window_seconds), now(), timestamptz '2000-01-01');
  v_hits integer;
begin
  if p_units < 1 then
    return false;
  end if;
  if p_units <= p_limit then
    insert into app_private.rate_limit_buckets as b (bucket, subject, window_start, hits, limit_hits)
    values (p_bucket, p_subject, v_window, p_units, p_limit)
    on conflict (bucket, subject, window_start)
    do update set hits = b.hits + excluded.hits, limit_hits = excluded.limit_hits
       where b.hits + excluded.hits <= p_limit
    returning hits into v_hits;
    if v_hits is not null then
      return true;
    end if;
  end if;
  insert into app_private.rate_limit_buckets as b (bucket, subject, window_start, hits, limit_hits, denied_at)
  values (p_bucket, p_subject, v_window, 0, p_limit, now())
  on conflict (bucket, subject, window_start)
  do update set limit_hits = excluded.limit_hits, denied_at = coalesce(b.denied_at, excluded.denied_at);
  return false;
end;
$$;

-- Append-only evidence for review. Subjects are pseudonymous ids (auth user, worker, device or
-- kiosk actor) — never phone numbers, names or coordinates. Flags never block anyone by
-- themselves; open flags are never deleted automatically.
create table app_private.security_flags (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind = 'RATE_LIMIT'),
  bucket text not null check (length(bucket) <= 64),
  subject text not null check (length(subject) <= 128),
  window_start timestamptz not null,
  hits integer not null check (hits >= 0),
  limit_hits integer not null check (limit_hits > 0),
  first_flagged_at timestamptz not null default now(),
  status text not null default 'OPEN' check (status in ('OPEN', 'REVIEWED')),
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users (id) on delete set null,
  review_note text check (review_note is null or length(btrim(review_note)) between 3 and 500),
  constraint security_flags_window_uq unique (kind, bucket, subject, window_start),
  constraint security_flags_review_ck check ((status = 'OPEN') = (reviewed_at is null))
);
create index security_flags_open_idx on app_private.security_flags (first_flagged_at) where status = 'OPEN';
alter table app_private.security_flags enable row level security;

-- Review is the only change; the evidence columns are immutable and rows are never deleted while open.
create function app_private.security_flags_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'OPEN' then
      raise exception 'SECURITY_FLAG_OPEN' using errcode = '42501';
    end if;
    return old;
  end if;
  if new.kind <> old.kind or new.bucket <> old.bucket or new.subject <> old.subject
     or new.window_start <> old.window_start or new.limit_hits <> old.limit_hits
     or new.first_flagged_at <> old.first_flagged_at or new.hits < old.hits then
    raise exception 'SECURITY_FLAG_IMMUTABLE' using errcode = '42501';
  end if;
  if old.status = 'REVIEWED' and (new.status <> 'REVIEWED' or new.reviewed_at <> old.reviewed_at
                                  or new.review_note is distinct from old.review_note) then
    raise exception 'SECURITY_FLAG_IMMUTABLE' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger security_flags_guard before update or delete on app_private.security_flags
  for each row execute function app_private.security_flags_guard();

-- Copies every bucket that reached (or was refused at) its limit into the flags; returns how many
-- new flags were raised. Runs hourly before buckets are purged, and on each operator health check.
create function app_private.record_security_flags()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_new integer;
begin
  with upserted as (
    insert into app_private.security_flags as f (kind, bucket, subject, window_start, hits, limit_hits)
    select 'RATE_LIMIT', b.bucket, b.subject, b.window_start, b.hits, b.limit_hits
      from app_private.rate_limit_buckets b
     where b.limit_hits is not null and (b.denied_at is not null or b.hits >= b.limit_hits)
    on conflict (kind, bucket, subject, window_start)
    do update set hits = excluded.hits where f.hits < excluded.hits
    returning (xmax = 0) as inserted
  )
  select count(*) filter (where inserted) into v_new from upserted;
  return v_new;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 2. Report exports
-- ---------------------------------------------------------------------------------------------
-- Staff report generation (daily-reports Edge Function, called with the caller's own JWT first).
create function public.consume_report_budget()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not app_private.tenant_access_allowed() then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  return app_private.consume_rate_limit('report_hour', auth.uid()::text, 240, 3600);
end;
$$;

-- The worker's own hours (the source of the CSV export): unchanged except the rate limit, which
-- makes the function VOLATILE (it now writes a counter).
create or replace function public.my_attendance(p_project_id uuid, p_from timestamptz, p_to timestamptz)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
set timezone = 'UTC'
as $$
declare
  v_worker uuid := app_private.current_worker_id();
begin
  if v_worker is null or not exists (
       select 1 from public.worker_enrollments e where e.project_id = p_project_id and e.worker_id = v_worker) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_to <= p_from or p_to - p_from > interval '62 days' then
    raise exception 'RANGE_INVALID' using errcode = '22023';
  end if;
  if not app_private.consume_rate_limit('attendance_export_hour', v_worker::text, 300, 3600) then
    raise exception 'RATE_LIMITED' using errcode = '22023';
  end if;
  return (
    select jsonb_build_object(
      'project', jsonb_build_object('id', p.id, 'name', p.name, 'time_zone', p.iana_timezone),
      'configs', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'config_version_id', v.id,
                 'presence_unknown_seconds', app_private.config_seconds(v.id, 'presence_unknown_seconds', 1200)))
          from public.project_tracking_config_versions v where v.project_id = p.id), '[]'::jsonb),
      'sessions', coalesce((
        select jsonb_agg(app_private.attendance_session_json(s) order by s.start_at)
          from public.attendance_sessions s
         where s.project_id = p.id and s.worker_id = v_worker and s.status <> 'VOID'
           and s.start_at < p_to and coalesce(s.end_at, s.end_latest_at, 'infinity'::timestamptz) >= p_from), '[]'::jsonb),
      'requests', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'request_id', c.id, 'session_id', c.session_id, 'status', c.status, 'reason', c.reason,
                 'proposed', c.proposed_json, 'decision_reason', c.decision_reason, 'created_at', c.created_at)
               order by c.created_at desc)
          from public.attendance_corrections c
         where c.project_id = p.id and c.worker_id = v_worker and c.channel = 'WORKER_REQUEST'
           and c.created_at > now() - interval '90 days'), '[]'::jsonb))
      from public.projects p where p.id = p_project_id);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 3. Phone activation: rate limit, and refused once account deletion was requested
-- ---------------------------------------------------------------------------------------------
create or replace function public.edge_activate_device(
  p_user_id uuid,
  p_device_id uuid,
  p_platform public.device_platform,
  p_hardware_hash text,
  p_app_version text,
  p_secret_ciphertext bytea,
  p_key_version smallint,
  p_upload_token_hash bytea
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_worker uuid;
  v_old uuid;
  v_expires timestamptz := now() + interval '30 days';
begin
  if exists (select 1 from app_private.platform_operators o where o.user_id = p_user_id and o.active)
     or exists (select 1 from app_private.account_deletion_requests r where r.auth_user_id = p_user_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  select id into v_worker from public.worker_profiles where auth_user_id = p_user_id and deleted_at is null;
  if v_worker is null then
    raise exception 'WORKER_PROFILE_REQUIRED' using errcode = '22023';
  end if;
  -- A real person activates a phone a handful of times (new phone, reinstall); ten an hour is ample.
  if not app_private.consume_rate_limit('device_activate_hour', p_user_id::text, 10, 3600) then
    raise exception 'RATE_LIMITED' using errcode = '22023';
  end if;
  -- One active personal device per worker (decision #27): the previous device is revoked first.
  select id into v_old from public.device_installations where worker_id = v_worker and active for update;
  if v_old is not null then
    update public.device_installations set active = false, deactivated_at = now() where id = v_old;
    update app_private.device_badge_secrets set revoked_at = coalesce(revoked_at, now()) where device_id = v_old;
    update app_private.device_upload_credentials set revoked_at = coalesce(revoked_at, now()) where device_id = v_old;
    update public.device_project_bindings set enabled = false, revoked_at = coalesce(revoked_at, now()) where device_id = v_old;
  end if;
  insert into public.device_installations (id, worker_id, platform, hardware_installation_hash, app_version)
  values (p_device_id, v_worker, p_platform, p_hardware_hash, p_app_version);
  if v_old is not null then
    update public.device_installations set replaced_by = p_device_id where id = v_old;
  end if;
  insert into app_private.device_badge_secrets (device_id, secret_ciphertext, key_version)
  values (p_device_id, p_secret_ciphertext, p_key_version);
  insert into app_private.device_upload_credentials (device_id, token_sha256, expires_at)
  values (p_device_id, p_upload_token_hash, v_expires);
  perform app_private.write_audit('USER', p_user_id, 'device.activated', null, null, 'device_installation', p_device_id, null,
                                  jsonb_build_object('platform', p_platform, 'replaced_device_id', v_old));
  return jsonb_build_object('device_id', p_device_id, 'worker_id', v_worker, 'replaced_device_id', v_old,
                            'upload_expires_at', v_expires);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 4. Secrets hygiene (called by the hourly privacy maintenance)
-- ---------------------------------------------------------------------------------------------
create function app_private.purge_expired_secrets(p_now timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session record;
  v_sessions integer := 0;
  v_orphans integer;
  v_badges integer;
  v_push integer;
  v_grants integer;
begin
  -- Orientation QR secrets live only while the 120-minute session is open (spec 09).
  for v_session in
    select s.id, s.revoked_at from public.orientation_sessions s
     where s.status = 'OPEN' and (s.expires_at <= p_now or s.revoked_at is not null)
     for update skip locked
  loop
    perform app_private.close_session_internal(
      v_session.id,
      case when v_session.revoked_at is not null then 'REVOKED' else 'EXPIRED' end::public.orientation_session_status);
    v_sessions := v_sessions + 1;
  end loop;
  delete from app_private.orientation_session_secrets k
   using public.orientation_sessions s
   where s.id = k.session_id and s.status <> 'OPEN';
  get diagnostics v_orphans = row_count;
  -- A revoked phone's badges are refused at once (DEVICE_REVOKED); its key is kept one day for
  -- incident review, then deleted.
  delete from app_private.device_badge_secrets where revoked_at < p_now - interval '24 hours';
  get diagnostics v_badges = row_count;
  delete from app_private.push_tokens where revoked_at < p_now - interval '24 hours';
  get diagnostics v_push = row_count;
  delete from app_private.orientation_join_grants where expires_at < p_now - interval '7 days';
  get diagnostics v_grants = row_count;
  return jsonb_build_object('orientation_sessions_expired', v_sessions,
                            'orientation_secrets_deleted', v_orphans,
                            'badge_keys_deleted', v_badges,
                            'push_tokens_deleted', v_push,
                            'join_passes_deleted', v_grants);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 5. Operator RPCs for flags (CLI only)
-- ---------------------------------------------------------------------------------------------
create function public.operator_list_security_flags(p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
set timezone = 'UTC'
as $$
declare
  v_result jsonb;
begin
  perform app_private.assert_operator(p_reason);
  perform app_private.record_security_flags();
  select coalesce(jsonb_agg(jsonb_build_object(
           'flag_id', f.id, 'bucket', f.bucket, 'subject', f.subject, 'window_start', f.window_start,
           'hits', f.hits, 'limit', f.limit_hits, 'first_flagged_at', f.first_flagged_at)
         order by f.first_flagged_at desc), '[]'::jsonb)
    into v_result
    from (select * from app_private.security_flags where status = 'OPEN'
           order by first_flagged_at desc limit 200) f;
  perform app_private.record_operator_action('SECURITY_FLAGS_LIST', null, p_reason, 'ok');
  return v_result;
end;
$$;

create function public.operator_review_security_flag(p_flag_id uuid, p_note text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := app_private.assert_operator(p_reason);
  v_flag app_private.security_flags;
begin
  if p_note is null or length(btrim(p_note)) not between 3 and 500 then
    raise exception 'REASON_REQUIRED' using errcode = '22023';
  end if;
  select * into v_flag from app_private.security_flags where id = p_flag_id for update;
  if v_flag.id is null then
    raise exception 'NOT_FOUND' using errcode = '22023';
  end if;
  if v_flag.status = 'REVIEWED' then
    raise exception 'ALREADY_REVIEWED' using errcode = '22023';
  end if;
  update app_private.security_flags
     set status = 'REVIEWED', reviewed_at = now(), reviewed_by = v_uid, review_note = btrim(p_note)
   where id = p_flag_id;
  perform app_private.record_operator_action('SECURITY_FLAG_REVIEW', null, p_reason, 'reviewed');
  return jsonb_build_object('flag_id', p_flag_id, 'status', 'REVIEWED');
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 6. Grants (deny by default; decision #57)
-- ---------------------------------------------------------------------------------------------
revoke all on table app_private.security_flags from public, anon, authenticated, service_role;

revoke all on function
  app_private.security_flags_guard(), app_private.record_security_flags(),
  app_private.purge_expired_secrets(timestamptz)
  from public, anon, authenticated, service_role;

revoke all on function
  public.consume_report_budget(), public.operator_list_security_flags(text),
  public.operator_review_security_flag(uuid, text, text)
  from public, anon, authenticated, service_role;

grant execute on function
  public.consume_report_budget(), public.operator_list_security_flags(text),
  public.operator_review_security_flag(uuid, text, text)
  to authenticated;
