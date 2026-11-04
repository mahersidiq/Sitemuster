-- =============================================================================================
-- Milestone 10 — daily company reports, foreman confirmation, worker hours and correction requests
-- (docs/spec/04 "Report and confirmation lifecycle"; docs/spec/11 `report-confirm`; spec 06
--  `foreman_confirm_deadline_local`; spec 07 "Foreman disputes headcount", "Foreman ignores daily
--  report"; decisions #7, #8, #108–#112).
--
-- Reports are ESTIMATES of onsite presence per company and project-local day — never payroll,
-- contract proof or a back-charge. The `daily-reports` Edge Function computes them with the
-- shared rules (packages/shared/src/reports) and stores immutable versions here; a correction
-- creates a new version and the earlier one stays.
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- Report status rules: content is immutable (Milestone 02) and status moves forward only.
-- ---------------------------------------------------------------------------------------------
create or replace function app_private.report_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.summary is distinct from old.summary
     or new.project_id is distinct from old.project_id
     or new.subcontractor_id is distinct from old.subcontractor_id
     or new.local_date is distinct from old.local_date
     or new.report_version is distinct from old.report_version
     or new.supersedes_id is distinct from old.supersedes_id
     or new.generated_at is distinct from old.generated_at
     or new.due_at is distinct from old.due_at then
    raise exception 'report versions are immutable; issue a new version' using errcode = '42501';
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'PENDING_CONFIRMATION'
         and new.status in ('CONFIRMED', 'DISPUTED', 'CORRECTION_REQUESTED', 'NOT_CONFIRMED', 'SUPERSEDED'))
       or (old.status in ('CONFIRMED', 'DISPUTED', 'CORRECTION_REQUESTED', 'NOT_CONFIRMED')
           and new.status = 'SUPERSEDED')) then
    raise exception 'report status cannot move from % to %', old.status, new.status using errcode = '42501';
  end if;
  return new;
end;
$$;

-- Decisions on correction requests keep their reason and the operation that applied them.
alter table public.attendance_corrections
  add column decision_reason text check (decision_reason is null or length(btrim(decision_reason)) between 3 and 1000),
  add column resolved_by_event uuid;

