-- =============================================================================================
-- Milestone 11 — Active Muster Mode (docs/spec/12; decisions #31, #53, #114–#120).
--
-- SUPPLEMENTAL emergency accountability, NOT a certified evacuation or life-safety system. A push
-- receipt or a worker's "I'M SAFE" never makes anyone VERIFIED_ACCOUNTED: only a physical check
-- by the safety team, the worker's own foreman or an attended kiosk does (enforced by the M02
-- constraints on muster_responses and the canonical-status guard on snapshot members).
-- =============================================================================================

-- Start/close: an assigned SAFETY role or an explicit emergency designation, with MFA (decision #53).
create function app_private.can_command_muster(p_project uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$ select app_private.has_emergency_role(p_project) $$;

-- ---------------------------------------------------------------------------------------------
-- Push tokens (Expo Push Service): the phone registers its own token; nobody else reads it.
-- ---------------------------------------------------------------------------------------------
create function public.register_push_token(p_installation_id text, p_expo_token text, p_platform public.device_platform)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_installation_id is null or length(p_installation_id) not between 8 and 128
     or p_expo_token is null or p_expo_token !~ '^Expo(nent)?PushToken\[[A-Za-z0-9_-]{8,200}\]$' then
    raise exception 'PUSH_TOKEN_INVALID' using errcode = '22023';
  end if;
  -- One active token per installation; a token moves with the person signed in on the phone.
  update app_private.push_tokens set revoked_at = now(), updated_at = now()
   where revoked_at is null
     and (installation_id = p_installation_id or expo_token = p_expo_token)
     and not (installation_id = p_installation_id and expo_token = p_expo_token and auth_user_id = v_uid);
  insert into app_private.push_tokens (auth_user_id, installation_id, expo_token, platform, last_validated_at)
  select v_uid, p_installation_id, p_expo_token, p_platform, now()
   where not exists (select 1 from app_private.push_tokens
                      where revoked_at is null and installation_id = p_installation_id
                        and expo_token = p_expo_token and auth_user_id = v_uid);
  update app_private.push_tokens set last_validated_at = now(), updated_at = now()
   where revoked_at is null and installation_id = p_installation_id and auth_user_id = v_uid;
end;
$$;

-- Sign-out: this person's tokens on this phone stop receiving alerts.
create function public.revoke_my_push_tokens(p_installation_id text)
returns void
language sql
security definer
set search_path = ''
as $$
  update app_private.push_tokens set revoked_at = now(), updated_at = now()
   where revoked_at is null and auth_user_id = auth.uid() and installation_id = p_installation_id
$$;

-- Delivery attempts are communication metadata only (never presence evidence).
create table app_private.muster_push_attempts (
  id uuid primary key default gen_random_uuid(),
  muster_id uuid not null references public.muster_events (id) on delete restrict,
  snapshot_member_id uuid not null references public.muster_snapshot_members (id) on delete restrict,
  status text not null check (status in ('SENT', 'FAILED', 'NO_DEVICE')),
  error text check (error is null or length(error) <= 200),
  attempted_at timestamptz not null default now(),
  constraint muster_push_attempts_member_uq unique (muster_id, snapshot_member_id)
);
alter table app_private.muster_push_attempts enable row level security;

-- ---------------------------------------------------------------------------------------------
-- Closing report (immutable) and append-only amendments
-- ---------------------------------------------------------------------------------------------
create table public.muster_reports (
  muster_id uuid primary key references public.muster_events (id) on delete restrict,
  report jsonb not null check (jsonb_typeof(report) = 'object' and not app_private.jsonb_has_coordinate_keys(report)),
  digest text not null check (digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);
create trigger muster_reports_immutable before update or delete on public.muster_reports
  for each row execute function app_private.forbid_mutation();
alter table public.muster_reports enable row level security;
create policy muster_reports_select on public.muster_reports
  for select to authenticated using (app_private.can_view_roster(app_private.muster_project(muster_id)));
grant select on public.muster_reports to authenticated;

-- After close nothing changes; a late offline check (observed before the close) or a commander's
-- correction is appended here, each chained to the previous by digest ("signed" amendments).
create table public.muster_amendments (
  id uuid primary key default gen_random_uuid(),
  muster_id uuid not null references public.muster_events (id) on delete restrict,
  snapshot_member_id uuid references public.muster_snapshot_members (id) on delete restrict,
  kind text not null check (kind in ('LATE_RESPONSE', 'CORRECTION')),
  action public.muster_response_action,
  channel public.muster_channel,
  actor_id uuid,
  kiosk_device_id uuid references public.kiosk_devices (id) on delete restrict,
  observed_at timestamptz not null,
  received_at timestamptz not null default now(),
  note text check (note is null or length(btrim(note)) between 3 and 2000),
  event_uuid uuid not null,
  previous_digest text check (previous_digest is null or previous_digest ~ '^[0-9a-f]{64}$'),
  digest text not null check (digest ~ '^[0-9a-f]{64}$'),
  constraint muster_amendments_event_uq unique (event_uuid),
  constraint muster_amendments_late_ck check (kind <> 'LATE_RESPONSE' or (snapshot_member_id is not null and action is not null)),
  constraint muster_amendments_correction_ck check (kind <> 'CORRECTION' or note is not null),
  -- A self report stays a self report, even late (never a physical verification).
  constraint muster_amendments_self_ck check (action is distinct from 'SELF_REPORT' or channel in ('APP', 'NOTIFICATION_ACTION'))
);
create index muster_amendments_muster_idx on public.muster_amendments (muster_id, received_at);
create trigger muster_amendments_append_only before update or delete on public.muster_amendments
  for each row execute function app_private.forbid_mutation();
alter table public.muster_amendments enable row level security;
create policy muster_amendments_select on public.muster_amendments
  for select to authenticated using (app_private.can_view_roster(app_private.muster_project(muster_id)));
grant select on public.muster_amendments to authenticated;

create function app_private.muster_amendment_consistency()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.snapshot_member_id is not null and not exists (
       select 1 from public.muster_snapshot_members m where m.id = new.snapshot_member_id and m.muster_id = new.muster_id) then
    raise exception 'amendment member does not belong to this muster' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger muster_amendment_consistency before insert on public.muster_amendments
  for each row execute function app_private.muster_amendment_consistency();

create function app_private.append_muster_amendment(
  p_muster uuid, p_member uuid, p_kind text, p_action public.muster_response_action, p_channel public.muster_channel,
  p_actor uuid, p_kiosk uuid, p_observed_at timestamptz, p_note text, p_event_uuid uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
set timezone = 'UTC'
as $$
declare
  v_previous text;
  v_digest text;
  v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('muster-amendments|' || p_muster::text, 0));
  select digest into v_previous from public.muster_amendments
   where muster_id = p_muster order by received_at desc, id desc limit 1;
  if v_previous is null then
    select digest into v_previous from public.muster_reports where muster_id = p_muster;
  end if;
  v_digest := encode(sha256(convert_to(concat_ws('|', coalesce(v_previous, ''), p_muster, p_member, p_kind, p_action,
                                                    p_channel, p_actor, p_kiosk, p_observed_at, btrim(p_note), p_event_uuid),
                                       'UTF8')), 'hex');
  insert into public.muster_amendments (muster_id, snapshot_member_id, kind, action, channel, actor_id, kiosk_device_id,
                                        observed_at, note, event_uuid, previous_digest, digest)
  values (p_muster, p_member, p_kind, p_action, p_channel, p_actor, p_kiosk, p_observed_at, nullif(btrim(p_note), ''),
          p_event_uuid, v_previous, v_digest)
  returning id into v_id;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Counts (one place for the board, the closing report and the live message)
-- ---------------------------------------------------------------------------------------------
create function app_private.muster_counts(p_muster uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'workers', jsonb_build_object(
      'total', count(*) filter (where worker_id is not null),
      'verified', count(*) filter (where worker_id is not null and canonical_status = 'VERIFIED_ACCOUNTED'),
      'self_reported', count(*) filter (where worker_id is not null and canonical_status = 'SELF_REPORTED_SAFE'),
      'unknown', count(*) filter (where worker_id is not null and canonical_status = 'STATUS_UNKNOWN'),
      'unaccounted', count(*) filter (where worker_id is not null and canonical_status = 'UNACCOUNTED'),
      'detected_at_start', count(*) filter (where worker_id is not null and source like 'ONSITE%')),
    'visitors', jsonb_build_object(
      'total', count(*) filter (where visitor_id is not null),
      'verified', count(*) filter (where visitor_id is not null and canonical_status = 'VERIFIED_ACCOUNTED'),
      'unaccounted', count(*) filter (where visitor_id is not null and canonical_status <> 'VERIFIED_ACCOUNTED')))
    from public.muster_snapshot_members where muster_id = p_muster
$$;

-- ---------------------------------------------------------------------------------------------
-- Start: one transaction freezes the roster (approved workforce + anyone detected) and every
-- open visitor visit. Concurrent starts collapse onto one ACTIVE muster (spec 12, spec 07).
-- ---------------------------------------------------------------------------------------------
create function public.start_muster(
  p_project_id uuid, p_incident_label text, p_idempotency_key uuid, p_separate boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set timezone = 'UTC'
as $$
declare
  v_uid uuid := auth.uid();
  v_project public.projects;
  v_existing public.muster_events;
  v_id uuid;
  v_digest text;
  v_counts jsonb;
begin
  if v_uid is null or not app_private.can_command_muster(p_project_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_incident_label is null or length(btrim(p_incident_label)) not between 1 and 200 then
    raise exception 'LABEL_REQUIRED' using errcode = '22023';
  end if;
  if p_idempotency_key is null then
    raise exception 'IDEMPOTENCY_KEY_REQUIRED' using errcode = '22023';
  end if;
  select * into v_project from public.projects where id = p_project_id;
  if v_project.status = 'ARCHIVED' then
    raise exception 'PROJECT_NOT_ACTIVE' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('muster-start|' || p_project_id::text, 0));
  select * into v_existing from public.muster_events where project_id = p_project_id and idempotency_key = p_idempotency_key;
  if v_existing.id is not null then
    return jsonb_build_object('muster_id', v_existing.id, 'created', false, 'duplicate', true, 'already_active', false);
  end if;
  if not coalesce(p_separate, false) then
    select * into v_existing from public.muster_events
     where project_id = p_project_id and incident_key = 'default' and status = 'ACTIVE';
    if v_existing.id is not null then
      return jsonb_build_object('muster_id', v_existing.id, 'created', false, 'duplicate', false, 'already_active', true);
    end if;
  end if;

  insert into public.muster_events (project_id, triggered_by, incident_label, incident_key, config_version_id, idempotency_key)
  values (p_project_id, v_uid, btrim(p_incident_label),
          case when coalesce(p_separate, false) then 'separate-' || p_idempotency_key::text else 'default' end,
          v_project.config_version_id, p_idempotency_key)
  returning id into v_id;

  -- Workers: every approved enrollment plus anyone the system currently detects (never silently
  -- omitted), each once, with the source and last detection the commander needs to triage.
  insert into public.muster_snapshot_members (muster_id, worker_id, employer_id, source, last_detection_at, initial_status,
                                              canonical_status)
  select v_id, w.worker_id, w.employer_id, w.source, w.last_seen_at, w.initial, w.initial
    from (
      select distinct on (c.worker_id) c.worker_id, c.employer_id, c.source, c.last_seen_at, c.initial
        from (
          select e.worker_id, e.subcontractor_id as employer_id, 0 as priority
            from public.worker_enrollments e
           where e.project_id = p_project_id and e.enrollment_status = 'APPROVED'
          union all
          select t.worker_id, s.employer_snapshot_id, 1
            from app_private.live_tracks(p_project_id) t
            left join public.attendance_sessions s on s.id = t.session_id
           where t.presence_state <> 'OFFSITE' or t.session_status in ('OPEN', 'PENDING_APPROVAL', 'UNRESOLVED')
        ) r
        left join app_private.live_tracks(p_project_id) t2 on t2.worker_id = r.worker_id
        cross join lateral (
          select r.worker_id, r.employer_id,
                 case
                   when t2.counted then left('ONSITE_' || coalesce(t2.start_source::text, 'ESTIMATED'), 64)
                   when t2.went_stale or t2.presence_state = 'PRESENCE_UNKNOWN' then 'PRESENCE_UNKNOWN'
                   when t2.session_status = 'UNRESOLVED' or t2.presence_state = 'UNRESOLVED' then 'UNRESOLVED_SESSION'
                   when t2.presence_state is not null and t2.presence_state <> 'OFFSITE' then t2.presence_state::text
                   when t2.presence_state = 'OFFSITE' then 'OFFSITE'
                   else 'ROSTER_NOT_DETECTED'
                 end as source,
                 t2.last_seen_at,
                 case
                   when t2.went_stale or t2.presence_state in ('PRESENCE_UNKNOWN', 'UNRESOLVED')
                        or t2.session_status = 'UNRESOLVED' then 'STATUS_UNKNOWN'
                   else 'UNACCOUNTED'
                 end::public.muster_member_status as initial
        ) c
       order by c.worker_id, r.priority
    ) w;

  -- Visitors: every open or unresolved visit, separately (physical confirmation needed).
  insert into public.muster_snapshot_members (muster_id, visitor_id, source, last_detection_at, initial_status, canonical_status)
  select distinct on (v.visitor_id) v_id, v.visitor_id, 'VISITOR', v.checked_in_at, 'UNACCOUNTED', 'UNACCOUNTED'
    from public.visitor_visits v
   where v.project_id = p_project_id and v.status in ('OPEN', 'UNRESOLVED')
   order by v.visitor_id, v.checked_in_at desc;

  select encode(sha256(convert_to(coalesce(string_agg(
           concat_ws('|', coalesce(m.worker_id, m.visitor_id), m.employer_id, m.source, m.last_detection_at, m.initial_status),
           ';' order by coalesce(m.worker_id, m.visitor_id)), ''), 'UTF8')), 'hex')
    into v_digest
    from public.muster_snapshot_members m where m.muster_id = v_id;
  update public.muster_events set roster_snapshot_hash = v_digest where id = v_id;

  v_counts := app_private.muster_counts(v_id);
  perform app_private.write_audit('USER', v_uid, 'muster.started', v_project.organization_id, p_project_id,
                                  'muster_event', v_id, null,
                                  jsonb_build_object('separate', coalesce(p_separate, false), 'counts', v_counts));
  return jsonb_build_object('muster_id', v_id, 'created', true, 'duplicate', false, 'already_active', false,
                            'counts', v_counts);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Responses (service role, from ingest-operations after it authorized the caller)
-- ---------------------------------------------------------------------------------------------
create function public.edge_muster_member(p_muster uuid, p_member uuid, p_worker uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('muster_id', e.id, 'project_id', e.project_id, 'muster_status', e.status,
                            'ended_at', e.ended_at, 'member_id', m.id, 'worker_id', m.worker_id,
                            'visitor_id', m.visitor_id, 'employer_id', m.employer_id,
                            'canonical_status', m.canonical_status)
    from public.muster_events e
    join public.muster_snapshot_members m on m.muster_id = e.id
   where e.id = p_muster
     and ((p_member is not null and m.id = p_member) or (p_member is null and m.worker_id = p_worker))
   limit 1
$$;

create function public.edge_muster_respond(
  p_muster uuid, p_member uuid, p_action public.muster_response_action, p_channel public.muster_channel,
  p_actor uuid, p_kiosk_device uuid, p_observed_at timestamptz, p_event_uuid uuid, p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set timezone = 'UTC'
as $$
declare
  v_muster public.muster_events;
  v_member public.muster_snapshot_members;
  v_row_status public.muster_member_status;
  v_new public.muster_member_status;
begin
  if p_action not in ('SELF_REPORT', 'PHYSICAL_VERIFICATION') then
    raise exception 'ACTION_NOT_SUPPORTED' using errcode = '22023';
  end if;
  if exists (select 1 from public.muster_responses where event_uuid = p_event_uuid)
     or exists (select 1 from public.muster_amendments where event_uuid = p_event_uuid) then
    return jsonb_build_object('result', 'duplicate');
  end if;
  -- Serializes against close: a response is either in the live roster or a late amendment.
  select * into v_muster from public.muster_events where id = p_muster for update;
  select * into v_member from public.muster_snapshot_members where id = p_member and muster_id = p_muster;
  if v_muster.id is null or v_member.id is null then
    return jsonb_build_object('result', 'rejected', 'reason', 'NOT_IN_MUSTER');
  end if;
  if v_muster.status = 'CLOSED' then
    if p_observed_at <= v_muster.ended_at then
      perform app_private.append_muster_amendment(p_muster, p_member, 'LATE_RESPONSE', p_action, p_channel, p_actor,
                                                  p_kiosk_device, p_observed_at, p_reason, p_event_uuid);
      return jsonb_build_object('result', 'accepted', 'late', true, 'status', v_member.canonical_status);
    end if;
    return jsonb_build_object('result', 'rejected', 'reason', 'MUSTER_CLOSED');
  end if;
  if p_action = 'SELF_REPORT' then
    v_row_status := 'SELF_REPORTED_SAFE';
    -- A self report never replaces a physical verification (and never becomes one).
    v_new := case when v_member.canonical_status = 'VERIFIED_ACCOUNTED' then 'VERIFIED_ACCOUNTED'
                  else 'SELF_REPORTED_SAFE' end;
  else
    v_row_status := 'VERIFIED_ACCOUNTED';
    v_new := 'VERIFIED_ACCOUNTED';
  end if;
  insert into public.muster_responses (muster_id, snapshot_member_id, action, responder_id, channel, kiosk_device_id,
                                       observed_at, reason, resulting_status, event_uuid)
  values (p_muster, p_member, p_action, p_actor, p_channel, p_kiosk_device, p_observed_at,
          nullif(left(btrim(coalesce(p_reason, '')), 1000), ''), v_row_status, p_event_uuid);
  if v_new is distinct from v_member.canonical_status then
    update public.muster_snapshot_members set canonical_status = v_new where id = p_member;
  end if;
  return jsonb_build_object('result', 'accepted', 'late', false, 'status', v_new);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Close: the commander reviews what is unresolved, acknowledges it, writes a note; the report is
-- frozen with its digest and the event can never change again (spec 12 "Close-out").
-- ---------------------------------------------------------------------------------------------
create function app_private.muster_report_json(
  p_muster uuid, p_ended_at timestamptz, p_ended_by uuid, p_note text, p_acknowledged boolean
)
returns jsonb
language sql
stable
security definer
set search_path = ''
set timezone = 'UTC'
as $$
  with e as (select * from public.muster_events where id = p_muster),
  members as (
    select m.*, coalesce(w.legal_name, v.name) as name, c.canonical_name as company_name, v.organization,
           (select u.email from auth.users u where u.id = v.host_user_id) as host,
           pa.status as push_status
      from public.muster_snapshot_members m
      left join public.worker_profiles w on w.id = m.worker_id
      left join public.visitor_records v on v.id = m.visitor_id
      left join public.subcontractor_companies c on c.id = m.employer_id
      left join app_private.muster_push_attempts pa on pa.snapshot_member_id = m.id
     where m.muster_id = p_muster)
  select jsonb_build_object(
    'schema_version', 1,
    'notice', 'SUPPLEMENTAL_NOT_LIFE_SAFETY',
    'muster_id', e.id,
    'project_id', e.project_id,
    'project_name', (select p.name from public.projects p where p.id = e.project_id),
    'incident_label', e.incident_label,
    'started_at', e.triggered_at,
    'started_by', (select u.email from auth.users u where u.id = e.triggered_by),
    'ended_at', coalesce(p_ended_at, e.ended_at),
    'ended_by', (select u.email from auth.users u where u.id = coalesce(p_ended_by, e.ended_by)),
    'closing_note', coalesce(p_note, e.closeout_note),
    'acknowledged_incomplete', coalesce(p_acknowledged, e.closeout_acknowledged_incomplete),
    'snapshot_digest', e.roster_snapshot_hash,
    'counts', app_private.muster_counts(e.id),
    'companies', coalesce((
      select jsonb_agg(jsonb_build_object('company_name', x.company_name, 'total', x.total, 'verified', x.verified,
                                          'self_reported', x.self_reported, 'unknown', x.unknown,
                                          'unaccounted', x.unaccounted) order by x.company_name nulls last)
        from (select company_name, count(*) as total,
                     count(*) filter (where canonical_status = 'VERIFIED_ACCOUNTED') as verified,
                     count(*) filter (where canonical_status = 'SELF_REPORTED_SAFE') as self_reported,
                     count(*) filter (where canonical_status = 'STATUS_UNKNOWN') as unknown,
                     count(*) filter (where canonical_status = 'UNACCOUNTED') as unaccounted
                from members where worker_id is not null group by company_name) x), '[]'::jsonb),
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
               'kind', case when m.worker_id is not null then 'WORKER' else 'VISITOR' end,
               'name', m.name, 'company_name', m.company_name, 'organization', m.organization, 'host', m.host,
               'source', m.source, 'last_detection_at', m.last_detection_at,
               'initial_status', m.initial_status, 'final_status', m.canonical_status, 'push', m.push_status,
               'responses', coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'action', r.action, 'channel', r.channel, 'at', r.observed_at, 'received_at', r.received_at,
                          'result', r.resulting_status,
                          'responder', coalesce((select wp.legal_name from public.worker_profiles wp where wp.auth_user_id = r.responder_id),
                                                (select u.email from auth.users u where u.id = r.responder_id)))
                          order by r.observed_at, r.received_at)
                   from public.muster_responses r where r.snapshot_member_id = m.id), '[]'::jsonb))
             order by (m.worker_id is null), m.canonical_status, m.company_name nulls last, m.name)
        from members m), '[]'::jsonb),
    'push', jsonb_build_object(
      'sent', (select count(*) from members where push_status = 'SENT'),
      'failed', (select count(*) from members where push_status = 'FAILED'),
      'no_device', (select count(*) from members where push_status = 'NO_DEVICE'),
      'not_attempted', (select count(*) from members where worker_id is not null and push_status is null),
      'notice', 'DELIVERY_IS_NOT_PRESENCE'))
    from e
