-- =============================================================================================
-- Milestone 09 — mobile superintendent dashboard and map
-- (docs/spec/01 "Super mobile"; docs/spec/04 "Aggregations"; docs/spec/03 privacy assertions;
--  docs/spec/11 "Supabase private Realtime Broadcast contract"; decisions #19, #87, #104–#107).
--
-- Reads for project staff, each authorized in the database with the caller's own JWT:
--   * project_dashboard  — counts, today's arrivals/departures, per company and trade, approvals;
--   * workforce_roster   — approved workers with live presence, source and tracking health;
--   * project_map        — the site circle and recent qualified positions (location roles only).
-- Writes to workforce, enrollment and project rows queue ONE private Broadcast per transaction,
-- project and message type, sent at commit with only ids, aggregate counts and a version.
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- Live tracks: one row per worker with presence on the project, with the live staleness rule of
-- attendance_counts (decision #87). Every count and roster row below reads from here.
-- ---------------------------------------------------------------------------------------------
create function app_private.live_tracks(p_project uuid)
returns table (
  worker_id uuid,
  presence_state public.presence_state,
  session_id uuid,
  session_status public.session_status,
  start_source public.attendance_source,
  start_at timestamptz,
  witnessed boolean,
  last_seen_at timestamptz,
  counted boolean,
  went_stale boolean,
  monitoring_status text
)
language sql
stable
security definer
set search_path = ''
set timezone = 'UTC'
as $$
  select p.worker_id, p.presence_state, s.id, s.status, s.start_source, s.start_at,
         coalesce(s.witnessed, false), coalesce(s.last_seen_at, p.last_seen_at),
         -- A counted worker whose evidence is older than presence_unknown_seconds shows as unknown
         -- even before the next sweep runs.
         coalesce(s.status = 'OPEN' and p.presence_state = 'ONSITE_ESTIMATED'
           and (s.witnessed or now() < s.last_seen_at
                + make_interval(secs => app_private.config_seconds(s.config_version_id, 'presence_unknown_seconds', 1200))),
           false),
         coalesce(s.status in ('OPEN', 'PENDING_APPROVAL') and not s.witnessed and now() >= s.last_seen_at
                + make_interval(secs => app_private.config_seconds(s.config_version_id, 'presence_unknown_seconds', 1200)),
           false),
         p.monitoring_status
    from public.presence_states p
    left join public.attendance_sessions s on s.id = p.current_session_id
   where p.project_id = p_project
$$;

-- The basic counts without the caller check, so the broadcast sender can attach them.
create function app_private.project_counts(p_project uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
set timezone = 'UTC'
as $$
  with tracks as (select * from app_private.live_tracks(p_project))
  select jsonb_build_object(
    'approved_roster', (select count(*) from public.worker_enrollments e
                         where e.project_id = p_project and e.enrollment_status = 'APPROVED'),
    'estimated_onsite', (select count(distinct worker_id) from tracks where counted),
    'onsite_by_source', (select coalesce(jsonb_object_agg(start_source, n), '{}'::jsonb)
                           from (select start_source, count(*) as n from tracks where counted group by start_source) x),
    'manually_verified', (select count(*) from tracks where counted and witnessed),
    'presence_unknown', (select count(*) from tracks where presence_state = 'PRESENCE_UNKNOWN' or went_stale),
    'arriving', (select count(*) from tracks where presence_state = 'ARRIVING'),
    'unscheduled_pending', (select count(*) from tracks where presence_state = 'UNSCHEDULED_PENDING' and not went_stale),
    'departure_pending', (select count(*) from tracks where presence_state = 'DEPARTURE_PENDING'),
    'unresolved_sessions', (select count(*) from public.attendance_sessions s
                             where s.project_id = p_project and s.status in ('UNRESOLVED', 'ENDED_UNVERIFIED')),
    'visitors_onsite', (select count(*) from public.visitor_visits v where v.project_id = p_project and v.status = 'OPEN'),
    'visitors_unresolved', (select count(*) from public.visitor_visits v where v.project_id = p_project and v.status = 'UNRESOLVED'),
    'evaluated_at', now())
$$;

-- Same answer as before (staff who may read the roster), now from the shared live tracks.
create or replace function public.attendance_counts(p_project_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set timezone = 'UTC'
as $$
begin
  if auth.uid() is null or not app_private.can_view_roster(p_project_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  return app_private.project_counts(p_project_id);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Dashboard (owner, PM, superintendent, safety manager or kiosk attendant of the project, MFA)
-- ---------------------------------------------------------------------------------------------
create function public.project_dashboard(p_project_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set timezone = 'UTC'
as $$
declare
  v_project public.projects;
  v_day_start timestamptz;
  v_day_end timestamptz;
begin
  if auth.uid() is null or not app_private.can_view_roster(p_project_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  select * into v_project from public.projects where id = p_project_id;
  -- The project-local calendar day (23/24/25 h around DST).
  v_day_start := (date_trunc('day', now() at time zone v_project.iana_timezone)) at time zone v_project.iana_timezone;
  v_day_end := (date_trunc('day', now() at time zone v_project.iana_timezone) + interval '1 day') at time zone v_project.iana_timezone;
  return (
    with tracks as (select * from app_private.live_tracks(p_project_id)),
    roster as (
      select e.worker_id, e.subcontractor_id, c.canonical_name as company_name,
             nullif(btrim(e.trade), '') as trade, e.employer_status,
             coalesce(t.counted, false) as counted, coalesce(t.witnessed, false) as witnessed,
             coalesce(t.presence_state = 'PRESENCE_UNKNOWN' or t.went_stale, false) as unknown
        from public.worker_enrollments e
        left join public.subcontractor_companies c on c.id = e.subcontractor_id
        left join tracks t on t.worker_id = e.worker_id
       where e.project_id = p_project_id and e.enrollment_status = 'APPROVED')
    select jsonb_build_object(
      'project', jsonb_build_object('id', v_project.id, 'name', v_project.name, 'status', v_project.status,
                                    'iana_timezone', v_project.iana_timezone),
      'counts', app_private.project_counts(p_project_id),
      'today', jsonb_build_object(
        'local_date', to_char(now() at time zone v_project.iana_timezone, 'YYYY-MM-DD'),
        'arrivals', (select count(*) from public.attendance_sessions s
                      where s.project_id = p_project_id and s.status <> 'VOID'
                        and s.start_at >= v_day_start and s.start_at < v_day_end),
        'departures', (select count(*) from public.attendance_sessions s
                        where s.project_id = p_project_id and s.status <> 'VOID'
                          and s.end_at >= v_day_start and s.end_at < v_day_end)),
      'companies', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'company_id', subcontractor_id, 'company_name', company_name, 'approved', approved,
                 'estimated_onsite', onsite, 'manually_verified', verified, 'presence_unknown', unknown)
               order by onsite desc, company_name nulls last)
          from (select subcontractor_id, company_name, count(*) as approved,
                       count(*) filter (where counted) as onsite,
                       count(*) filter (where counted and witnessed) as verified,
                       count(*) filter (where unknown) as unknown
                  from roster group by subcontractor_id, company_name) x), '[]'::jsonb),
      'trades', coalesce((
        select jsonb_agg(jsonb_build_object('trade', trade, 'approved', approved, 'estimated_onsite', onsite)
               order by onsite desc, trade nulls last)
          from (select trade, count(*) as approved, count(*) filter (where counted) as onsite
                  from roster group by trade) x), '[]'::jsonb),
      'approvals', jsonb_build_object(
        'pending_enrollments', (select count(*) from public.worker_enrollments e
                                 where e.project_id = p_project_id and e.enrollment_status = 'PENDING'),
        'employer_pending', (select count(*) from roster where employer_status = 'PENDING_CONFIRMATION')),
      'can_view_map', app_private.can_view_locations(p_project_id),
      'evaluated_at', now())
  );
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Workforce roster: approved workers with live presence. Names, company, trade, presence,
-- source and tracking health only — no phone numbers, contacts or positions.
-- ---------------------------------------------------------------------------------------------
create function public.workforce_roster(p_project_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set timezone = 'UTC'
as $$
begin
  if auth.uid() is null or not app_private.can_view_roster(p_project_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'worker_id', e.worker_id,
             'enrollment_id', e.id,
             'legal_name', w.legal_name,
             'managed_identity', w.managed_identity,
             'company_id', e.subcontractor_id,
             'company_name', c.canonical_name,
             'trade', nullif(btrim(e.trade), ''),
             'employer_status', e.employer_status,
             'presence', case when t.worker_id is null then 'NONE'
                              when t.went_stale then 'PRESENCE_UNKNOWN'
                              else t.presence_state::text end,
             'counted', coalesce(t.counted, false),
             'source', case when t.session_status in ('OPEN', 'PENDING_APPROVAL', 'UNRESOLVED') then t.start_source end,
             'witnessed', coalesce(t.witnessed, false),
             'arrived_at', case when t.session_status in ('OPEN', 'PENDING_APPROVAL', 'UNRESOLVED') then t.start_at end,
             'last_seen_at', t.last_seen_at,
             'session_status', t.session_status,
             'needs_review', coalesce(t.session_status in ('UNRESOLVED', 'PENDING_APPROVAL')
                                      or t.presence_state = 'UNRESOLVED', false),
             'tracking', case
                           when d.id is null then 'NO_PHONE'
                           when b.id is null then 'NOT_MONITORED'
                           when t.monitoring_status = 'UNAVAILABLE' then 'MONITORING_UNAVAILABLE'
                           when app_private.credential_status(d.id) ->> 'status' in ('EXPIRED', 'NONE') then 'CREDENTIAL_EXPIRED'
                           when app_private.credential_status(d.id) ->> 'status' = 'EXPIRING' then 'CREDENTIAL_EXPIRING'
                           else 'ACTIVE' end)
           order by coalesce(t.counted, false) desc, w.legal_name, e.worker_id)
      from public.worker_enrollments e
      join public.worker_profiles w on w.id = e.worker_id
      left join public.subcontractor_companies c on c.id = e.subcontractor_id
      left join app_private.live_tracks(p_project_id) t on t.worker_id = e.worker_id
      left join public.device_installations d on d.worker_id = e.worker_id and d.active
      left join public.device_project_bindings b
             on b.device_id = d.id and b.project_id = e.project_id and b.revoked_at is null and b.enabled
     where e.project_id = p_project_id and e.enrollment_status = 'APPROVED'), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Map (decision #105): owner, PM, superintendent or safety manager of the project with MFA —
-- never attendants, foremen, workers of other projects or the platform operator. Only positions
-- the reconciler kept (onsite, qualified, privacy-approved) and that have not expired; each with
-- its time and accuracy, rounded to about 11 m, and labelled stale after location_fresh_seconds.
-- ---------------------------------------------------------------------------------------------
create function public.project_map(p_project_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set timezone = 'UTC'
as $$
declare
  v_config uuid;
  v_fresh numeric;
begin
  if auth.uid() is null or not app_private.can_view_locations(p_project_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  select config_version_id into v_config from public.projects where id = p_project_id;
  v_fresh := app_private.config_seconds(v_config, 'location_fresh_seconds', 600);
  return jsonb_build_object(
    'site', (select jsonb_build_object(
               'center_lat', extensions.st_y(g.center::extensions.geometry),
               'center_lng', extensions.st_x(g.center::extensions.geometry),
               'radius_m', g.radius_m, 'exit_hysteresis_m', g.exit_hysteresis_m)
               from public.project_geofences g where g.config_version_id = v_config),
    'fresh_seconds', v_fresh,
    'markers', coalesce((
      select jsonb_agg(jsonb_build_object(
               'worker_id', l.worker_id,
               'legal_name', w.legal_name,
               'company_name', c.canonical_name,
               'lat', round(extensions.st_y(l.position::extensions.geometry)::numeric, 4),
               'lng', round(extensions.st_x(l.position::extensions.geometry)::numeric, 4),
               'accuracy_m', round(l.horizontal_accuracy_m),
               'observed_at', l.observed_at,
               'expires_at', l.expiry_at,
               'fresh', now() < l.observed_at + make_interval(secs => v_fresh))
             order by l.observed_at desc)
        from public.latest_onsite_positions l
        join public.worker_enrollments e
          on e.project_id = l.project_id and e.worker_id = l.worker_id and e.enrollment_status = 'APPROVED'
        join public.worker_profiles w on w.id = l.worker_id
        left join public.subcontractor_companies c on c.id = e.subcontractor_id
       where l.project_id = p_project_id and l.expiry_at > now()), '[]'::jsonb),
    'evaluated_at', now());
end;
$$;

-- A worker whose enrollment stops being approved (revoked, rejected) or whose employer is
-- rejected leaves the map at once: the latest position is deleted, so neither the map nor a
-- direct read can show it (spec 03 "clear latest worker location visibility after ...
-- revocation"; review finding on PR #9). The deletion also sends WORKFORCE_CHANGED.
create function app_private.clear_position_on_enrollment_end()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.latest_onsite_positions
   where project_id = new.project_id and worker_id = new.worker_id;
  return null;
end;
$$;

create trigger enrollment_end_clears_position
  after update of enrollment_status, employer_status on public.worker_enrollments
  for each row
  when ((old.enrollment_status = 'APPROVED' and new.enrollment_status <> 'APPROVED')
        or (old.employer_status <> 'REJECTED' and new.employer_status = 'REJECTED'))
  execute function app_private.clear_position_on_enrollment_end();

-- ---------------------------------------------------------------------------------------------
-- Private Broadcast (decision #19, #104): the project-wide topic carries counts of every
-- company, so only staff who may read the whole roster receive it (foremen no longer join).
-- ---------------------------------------------------------------------------------------------
create or replace function app_private.can_receive_project_broadcast(p_project uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_project is not null and app_private.can_view_roster(p_project)
$$;

-- Messages waiting for commit: one row per (transaction, project, type). Unlogged: a row lives
-- only inside its own transaction and is deleted when the message is sent.
create unlogged table app_private.pending_broadcasts (
  txid xid8 not null default pg_current_xact_id(),
  project_id uuid not null,
  type text not null check (type in ('WORKFORCE_CHANGED', 'ENROLLMENT_CHANGED', 'REPORT_CHANGED',
                                     'MUSTER_CHANGED', 'PROJECT_CONFIG_CHANGED')),
  changed_ids uuid[] not null default '{}' check (cardinality(changed_ids) <= 100),
  overflow boolean not null default false,
  primary key (txid, project_id, type)
);
alter table app_private.pending_broadcasts enable row level security;
revoke all on app_private.pending_broadcasts from public, anon, authenticated, service_role;

-- Monotonic across all projects (no per-project row to lock at commit); clients only need order.
create sequence app_private.broadcast_version_seq as bigint minvalue 1;
revoke all on sequence app_private.broadcast_version_seq from public, anon, authenticated, service_role;

create function app_private.queue_project_broadcast(p_project uuid, p_type text, p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_project is null then
    return;
  end if;
  insert into app_private.pending_broadcasts as pb (project_id, type, changed_ids)
  values (p_project, p_type, case when p_id is null then '{}'::uuid[] else array[p_id] end)
  on conflict (txid, project_id, type) do update
     set changed_ids = case
                         when p_id is null or p_id = any(pb.changed_ids) or cardinality(pb.changed_ids) >= 100
                           then pb.changed_ids
                         else pb.changed_ids || p_id end,
         overflow = pb.overflow
                    or (p_id is not null and not p_id = any(pb.changed_ids) and cardinality(pb.changed_ids) >= 100);
end;
$$;

-- Fires once per pending row at commit (deferred), when every change of the transaction is in.
create function app_private.send_pending_broadcast()
returns trigger
language plpgsql
security definer
set search_path = ''
set timezone = 'UTC'
as $$
declare
  v_row app_private.pending_broadcasts;
  v_counts jsonb;
begin
  delete from app_private.pending_broadcasts
   where txid = new.txid and project_id = new.project_id and type = new.type
  returning * into v_row;
  if v_row.project_id is null or not exists (select 1 from public.projects where id = v_row.project_id) then
    return null;
  end if;
  v_counts := app_private.project_counts(v_row.project_id);
  -- realtime.send never raises (it logs a warning): a lost message cannot undo attendance, and
  -- clients resynchronize on reconnect, on foreground and every minute.
  perform realtime.send(
    jsonb_build_object(
      'schema_version', 1,
      'type', v_row.type,
      'project_id', v_row.project_id,
      'aggregate_version', nextval('app_private.broadcast_version_seq'),
      'counts', jsonb_build_object(
        'estimated_onsite', (v_counts ->> 'estimated_onsite')::int,
        'presence_unknown', (v_counts ->> 'presence_unknown')::int,
        'approved_roster', (v_counts ->> 'approved_roster')::int,
        'visitors_onsite', (v_counts ->> 'visitors_onsite')::int),
      -- More than 100 changes: an empty list means "refetch everything".
      'changed_ids', case when v_row.overflow then '[]'::jsonb else to_jsonb(v_row.changed_ids) end,
      'occurred_at', to_char(clock_timestamp(), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
    v_row.type,
    'project:' || v_row.project_id::text,
    true);
  return null;
end;
$$;

create constraint trigger pending_broadcast_send
  after insert on app_private.pending_broadcasts
  deferrable initially deferred
  for each row execute function app_private.send_pending_broadcast();

-- Row triggers: TG_ARGV = (message type, project id column, changed id column).
create function app_private.broadcast_row_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row jsonb := to_jsonb(case when tg_op = 'DELETE' then old else new end);
begin
  perform app_private.queue_project_broadcast(
    (v_row ->> tg_argv[1])::uuid, tg_argv[0], (v_row ->> tg_argv[2])::uuid);
  -- A row moved to another project (never expected) invalidates the old project too.
  if tg_op = 'UPDATE' and (to_jsonb(old) ->> tg_argv[1]) is distinct from (v_row ->> tg_argv[1]) then
    perform app_private.queue_project_broadcast(
      (to_jsonb(old) ->> tg_argv[1])::uuid, tg_argv[0], (to_jsonb(old) ->> tg_argv[2])::uuid);
  end if;
  return null;
end;
$$;

create trigger broadcast_presence after insert or update or delete on public.presence_states
  for each row execute function app_private.broadcast_row_change('WORKFORCE_CHANGED', 'project_id', 'worker_id');
create trigger broadcast_sessions after insert or update or delete on public.attendance_sessions
  for each row execute function app_private.broadcast_row_change('WORKFORCE_CHANGED', 'project_id', 'worker_id');
create trigger broadcast_positions after insert or update or delete on public.latest_onsite_positions
  for each row execute function app_private.broadcast_row_change('WORKFORCE_CHANGED', 'project_id', 'worker_id');
create trigger broadcast_visits after insert or update or delete on public.visitor_visits
  for each row execute function app_private.broadcast_row_change('WORKFORCE_CHANGED', 'project_id', 'visitor_id');
create trigger broadcast_enrollments after insert or update or delete on public.worker_enrollments
  for each row execute function app_private.broadcast_row_change('ENROLLMENT_CHANGED', 'project_id', 'id');
create trigger broadcast_project_config after update on public.projects
  for each row
  when (old.config_version_id is distinct from new.config_version_id or old.status is distinct from new.status
        or old.name is distinct from new.name or old.iana_timezone is distinct from new.iana_timezone)
  execute function app_private.broadcast_row_change('PROJECT_CONFIG_CHANGED', 'id', 'id');

-- ---------------------------------------------------------------------------------------------
-- Grants (deny by default; decision #57)
-- ---------------------------------------------------------------------------------------------
revoke all on function
  app_private.live_tracks(uuid), app_private.project_counts(uuid),
  app_private.clear_position_on_enrollment_end(),
  app_private.queue_project_broadcast(uuid, text, uuid), app_private.send_pending_broadcast(),
  app_private.broadcast_row_change()
  from public, anon, authenticated, service_role;

revoke all on function
  public.project_dashboard(uuid), public.workforce_roster(uuid), public.project_map(uuid)
  from public, anon, authenticated, service_role;

grant execute on function
  public.project_dashboard(uuid), public.workforce_roster(uuid), public.project_map(uuid)
  to authenticated;