-- ---------------------------------------------------------------------------------------------
-- Who may see or answer reports on a project, asked with the caller's own JWT. Null when the
-- caller has neither role there (no existence leak).
-- ---------------------------------------------------------------------------------------------
create function public.report_context(p_project_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
set timezone = 'UTC'
as $$
  select jsonb_build_object(
           'user_id', auth.uid(),
           'project_id', p.id,
           'project_status', p.status,
           'time_zone', p.iana_timezone,
           'staff', app_private.can_view_roster(p.id),
           'can_reissue', app_private.can_correct_attendance(p.id),
           'foreman_company_ids', coalesce((select jsonb_agg(c) from app_private.foreman_company_ids(p.id) c), '[]'::jsonb))
    from public.projects p
   where p.id = p_project_id
     and auth.uid() is not null
     and (app_private.can_view_roster(p.id) or app_private.is_foreman_on_project(p.id))
$$;

-- The same foreman rule as app_private.foreman_company_ids, for a given user (service paths).
create function app_private.user_foreman_company_ids(p_user uuid, p_project uuid)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.company_id
    from public.subcontractor_members m
    join public.worker_profiles w on w.id = m.worker_profile_id
    join public.project_subcontractors ps
      on ps.subcontractor_id = m.company_id and ps.project_id = p_project and ps.status = 'APPROVED'
   where w.auth_user_id = p_user
     and m.role = 'FOREMAN'
     and m.verification_status = 'VERIFIED'
     and m.valid_from <= now()
     and (m.valid_until is null or m.valid_until > now())
$$;

-- ---------------------------------------------------------------------------------------------
-- Generation inputs and storage (service role only; the Edge Function authorizes first)
-- ---------------------------------------------------------------------------------------------
create function public.edge_report_inputs(p_project uuid, p_local_date date)
returns jsonb
language sql
stable
security definer
set search_path = ''
set timezone = 'UTC'
as $$
  -- Every session that can touch the local day in any time zone (UTC-12 … UTC+14); the shared
  -- report rules clip each one to the exact project-local day.
  with day_sessions as (
    select s.* from public.attendance_sessions s
     where s.project_id = p_project and s.status <> 'VOID'
       and s.start_at < (p_local_date + 2)::timestamp at time zone 'UTC'
       and coalesce(s.end_at, s.end_latest_at, 'infinity'::timestamptz) >= (p_local_date - 1)::timestamp at time zone 'UTC')
  select public.edge_visitor_context(p_project) || jsonb_build_object(
    'project_name', (select p.name from public.projects p where p.id = p_project),
    'sessions', coalesce((select jsonb_agg(app_private.attendance_session_json(s) order by s.start_at) from day_sessions s), '[]'::jsonb),
    'corrected_session_ids', coalesce((
      select jsonb_agg(distinct c.session_id) from public.attendance_corrections c
       where c.project_id = p_project and c.status = 'APPROVED'
         and c.session_id in (select id from day_sessions)), '[]'::jsonb),
    'existing', coalesce((
      select jsonb_agg(jsonb_build_object('company_id', r.subcontractor_id, 'version', r.report_version, 'status', r.status))
        from (select distinct on (subcontractor_id) * from public.daily_company_reports
               where project_id = p_project and local_date = p_local_date
               order by subcontractor_id, report_version desc) r), '[]'::jsonb))
    where exists (select 1 from public.projects p where p.id = p_project)
$$;

-- Ended project-local days (within the last p_days) on which some company worked but has no
-- report yet: lets the foreman's pending list generate only what is missing.
create function public.edge_report_gaps(p_project uuid, p_days integer)
returns jsonb
language sql
stable
security definer
set search_path = ''
set timezone = 'UTC'
as $$
  with project as (
    select p.id, p.iana_timezone as tz, (now() at time zone p.iana_timezone)::date as today
      from public.projects p where p.id = p_project),
  touched as (
    select distinct s.employer_snapshot_id as company_id, d::date as local_date
      from project pr
      join public.attendance_sessions s on s.project_id = pr.id
      cross join lateral generate_series((s.start_at at time zone pr.tz)::date,
                                         (coalesce(s.end_at, s.end_latest_at, now()) at time zone pr.tz)::date,
                                         interval '1 day') d
     where s.status <> 'VOID' and s.employer_snapshot_id is not null
       and s.start_at >= now() - make_interval(days => least(greatest(p_days, 1), 14) + 2))
  select jsonb_build_object(
           'time_zone', pr.tz,
           'dates', coalesce((
             select jsonb_agg(distinct t.local_date order by t.local_date)
               from touched t
              where t.local_date < pr.today and t.local_date >= pr.today - least(greatest(p_days, 1), 14)
                and not exists (select 1 from public.daily_company_reports r
                                 where r.project_id = pr.id and r.subcontractor_id = t.company_id
                                   and r.local_date = t.local_date)), '[]'::jsonb))
    from project pr
$$;

-- Version 1 of each company's report for a day, once (concurrent generators insert nothing twice).
create function public.edge_store_reports(p_project uuid, p_local_date date, p_reports jsonb, p_now timestamptz default null)
returns integer
language plpgsql
security definer
set search_path = ''
set timezone = 'UTC'
as $$
declare
  r jsonb;
  v_rows integer;
  v_total integer := 0;
  v_id uuid;
begin
  if jsonb_typeof(p_reports) <> 'array' then
    raise exception 'REPORTS_INVALID' using errcode = '22023';
  end if;
  for r in select value from jsonb_array_elements(p_reports) loop
    if r -> 'summary' ->> 'company_id' is distinct from r ->> 'company_id'
       or r -> 'summary' ->> 'local_date' is distinct from p_local_date::text then
      raise exception 'REPORT_SUMMARY_MISMATCH' using errcode = '22023';
    end if;
    insert into public.daily_company_reports (project_id, subcontractor_id, local_date, report_version, summary, status, due_at)
    values (p_project, (r ->> 'company_id')::uuid, p_local_date, 1, r -> 'summary',
            case when (r ->> 'due_at')::timestamptz <= coalesce(p_now, now()) then 'NOT_CONFIRMED' else 'PENDING_CONFIRMATION' end::public.report_status,
            (r ->> 'due_at')::timestamptz)
    on conflict (project_id, subcontractor_id, local_date, report_version) do nothing
    returning id into v_id;
    get diagnostics v_rows = row_count;
    if v_rows > 0 then
      v_total := v_total + v_rows;
      perform app_private.write_audit('SYSTEM', null, 'report.generated', app_private.project_organization(p_project),
                                      p_project, 'daily_company_report', v_id, null,
                                      jsonb_build_object('local_date', p_local_date, 'version', 1));
    end if;
  end loop;
  return v_total;
end;
$$;

-- A new version after corrections (staff); the earlier version is SUPERSEDED, never changed.
create function public.edge_reissue_report(
  p_project uuid, p_company uuid, p_local_date date, p_summary jsonb, p_due_at timestamptz, p_reason text, p_actor uuid,
  p_now timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set timezone = 'UTC'
as $$
declare
  v_prev public.daily_company_reports;
  v_id uuid;
  v_version integer;
begin
  if p_reason is null or length(btrim(p_reason)) not between 3 and 1000 then
    raise exception 'REASON_REQUIRED' using errcode = '22023';
  end if;
  if p_summary ->> 'company_id' is distinct from p_company::text or p_summary ->> 'local_date' is distinct from p_local_date::text then
    raise exception 'REPORT_SUMMARY_MISMATCH' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_project::text || p_company::text || p_local_date::text, 0));
  select * into v_prev from public.daily_company_reports
   where project_id = p_project and subcontractor_id = p_company and local_date = p_local_date
   order by report_version desc limit 1;
  v_version := coalesce(v_prev.report_version, 0) + 1;
  if v_prev.id is not null then
    update public.daily_company_reports set status = 'SUPERSEDED' where id = v_prev.id;
  end if;
  insert into public.daily_company_reports (project_id, subcontractor_id, local_date, report_version, summary, status,
                                            due_at, supersedes_id)
  values (p_project, p_company, p_local_date, v_version, p_summary,
          case when p_due_at <= coalesce(p_now, now()) then 'NOT_CONFIRMED' else 'PENDING_CONFIRMATION' end::public.report_status,
          p_due_at, v_prev.id)
  returning id into v_id;
  perform app_private.write_audit('USER', p_actor, 'report.reissued', app_private.project_organization(p_project),
                                  p_project, 'daily_company_report', v_id, null,
                                  jsonb_build_object('local_date', p_local_date, 'version', v_version,
                                                     'previous_version', v_prev.report_version, 'reason', btrim(p_reason)));
  return jsonb_build_object('report_id', v_id, 'version', v_version);