$$;

create function public.close_muster(p_muster_id uuid, p_note text, p_acknowledge_incomplete boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
set timezone = 'UTC'
as $$
declare
  v_uid uuid := auth.uid();
  v_muster public.muster_events;
  v_unresolved integer;
  v_report jsonb;
  v_digest text;
begin
  select * into v_muster from public.muster_events where id = p_muster_id for update;
  if v_uid is null or v_muster.id is null or not app_private.can_command_muster(v_muster.project_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if v_muster.status = 'CLOSED' then
    return jsonb_build_object('muster_id', v_muster.id, 'duplicate', true, 'digest', v_muster.closeout_report_digest,
                              'counts', app_private.muster_counts(v_muster.id));
  end if;
  if p_note is null or length(btrim(p_note)) < 3 then
    raise exception 'REASON_REQUIRED' using errcode = '22023';
  end if;
  if length(btrim(p_note)) > 2000 then
    raise exception 'REASON_TOO_LONG' using errcode = '22023';
  end if;
  select count(*) into v_unresolved from public.muster_snapshot_members
   where muster_id = p_muster_id and canonical_status in ('UNACCOUNTED', 'STATUS_UNKNOWN');
  if v_unresolved > 0 and not coalesce(p_acknowledge_incomplete, false) then
    raise exception 'ACKNOWLEDGE_INCOMPLETE_REQUIRED' using errcode = '22023';
  end if;
  -- The frozen report (with who closed it and when), then the event closes in one change.
  v_report := app_private.muster_report_json(p_muster_id, now(), v_uid, btrim(p_note),
                                             coalesce(p_acknowledge_incomplete, false));
  v_digest := encode(sha256(convert_to(v_report::text, 'UTF8')), 'hex');
  insert into public.muster_reports (muster_id, report, digest) values (p_muster_id, v_report, v_digest);
  update public.muster_events
     set status = 'CLOSED', ended_at = now(), ended_by = v_uid, closeout_note = btrim(p_note),
         closeout_acknowledged_incomplete = coalesce(p_acknowledge_incomplete, false), closeout_report_digest = v_digest
   where id = p_muster_id;
  perform app_private.write_audit('USER', v_uid, 'muster.closed', app_private.project_organization(v_muster.project_id),
                                  v_muster.project_id, 'muster_event', p_muster_id, null,
                                  jsonb_build_object('unresolved', v_unresolved, 'digest', v_digest,
                                                     'acknowledged_incomplete', coalesce(p_acknowledge_incomplete, false)));
  return jsonb_build_object('muster_id', p_muster_id, 'duplicate', false, 'digest', v_digest,
                            'counts', app_private.muster_counts(p_muster_id));
end;
$$;

-- A correction after close: never edits the closed event, always a signed amendment.
create function public.amend_muster(p_muster_id uuid, p_member_id uuid, p_note text, p_event_uuid uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
set timezone = 'UTC'
as $$
declare
  v_uid uuid := auth.uid();
  v_muster public.muster_events;
  v_id uuid;
begin
  select * into v_muster from public.muster_events where id = p_muster_id;
  if v_uid is null or v_muster.id is null or not app_private.can_command_muster(v_muster.project_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if v_muster.status <> 'CLOSED' then
    raise exception 'MUSTER_NOT_CLOSED' using errcode = '22023';
  end if;
  if p_note is null or length(btrim(p_note)) < 3 then
    raise exception 'REASON_REQUIRED' using errcode = '22023';
  end if;
  if length(btrim(p_note)) > 2000 then
    raise exception 'REASON_TOO_LONG' using errcode = '22023';
  end if;
  select id into v_id from public.muster_amendments where event_uuid = p_event_uuid;
  if v_id is not null then
    return jsonb_build_object('amendment_id', v_id, 'duplicate', true);
  end if;
  v_id := app_private.append_muster_amendment(p_muster_id, p_member_id, 'CORRECTION', null, null, v_uid, null, now(),
                                              p_note, p_event_uuid);
  perform app_private.write_audit('USER', v_uid, 'muster.amended', app_private.project_organization(v_muster.project_id),
                                  v_muster.project_id, 'muster_event', p_muster_id, null,
                                  jsonb_build_object('amendment_id', v_id));
  return jsonb_build_object('amendment_id', v_id, 'duplicate', false);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Reads
-- ---------------------------------------------------------------------------------------------

-- Members as the board shows them (staff: all; foreman: own companies only).
create function app_private.muster_member_rows(p_muster uuid, p_company_ids uuid[])
returns jsonb
language sql
stable
security definer
set search_path = ''
set timezone = 'UTC'
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'member_id', m.id,
           'kind', case when m.worker_id is not null then 'WORKER' else 'VISITOR' end,
           'worker_id', m.worker_id, 'visitor_id', m.visitor_id,
           'name', coalesce(w.legal_name, v.name),
           'company_id', m.employer_id, 'company_name', c.canonical_name,
           'organization', v.organization,
           'source', m.source, 'last_detection_at', m.last_detection_at,
           'initial_status', m.initial_status, 'status', m.canonical_status,
           'push', pa.status,
           'last_response', (select jsonb_build_object('action', r.action, 'channel', r.channel, 'at', r.observed_at)
                               from public.muster_responses r where r.snapshot_member_id = m.id
                              order by r.observed_at desc, r.received_at desc limit 1))
         order by (m.worker_id is null),
                  case m.canonical_status when 'UNACCOUNTED' then 0 when 'STATUS_UNKNOWN' then 1
                                          when 'SELF_REPORTED_SAFE' then 2 else 3 end,
                  coalesce(w.legal_name, v.name)), '[]'::jsonb)
    from public.muster_snapshot_members m
    left join public.worker_profiles w on w.id = m.worker_id
    left join public.visitor_records v on v.id = m.visitor_id
    left join public.subcontractor_companies c on c.id = m.employer_id
    left join app_private.muster_push_attempts pa on pa.snapshot_member_id = m.id
   where m.muster_id = p_muster
     and (p_company_ids is null or (m.worker_id is not null and m.employer_id = any(p_company_ids)))
$$;

create function public.muster_board(p_muster_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set timezone = 'UTC'
as $$
declare
  v_muster public.muster_events;
begin
  select * into v_muster from public.muster_events where id = p_muster_id;
  if auth.uid() is null or v_muster.id is null or not app_private.can_view_roster(v_muster.project_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'muster_id', v_muster.id, 'project_id', v_muster.project_id,
    'project_name', (select p.name from public.projects p where p.id = v_muster.project_id),
    'incident_label', v_muster.incident_label, 'status', v_muster.status,
    'started_at', v_muster.triggered_at, 'ended_at', v_muster.ended_at,
    'evaluated_at', now(),
    'can_command', app_private.can_command_muster(v_muster.project_id),
    'can_verify_visitors', app_private.can_command_muster(v_muster.project_id)
                           or app_private.can_run_visitor_desk(v_muster.project_id),
    'counts', app_private.muster_counts(v_muster.id),
    'companies', coalesce((
      select jsonb_agg(jsonb_build_object('company_id', x.employer_id, 'company_name', x.company_name, 'total', x.total,
                                          'verified', x.verified, 'self_reported', x.self_reported,
                                          'unknown', x.unknown, 'unaccounted', x.unaccounted)
                       order by x.company_name nulls last)
        from (select m.employer_id, c.canonical_name as company_name, count(*) as total,
                     count(*) filter (where m.canonical_status = 'VERIFIED_ACCOUNTED') as verified,
                     count(*) filter (where m.canonical_status = 'SELF_REPORTED_SAFE') as self_reported,
                     count(*) filter (where m.canonical_status = 'STATUS_UNKNOWN') as unknown,
                     count(*) filter (where m.canonical_status = 'UNACCOUNTED') as unaccounted
                from public.muster_snapshot_members m
                left join public.subcontractor_companies c on c.id = m.employer_id
               where m.muster_id = v_muster.id and m.worker_id is not null
               group by m.employer_id, c.canonical_name) x), '[]'::jsonb),
    'push', jsonb_build_object(
      'sent', (select count(*) from app_private.muster_push_attempts a where a.muster_id = v_muster.id and a.status = 'SENT'),
      'failed', (select count(*) from app_private.muster_push_attempts a where a.muster_id = v_muster.id and a.status = 'FAILED'),
      'no_device', (select count(*) from app_private.muster_push_attempts a where a.muster_id = v_muster.id and a.status = 'NO_DEVICE')),
    'members', app_private.muster_member_rows(v_muster.id, null));
end;
$$;

-- Active and recent musters of a project (staff).
create function public.project_musters(p_project_id uuid)
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
  return jsonb_build_object(
    'can_command', app_private.can_command_muster(p_project_id),
    'musters', coalesce((
      select jsonb_agg(jsonb_build_object('muster_id', e.id, 'incident_label', e.incident_label, 'status', e.status,
                                          'started_at', e.triggered_at, 'ended_at', e.ended_at,
                                          'counts', app_private.muster_counts(e.id))
                       order by (e.status = 'ACTIVE') desc, e.triggered_at desc)
        from public.muster_events e
       where e.project_id = p_project_id
         and (e.status = 'ACTIVE' or e.triggered_at > now() - interval '30 days')), '[]'::jsonb));
end;
$$;

-- The signed-in worker's active musters (their own member row only).
create function public.my_active_musters()
returns jsonb
language sql
stable
security definer
set search_path = ''
set timezone = 'UTC'
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'muster_id', e.id, 'project_id', e.project_id, 'project_name', p.name,
           'incident_label', e.incident_label, 'started_at', e.triggered_at,
           'member_id', m.id, 'status', m.canonical_status,
           'self_reported', exists (select 1 from public.muster_responses r
                                     where r.snapshot_member_id = m.id and r.action = 'SELF_REPORT'))
         order by e.triggered_at desc), '[]'::jsonb)
    from public.muster_snapshot_members m
    join public.muster_events e on e.id = m.muster_id and e.status = 'ACTIVE'
    join public.projects p on p.id = e.project_id
   where app_private.current_worker_id() is not null and m.worker_id = app_private.current_worker_id()
$$;

-- A foreman's active musters and their own companies' members (spec 12: own company only).
create function public.foreman_active_musters()
returns jsonb
language sql
stable
security definer
set search_path = ''
set timezone = 'UTC'
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'muster_id', e.id, 'project_id', e.project_id, 'project_name', p.name,
           'incident_label', e.incident_label, 'started_at', e.triggered_at)
         order by e.triggered_at desc), '[]'::jsonb)
    from public.muster_events e
    join public.projects p on p.id = e.project_id
   where e.status = 'ACTIVE' and app_private.is_foreman_on_project(e.project_id)
$$;

create function public.foreman_muster(p_muster_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set timezone = 'UTC'
as $$
declare
  v_muster public.muster_events;
  v_companies uuid[];
begin
  select * into v_muster from public.muster_events where id = p_muster_id;
  if auth.uid() is null or v_muster.id is null then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  v_companies := array(select app_private.foreman_company_ids(v_muster.project_id));
  if cardinality(v_companies) = 0 then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'muster_id', v_muster.id, 'project_id', v_muster.project_id,
    'project_name', (select p.name from public.projects p where p.id = v_muster.project_id),
    'incident_label', v_muster.incident_label, 'status', v_muster.status,
    'started_at', v_muster.triggered_at, 'evaluated_at', now(),
    'members', app_private.muster_member_rows(v_muster.id, v_companies));