end;
$$;

create function public.edge_report_ref(p_report_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('report_id', r.id, 'project_id', r.project_id, 'company_id', r.subcontractor_id,
                            'local_date', r.local_date, 'version', r.report_version, 'status', r.status)
    from public.daily_company_reports r where r.id = p_report_id
$$;

-- ---------------------------------------------------------------------------------------------
-- Foreman answer: CONFIRM, DISPUTE or SUBMIT_CORRECTION, once per version, before the deadline.
-- The report itself never changes (a dispute keeps the version exactly as issued).
-- ---------------------------------------------------------------------------------------------
create function public.edge_confirm_report(
  p_report_id uuid, p_version integer, p_action public.report_action, p_comment text, p_proposed jsonb,
  p_event_uuid uuid, p_actor uuid, p_now timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set timezone = 'UTC'
as $$
declare
  v_report public.daily_company_reports;
  v_seen public.report_confirmations;
  v_item jsonb;
  v_index integer := 0;
  v_session public.attendance_sessions;
  v_worker uuid;
  v_status public.report_status;
begin
  select * into v_seen from public.report_confirmations where event_uuid = p_event_uuid;
  if v_seen.id is not null then
    if v_seen.report_id <> p_report_id or v_seen.foreman_user_id <> p_actor then
      raise exception 'EVENT_ID_CONFLICT' using errcode = '22023';
    end if;
    select * into v_report from public.daily_company_reports where id = p_report_id;
    return jsonb_build_object('ok', true, 'report_id', v_report.id, 'version', v_seen.version,
                              'status', v_report.status, 'duplicate', true);
  end if;
  select * into v_report from public.daily_company_reports where id = p_report_id for update;
  if v_report.id is null
     or v_report.subcontractor_id not in (select app_private.user_foreman_company_ids(p_actor, v_report.project_id)) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if v_report.report_version <> p_version or v_report.status = 'SUPERSEDED' then
    return jsonb_build_object('ok', false, 'code', 'REPORT_VERSION_STALE', 'status', v_report.status);
  end if;
  if v_report.status = 'PENDING_CONFIRMATION' and v_report.due_at <= coalesce(p_now, now()) then
    update public.daily_company_reports set status = 'NOT_CONFIRMED' where id = v_report.id;
    return jsonb_build_object('ok', false, 'code', 'REPORT_DEADLINE_PASSED', 'status', 'NOT_CONFIRMED');
  end if;
  if v_report.status <> 'PENDING_CONFIRMATION' then
    return jsonb_build_object('ok', false, 'code', 'REPORT_ALREADY_ANSWERED', 'status', v_report.status);
  end if;
  if p_action <> 'CONFIRM' and (p_comment is null or length(btrim(p_comment)) not between 3 and 2000) then
    raise exception 'REASON_REQUIRED' using errcode = '22023';
  end if;

  if p_action = 'SUBMIT_CORRECTION' then
    if jsonb_typeof(p_proposed) <> 'array' or jsonb_array_length(p_proposed) not between 1 and 100 then
      raise exception 'PROPOSAL_REQUIRED' using errcode = '22023';
    end if;
    for v_item in select value from jsonb_array_elements(p_proposed) loop
      v_index := v_index + 1;
      v_worker := (v_item ->> 'worker_id')::uuid;
      -- Only workers of this report, and only their sessions in it.
      if not exists (select 1 from jsonb_array_elements(v_report.summary -> 'workers') w where w ->> 'worker_id' = v_worker::text) then
        raise exception 'WORKER_NOT_IN_REPORT' using errcode = '22023';
      end if;
      v_session := null;
      if v_item ->> 'session_id' is not null then
        if not exists (select 1 from jsonb_array_elements(v_report.summary -> 'workers') w,
                                     jsonb_array_elements(w -> 'sessions') s
                        where w ->> 'worker_id' = v_worker::text and s ->> 'session_id' = v_item ->> 'session_id') then
          raise exception 'SESSION_NOT_IN_REPORT' using errcode = '22023';
        end if;
        select * into v_session from public.attendance_sessions where id = (v_item ->> 'session_id')::uuid;
      end if;
      insert into public.attendance_corrections (session_id, project_id, worker_id, channel, requested_by, reason,
                                                 original_json, proposed_json, status, event_uuid)
      values (v_session.id, v_report.project_id, v_worker, 'FOREMAN_REQUEST', p_actor, btrim(p_comment),
              case when v_session.id is null then '{}'::jsonb
                   else jsonb_build_object('start_at', v_session.start_at, 'end_at', v_session.end_at,
                                           'start_source', v_session.start_source, 'status', v_session.status) end,
              jsonb_build_object('proposed_start_at', v_item -> 'proposed_start_at', 'proposed_end_at', v_item -> 'proposed_end_at',
                                 'note', v_item -> 'note', 'report_id', v_report.id, 'report_version', v_report.report_version),
              'PENDING', md5(p_event_uuid::text || ':' || v_index)::uuid);
    end loop;
  end if;

  insert into public.report_confirmations (report_id, version, foreman_user_id, action, comment, proposed_correction, event_uuid)
  values (v_report.id, v_report.report_version, p_actor, p_action, nullif(btrim(coalesce(p_comment, '')), ''),
          case when p_action = 'SUBMIT_CORRECTION' then p_proposed end, p_event_uuid);
  v_status := case p_action when 'CONFIRM' then 'CONFIRMED' when 'DISPUTE' then 'DISPUTED' else 'CORRECTION_REQUESTED' end;
  update public.daily_company_reports set status = v_status where id = v_report.id;
  perform app_private.write_audit('USER', p_actor, 'report.' || lower(p_action::text),
                                  app_private.project_organization(v_report.project_id), v_report.project_id,
                                  'daily_company_report', v_report.id, null,
                                  jsonb_build_object('version', v_report.report_version, 'corrections', v_index));
  return jsonb_build_object('ok', true, 'report_id', v_report.id, 'version', v_report.report_version,
                            'status', v_status, 'duplicate', false);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Reading reports (staff: every company; foreman: own companies). An overdue report shows as
-- NOT_CONFIRMED even before the sweep stores it.
-- ---------------------------------------------------------------------------------------------
create function app_private.report_views(p_reports uuid[])
returns jsonb
language sql
stable
security definer
set search_path = ''
set timezone = 'UTC'
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'report_id', r.id,
           'project_id', r.project_id,
           'project_name', p.name,
           'company_id', r.subcontractor_id,
           'company_name', c.canonical_name,
           'local_date', r.local_date,
           'version', r.report_version,
           'status', eff.status,
           'due_at', r.due_at,
           'generated_at', r.generated_at,
           'can_answer', eff.status = 'PENDING_CONFIRMATION'
                         and r.subcontractor_id in (select app_private.foreman_company_ids(r.project_id)),
           'summary', r.summary,
           'worker_names', coalesce((
             select jsonb_object_agg(w.id, w.legal_name) from public.worker_profiles w
              where w.id in (select (x ->> 'worker_id')::uuid from jsonb_array_elements(r.summary -> 'workers') x)), '{}'::jsonb),
           'answers', coalesce((
             select jsonb_agg(jsonb_build_object('version', rc.version, 'action', rc.action, 'comment', rc.comment,
                                                 'created_at', rc.created_at) order by rc.created_at)
               from public.report_confirmations rc
               join public.daily_company_reports h on h.id = rc.report_id
              where h.project_id = r.project_id and h.subcontractor_id = r.subcontractor_id
                and h.local_date = r.local_date), '[]'::jsonb),
           'earlier_versions', coalesce((
             select jsonb_agg(jsonb_build_object('version', h.report_version, 'status', h.status) order by h.report_version)
               from public.daily_company_reports h
              where h.project_id = r.project_id and h.subcontractor_id = r.subcontractor_id
                and h.local_date = r.local_date and h.report_version < r.report_version), '[]'::jsonb))
         order by r.local_date desc, c.canonical_name), '[]'::jsonb)
    from public.daily_company_reports r
    join public.projects p on p.id = r.project_id
    join public.subcontractor_companies c on c.id = r.subcontractor_id
    cross join lateral (select case when r.status = 'PENDING_CONFIRMATION' and r.due_at <= now()
                                    then 'NOT_CONFIRMED'::public.report_status else r.status end as status) eff
   where r.id = any(p_reports)