end;
$$;

-- The frozen report and its amendments (staff).
create function public.muster_report(p_muster_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set timezone = 'UTC'
as $$
declare
  v_muster public.muster_events;
  v_report public.muster_reports;
begin
  select * into v_muster from public.muster_events where id = p_muster_id;
  if auth.uid() is null or v_muster.id is null or not app_private.can_view_roster(v_muster.project_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  select * into v_report from public.muster_reports where muster_id = p_muster_id;
  if v_report.muster_id is null then
    raise exception 'MUSTER_NOT_CLOSED' using errcode = '22023';
  end if;
  return jsonb_build_object(
    'report', v_report.report, 'digest', v_report.digest,
    'can_amend', app_private.can_command_muster(v_muster.project_id),
    'amendments', coalesce((
      select jsonb_agg(jsonb_build_object(
               'kind', a.kind, 'action', a.action, 'channel', a.channel, 'observed_at', a.observed_at,
               'received_at', a.received_at, 'note', a.note, 'digest', a.digest,
               'member_name', (select coalesce(w.legal_name, v.name) from public.muster_snapshot_members m
                                 left join public.worker_profiles w on w.id = m.worker_id
                                 left join public.visitor_records v on v.id = m.visitor_id
                                where m.id = a.snapshot_member_id),
               'actor', coalesce((select wp.legal_name from public.worker_profiles wp where wp.auth_user_id = a.actor_id),
                                 (select u.email from auth.users u where u.id = a.actor_id)))
             order by a.received_at)
        from public.muster_amendments a where a.muster_id = p_muster_id), '[]'::jsonb));
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Push targets and delivery records (service role; the muster-start function)
-- ---------------------------------------------------------------------------------------------
create function public.edge_muster_push_targets(p_muster uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('member_id', m.id, 'token', t.expo_token, 'locale', w.primary_language)
                            order by m.id), '[]'::jsonb)
    from public.muster_snapshot_members m
    join public.worker_profiles w on w.id = m.worker_id
    join app_private.push_tokens t on t.auth_user_id = w.auth_user_id and t.revoked_at is null
    join public.muster_events e on e.id = m.muster_id and e.status = 'ACTIVE'
   where m.muster_id = p_muster
$$;

-- Records each member's push outcome once; members without a token are NO_DEVICE.
create function public.edge_muster_record_push(p_muster uuid, p_results jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows integer;
begin
  insert into app_private.muster_push_attempts (muster_id, snapshot_member_id, status, error)
  select p_muster, (r ->> 'member_id')::uuid,
         case when r ->> 'status' = 'ok' then 'SENT' else 'FAILED' end, left(r ->> 'error', 200)
    from jsonb_array_elements(coalesce(p_results, '[]'::jsonb)) r
    join public.muster_snapshot_members m on m.id = (r ->> 'member_id')::uuid and m.muster_id = p_muster
  on conflict (muster_id, snapshot_member_id) do nothing;
  insert into app_private.muster_push_attempts (muster_id, snapshot_member_id, status)
  select p_muster, m.id, 'NO_DEVICE'
    from public.muster_snapshot_members m
   where m.muster_id = p_muster and m.worker_id is not null
  on conflict (muster_id, snapshot_member_id) do nothing;
  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- The operations context learns muster roles (ingest-operations, caller's JWT).
-- ---------------------------------------------------------------------------------------------
create or replace function public.operation_context(p_project_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_project public.projects;
  v_staff_kiosk boolean;
  v_worker uuid := app_private.current_worker_id();
begin
  if v_uid is null then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  select * into v_project from public.projects where id = p_project_id;
  if v_project.id is null then
    return jsonb_build_object('user_id', v_uid, 'project_id', null, 'project_status', null, 'kiosk', null,
                              'visitors', false, 'correct', false, 'foreman_company_ids', '[]'::jsonb,
                              'muster_command', false, 'muster_worker_id', null);
  end if;
  v_staff_kiosk := app_private.is_aal2()
                   and app_private.has_project_role(p_project_id, array['ATTENDANT']::public.project_staff_role[]);
  return jsonb_build_object(
    'user_id', v_uid,
    'project_id', v_project.id,
    'project_status', v_project.status,
    'kiosk', case when v_staff_kiosk then 'ALL'
                  when app_private.foreman_has_grant(p_project_id, 'kiosk') then 'OWN_CREW' end,
    'visitors', app_private.can_run_visitor_desk(p_project_id),
    'correct', app_private.can_correct_attendance(p_project_id),
    'foreman_company_ids', coalesce((select jsonb_agg(c) from app_private.foreman_company_ids(p_project_id) c), '[]'::jsonb),
    'muster_command', app_private.can_command_muster(p_project_id),
    -- The caller as a worker in one of this project's muster rosters (self reports only).
    'muster_worker_id', case when v_worker is not null and exists (
                               select 1 from public.muster_snapshot_members m
                                 join public.muster_events e on e.id = m.muster_id
                                where e.project_id = p_project_id and m.worker_id = v_worker)
                             then v_worker end);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Live refresh (decision #104: staff topic, ids only)
-- ---------------------------------------------------------------------------------------------
create trigger broadcast_musters after insert or update on public.muster_events
  for each row execute function app_private.broadcast_row_change('MUSTER_CHANGED', 'project_id', 'id');

create function app_private.broadcast_muster_member_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app_private.queue_project_broadcast(app_private.muster_project(new.muster_id), 'MUSTER_CHANGED', new.muster_id);
  return null;
end;
$$;
create trigger broadcast_muster_members after update on public.muster_snapshot_members
  for each row execute function app_private.broadcast_muster_member_change();
create trigger broadcast_muster_responses after insert on public.muster_responses
  for each row execute function app_private.broadcast_muster_member_change();
create trigger broadcast_muster_amendments after insert on public.muster_amendments
  for each row execute function app_private.broadcast_muster_member_change();

-- ---------------------------------------------------------------------------------------------
-- Grants (deny by default; decision #57)
-- ---------------------------------------------------------------------------------------------
revoke all on table app_private.muster_push_attempts from public, anon, authenticated, service_role;
revoke all on table public.muster_reports, public.muster_amendments from public, anon, service_role;
revoke insert, update, delete, truncate, references, trigger on public.muster_reports, public.muster_amendments
  from authenticated;

revoke all on function
  app_private.can_command_muster(uuid), app_private.append_muster_amendment(uuid, uuid, text, public.muster_response_action,
    public.muster_channel, uuid, uuid, timestamptz, text, uuid),
  app_private.muster_counts(uuid), app_private.muster_report_json(uuid, timestamptz, uuid, text, boolean),
  app_private.muster_member_rows(uuid, uuid[]),
  app_private.muster_amendment_consistency(), app_private.broadcast_muster_member_change()
  from public, anon, authenticated, service_role;

revoke all on function
  public.register_push_token(text, text, public.device_platform), public.revoke_my_push_tokens(text),
  public.start_muster(uuid, text, uuid, boolean), public.edge_muster_member(uuid, uuid, uuid),
  public.edge_muster_respond(uuid, uuid, public.muster_response_action, public.muster_channel, uuid, uuid, timestamptz, uuid, text),
  public.close_muster(uuid, text, boolean), public.amend_muster(uuid, uuid, text, uuid),
  public.muster_board(uuid), public.project_musters(uuid), public.my_active_musters(), public.foreman_active_musters(),
  public.foreman_muster(uuid), public.muster_report(uuid),
  public.edge_muster_push_targets(uuid), public.edge_muster_record_push(uuid, jsonb)
  from public, anon, authenticated, service_role;

grant execute on function
  public.edge_muster_member(uuid, uuid, uuid),
  public.edge_muster_respond(uuid, uuid, public.muster_response_action, public.muster_channel, uuid, uuid, timestamptz, uuid, text),
  public.edge_muster_push_targets(uuid), public.edge_muster_record_push(uuid, jsonb)
  to service_role;

grant execute on function
  public.register_push_token(text, text, public.device_platform), public.revoke_my_push_tokens(text),
  public.start_muster(uuid, text, uuid, boolean), public.close_muster(uuid, text, boolean),
  public.amend_muster(uuid, uuid, text, uuid), public.muster_board(uuid), public.project_musters(uuid),
  public.my_active_musters(), public.foreman_active_musters(), public.foreman_muster(uuid), public.muster_report(uuid)
  to authenticated;