$$;

create function public.report_list(p_project_id uuid, p_local_date date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set timezone = 'UTC'
as $$
begin
  if auth.uid() is null
     or not (app_private.can_view_roster(p_project_id) or app_private.is_foreman_on_project(p_project_id)) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  return app_private.report_views(array(
    select distinct on (r.subcontractor_id) r.id from public.daily_company_reports r
     where r.project_id = p_project_id and r.local_date = p_local_date
       and (app_private.can_view_roster(p_project_id)
            or r.subcontractor_id in (select app_private.foreman_company_ids(p_project_id)))
     order by r.subcontractor_id, r.report_version desc));
end;
$$;

-- A foreman's reports still waiting for an answer, across projects.
create function public.my_pending_reports()
returns jsonb
language sql
stable
security definer
set search_path = ''
set timezone = 'UTC'
as $$
  select app_private.report_views(array(
    select r.id from public.daily_company_reports r
     where r.status = 'PENDING_CONFIRMATION' and r.due_at > now()
       and r.subcontractor_id in (select app_private.foreman_company_ids(r.project_id))
       and r.report_version = (select max(x.report_version) from public.daily_company_reports x
                                where x.project_id = r.project_id and x.subcontractor_id = r.subcontractor_id
                                  and x.local_date = r.local_date)))
$$;

-- ---------------------------------------------------------------------------------------------
-- Deadline: no answer by 12:00 on the next workday → NOT_CONFIRMED (never auto-approved).
-- ---------------------------------------------------------------------------------------------
create function app_private.report_deadline_sweep(p_now timestamptz)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows integer;
begin
  update public.daily_company_reports set status = 'NOT_CONFIRMED'
   where status = 'PENDING_CONFIRMATION' and due_at <= p_now;
  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

create function public.edge_report_deadline_sweep(p_now timestamptz)
returns integer
language sql
security definer
set search_path = ''
as $$ select app_private.report_deadline_sweep(p_now) $$;

create function app_private.scheduled_report_deadline_sweep()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if app_private.deployment_environment() = 'development' then
    return; -- tests drive the sweep explicitly
  end if;
  perform app_private.report_deadline_sweep(now());
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Live refresh for report screens (decision #104: ids only).
-- ---------------------------------------------------------------------------------------------
create trigger broadcast_reports after insert or update on public.daily_company_reports
  for each row execute function app_private.broadcast_row_change('REPORT_CHANGED', 'project_id', 'id');

-- ---------------------------------------------------------------------------------------------
-- Worker: own sessions for the Time History screen and the personal CSV; correction requests.
-- ---------------------------------------------------------------------------------------------
create function public.my_attendance(p_project_id uuid, p_from timestamptz, p_to timestamptz)
returns jsonb
language plpgsql
stable
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

create function public.request_attendance_correction(
  p_project_id uuid, p_session_id uuid, p_proposed_start_at timestamptz, p_proposed_end_at timestamptz,
  p_reason text, p_event_uuid uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set timezone = 'UTC'
as $$
declare
  v_worker uuid := app_private.current_worker_id();
  v_seen public.attendance_corrections;
  v_session public.attendance_sessions;
  v_id uuid;
begin
  if v_worker is null or not exists (
       select 1 from public.worker_enrollments e where e.project_id = p_project_id and e.worker_id = v_worker) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  select * into v_seen from public.attendance_corrections where event_uuid = p_event_uuid;
  if v_seen.id is not null then
    if v_seen.worker_id <> v_worker or v_seen.channel <> 'WORKER_REQUEST' then
      raise exception 'EVENT_ID_CONFLICT' using errcode = '22023';
    end if;
    return jsonb_build_object('request_id', v_seen.id, 'status', v_seen.status, 'duplicate', true);
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 3 and 1000 then
    raise exception 'REASON_REQUIRED' using errcode = '22023';
  end if;
  if p_proposed_start_at is null and p_proposed_end_at is null then
    raise exception 'PROPOSAL_REQUIRED' using errcode = '22023';
  end if;
  if p_proposed_start_at is not null and p_proposed_end_at is not null and p_proposed_end_at <= p_proposed_start_at then
    raise exception 'END_BEFORE_START' using errcode = '22023';
  end if;
  if greatest(p_proposed_start_at, p_proposed_end_at) > now() + interval '5 minutes' then
    raise exception 'TIME_IN_FUTURE' using errcode = '22023';
  end if;
  if p_session_id is not null then
    select * into v_session from public.attendance_sessions
     where id = p_session_id and project_id = p_project_id and worker_id = v_worker and status <> 'VOID';
    if v_session.id is null then
      raise exception 'SESSION_NOT_FOUND' using errcode = '22023';
    end if;
  elsif p_proposed_start_at is null or p_proposed_end_at is null then
    raise exception 'MISSING_VISIT_NEEDS_BOTH_TIMES' using errcode = '22023';
  end if;
  if (select count(*) from public.attendance_corrections c
       where c.project_id = p_project_id and c.worker_id = v_worker and c.status = 'PENDING') >= 20 then
    raise exception 'TOO_MANY_PENDING' using errcode = '22023';
  end if;
  insert into public.attendance_corrections (session_id, project_id, worker_id, channel, requested_by, reason,
                                             original_json, proposed_json, status, event_uuid)
  values (v_session.id, p_project_id, v_worker, 'WORKER_REQUEST', auth.uid(), btrim(p_reason),
          case when v_session.id is null then '{}'::jsonb
               else jsonb_build_object('start_at', v_session.start_at, 'end_at', v_session.end_at,
                                       'start_source', v_session.start_source, 'status', v_session.status) end,
          jsonb_build_object('proposed_start_at', p_proposed_start_at, 'proposed_end_at', p_proposed_end_at),
          'PENDING', p_event_uuid)
  returning id into v_id;
  perform app_private.write_audit('USER', auth.uid(), 'correction.requested', app_private.project_organization(p_project_id),
                                  p_project_id, 'attendance_correction', v_id, null,
                                  jsonb_build_object('channel', 'WORKER_REQUEST'));
  return jsonb_build_object('request_id', v_id, 'status', 'PENDING', 'duplicate', false);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Staff decisions on correction requests (owner, PM, superintendent with MFA). Approval applies
-- the change through the manual-correction operation (ingest-operations, with `request_id`),
-- which marks the request approved in the same reconciliation; rejection keeps a reason.
-- ---------------------------------------------------------------------------------------------
create function public.correction_requests(p_project_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set timezone = 'UTC'
as $$
begin
  if auth.uid() is null or not app_private.can_correct_attendance(p_project_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'request_id', c.id, 'worker_id', c.worker_id, 'worker_name', w.legal_name,
             'company_name', co.canonical_name, 'channel', c.channel, 'session_id', c.session_id,
             'original', c.original_json, 'proposed', c.proposed_json, 'reason', c.reason, 'status', c.status,
             'decision_reason', c.decision_reason, 'created_at', c.created_at, 'decided_at', c.action_at)
           order by (c.status = 'PENDING') desc, c.created_at desc)
      from public.attendance_corrections c
      join public.worker_profiles w on w.id = c.worker_id
      left join public.worker_enrollments e on e.project_id = c.project_id and e.worker_id = c.worker_id
                                           and e.enrollment_status in ('PENDING', 'APPROVED')
      left join public.subcontractor_companies co on co.id = e.subcontractor_id
     where c.project_id = p_project_id and c.channel in ('WORKER_REQUEST', 'FOREMAN_REQUEST')
       and (c.status = 'PENDING' or c.created_at > now() - interval '30 days')), '[]'::jsonb);
end;
$$;

create function public.reject_correction_request(p_request_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
set timezone = 'UTC'
as $$
declare
  v_request public.attendance_corrections;
begin
  select * into v_request from public.attendance_corrections where id = p_request_id for update;
  if v_request.id is null or v_request.channel not in ('WORKER_REQUEST', 'FOREMAN_REQUEST')
     or auth.uid() is null or not app_private.can_correct_attendance(v_request.project_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if v_request.status <> 'PENDING' then
    raise exception 'REQUEST_ALREADY_DECIDED' using errcode = '22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 3 and 1000 then
    raise exception 'REASON_REQUIRED' using errcode = '22023';
  end if;
  update public.attendance_corrections
     set status = 'REJECTED', approved_by = auth.uid(), action_at = now(), decision_reason = btrim(p_reason)
   where id = p_request_id;
  perform app_private.write_audit('USER', auth.uid(), 'correction.rejected', app_private.project_organization(v_request.project_id),
                                  v_request.project_id, 'attendance_correction', p_request_id, null, '{}'::jsonb);
end;
$$;

-- The operations core checks a request before the reconciler runs (service role).
create function public.edge_correction_request(p_request_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('request_id', c.id, 'project_id', c.project_id, 'worker_id', c.worker_id,
                            'session_id', c.session_id, 'status', c.status, 'channel', c.channel)
    from public.attendance_corrections c
   where c.id = p_request_id and c.channel in ('WORKER_REQUEST', 'FOREMAN_REQUEST')
$$;

-- Approval is atomic with the change itself: the staff manual correction that names a request
-- (proposed_json.request_id, written by the shared engine) marks it APPROVED in the same
-- transaction, or the whole commit fails (a request decided meanwhile is never half-applied).
create function app_private.resolve_correction_request()
returns trigger
language plpgsql
security definer
set search_path = ''
set timezone = 'UTC'
as $$
declare
  v_request public.attendance_corrections;
begin
  select * into v_request from public.attendance_corrections
   where id = (new.proposed_json ->> 'request_id')::uuid for update;
  if v_request.id is null or v_request.channel not in ('WORKER_REQUEST', 'FOREMAN_REQUEST')
     or v_request.project_id <> new.project_id or v_request.worker_id <> new.worker_id
     or (v_request.session_id is not null and v_request.session_id is distinct from new.session_id)
     or v_request.status <> 'PENDING' then
    raise exception 'CORRECTION_REQUEST_NOT_PENDING' using errcode = '55000';
  end if;
  update public.attendance_corrections
     set status = 'APPROVED', approved_by = new.approved_by, action_at = now(), resolved_by_event = new.event_uuid
   where id = v_request.id;
  perform app_private.write_audit('USER', new.approved_by, 'correction.approved', app_private.project_organization(new.project_id),
                                  new.project_id, 'attendance_correction', v_request.id, null,
                                  jsonb_build_object('operation', new.event_uuid));
  return null;
end;
$$;

create trigger resolve_correction_request after insert on public.attendance_corrections
  for each row when (new.channel = 'STAFF_MANUAL' and new.proposed_json ? 'request_id')
  execute function app_private.resolve_correction_request();

-- ---------------------------------------------------------------------------------------------
-- Foreman kiosk grants (role matrix: "own crew if kiosk role delegated"; decision #107).
-- ---------------------------------------------------------------------------------------------
create function public.foreman_kiosk_grants(p_project_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not app_private.can_correct_attendance(p_project_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'foreman_profile_id', w.id, 'name', w.legal_name, 'company_id', c.id, 'company_name', c.canonical_name,
             'can_operate_kiosk', coalesce(g.can_operate_kiosk, false))
           order by c.canonical_name, w.legal_name)
      from public.subcontractor_members m
      join public.worker_profiles w on w.id = m.worker_profile_id
      join public.subcontractor_companies c on c.id = m.company_id
      join public.project_subcontractors ps on ps.subcontractor_id = c.id and ps.project_id = p_project_id
                                           and ps.status = 'APPROVED'
      left join public.foreman_project_grants g
             on g.project_id = p_project_id and g.subcontractor_id = c.id and g.foreman_profile_id = w.id
            and g.revoked_at is null
     where m.role = 'FOREMAN' and m.verification_status = 'VERIFIED'
       and m.valid_from <= now() and (m.valid_until is null or m.valid_until > now())), '[]'::jsonb);
end;
$$;

create function public.set_foreman_kiosk_grant(
  p_project_id uuid, p_company_id uuid, p_foreman_profile_id uuid, p_enabled boolean, p_reason text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_grant public.foreman_project_grants;
begin
  if auth.uid() is null or not app_private.can_correct_attendance(p_project_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 3 and 500 then
    raise exception 'REASON_REQUIRED' using errcode = '22023';
  end if;
  if not exists (
       select 1 from public.subcontractor_members m
         join public.project_subcontractors ps on ps.subcontractor_id = m.company_id and ps.project_id = p_project_id
                                              and ps.status = 'APPROVED'
        where m.company_id = p_company_id and m.worker_profile_id = p_foreman_profile_id
          and m.role = 'FOREMAN' and m.verification_status = 'VERIFIED'
          and m.valid_from <= now() and (m.valid_until is null or m.valid_until > now())) then
    raise exception 'FOREMAN_NOT_FOUND' using errcode = '22023';
  end if;
  select * into v_grant from public.foreman_project_grants
   where project_id = p_project_id and subcontractor_id = p_company_id and foreman_profile_id = p_foreman_profile_id
     and revoked_at is null
   for update;
  if v_grant.id is not null then
    update public.foreman_project_grants set can_operate_kiosk = p_enabled where id = v_grant.id;
  elsif p_enabled then
    insert into public.foreman_project_grants (project_id, subcontractor_id, foreman_profile_id, can_operate_kiosk, granted_by)
    values (p_project_id, p_company_id, p_foreman_profile_id, true, auth.uid());
  end if;
  perform app_private.write_audit('USER', auth.uid(), case when p_enabled then 'foreman.kiosk_granted' else 'foreman.kiosk_revoked' end,
                                  app_private.project_organization(p_project_id), p_project_id, 'foreman_project_grant',
                                  p_foreman_profile_id, null, jsonb_build_object('company_id', p_company_id, 'reason', btrim(p_reason)));
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Schedules and grants (deny by default; decision #57)
-- ---------------------------------------------------------------------------------------------
select cron.schedule('sitemuster-report-deadline-sweep', '*/5 * * * *', 'select app_private.scheduled_report_deadline_sweep()');

revoke all on function
  app_private.user_foreman_company_ids(uuid, uuid), app_private.report_views(uuid[]),
  app_private.report_deadline_sweep(timestamptz), app_private.scheduled_report_deadline_sweep(),
  app_private.resolve_correction_request()
  from public, anon, authenticated, service_role;

revoke all on function
  public.report_context(uuid), public.edge_report_inputs(uuid, date), public.edge_report_gaps(uuid, integer),
  public.edge_store_reports(uuid, date, jsonb, timestamptz),
  public.edge_reissue_report(uuid, uuid, date, jsonb, timestamptz, text, uuid, timestamptz), public.edge_report_ref(uuid),
  public.edge_confirm_report(uuid, integer, public.report_action, text, jsonb, uuid, uuid, timestamptz),
  public.report_list(uuid, date), public.my_pending_reports(), public.edge_report_deadline_sweep(timestamptz),
  public.my_attendance(uuid, timestamptz, timestamptz),
  public.request_attendance_correction(uuid, uuid, timestamptz, timestamptz, text, uuid),
  public.correction_requests(uuid), public.reject_correction_request(uuid, text),
  public.edge_correction_request(uuid),
  public.foreman_kiosk_grants(uuid), public.set_foreman_kiosk_grant(uuid, uuid, uuid, boolean, text)
  from public, anon, authenticated, service_role;

grant execute on function
  public.edge_report_inputs(uuid, date), public.edge_report_gaps(uuid, integer), public.edge_store_reports(uuid, date, jsonb, timestamptz),
  public.edge_reissue_report(uuid, uuid, date, jsonb, timestamptz, text, uuid, timestamptz), public.edge_report_ref(uuid),
  public.edge_confirm_report(uuid, integer, public.report_action, text, jsonb, uuid, uuid, timestamptz),
  public.edge_report_deadline_sweep(timestamptz), public.edge_correction_request(uuid)
  to service_role;

grant execute on function
  public.report_context(uuid), public.report_list(uuid, date), public.my_pending_reports(),
  public.my_attendance(uuid, timestamptz, timestamptz),
  public.request_attendance_correction(uuid, uuid, timestamptz, timestamptz, text, uuid),
  public.correction_requests(uuid), public.reject_correction_request(uuid, text),
  public.foreman_kiosk_grants(uuid), public.set_foreman_kiosk_grant(uuid, uuid, uuid, boolean, text)
  to authenticated;
