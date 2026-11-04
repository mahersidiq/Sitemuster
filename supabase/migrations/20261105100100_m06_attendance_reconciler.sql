-- Milestone 06 — transactional attendance reconciler (decisions #78–#86).
--
-- The attendance RULES live in one place: the pure TypeScript engine (packages/shared/src/
-- attendance), run by Edge Functions and by the deterministic replay harness. This migration
-- gives the database the parts that must be authoritative under concurrency:
--   * the persisted track state (presence_states) and session columns the engine needs;
--   * invariants: at most one OPEN/PENDING_APPROVAL/UNRESOLVED session per project and worker
--     (existing index), NO overlapping sessions (exclusion constraint), session/event ownership
--     tied to one project and worker, immutable identity, coordinate-free state;
--   * edge_attendance_load / edge_attendance_commit: atomic compare-and-swap of one track
--     (optimistic revision + advisory lock), idempotent on event uuids;
--   * attendance_sweep: the time rules only (stale → PRESENCE_UNKNOWN, close-out → UNRESOLVED,
--     unscheduled → authorized, arrival lapse, visitor close-out) using instants the engine
--     stored, so no calendar or DST logic is duplicated in SQL; parity is proven by replaying
--     every fixture against this database (tests/backend/replay-database.test.ts);
--   * attendance_counts: live basic counts for project staff;
--   * a pg_cron job running the sweep every minute outside development.

-- ---------------------------------------------------------------------------------------------
-- Track state and session columns
-- ---------------------------------------------------------------------------------------------
alter table public.attendance_sessions
  add column closeout_at timestamptz,
  add column authorize_at timestamptz,
  add column authorized_closeout_at timestamptz,
  add column window_start_at timestamptz,
  add column window_end_at timestamptz,
  add column unscheduled boolean not null default false,
  add column unscheduled_until timestamptz,
  add column overtime_approved_at timestamptz,
  add column overtime_approved_by uuid,
  add column witnessed boolean not null default false,
  add column evidence_gaps jsonb not null default '[]'::jsonb,
  add column review_reasons text[] not null default '{}',
  add column unresolved_at timestamptz,
  add column start_confidence public.evidence_confidence not null default 'MEDIUM',
  add column opened_by_event uuid,
  add constraint sessions_gaps_ck check (
    jsonb_typeof(evidence_gaps) = 'array' and jsonb_array_length(evidence_gaps) <= 200
    and not app_private.jsonb_has_coordinate_keys(evidence_gaps)
  ),
  add constraint sessions_closed_has_end_ck check (status <> 'CLOSED' or end_at is not null),
  add constraint sessions_ended_unverified_ck check (
    status <> 'ENDED_UNVERIFIED' or (end_at is null and end_latest_at is not null)
  ),
  add constraint sessions_review_reasons_ck check (cardinality(review_reasons) <= 20),
  -- The session's configuration version must belong to the same project.
  add constraint sessions_config_project_fk foreign key (config_version_id, project_id)
    references public.project_tracking_config_versions (id, project_id),
  add constraint sessions_owner_uq unique (id, project_id, worker_id),
  -- No two sessions of one worker on one project may overlap (an unresolved end counts up to its
  -- latest bound, an open session up to infinity), so time is never counted twice.
  add constraint sessions_no_overlap exclude using gist (
    project_id with =,
    worker_id with =,
    tstzrange(start_at, coalesce(end_at, end_latest_at, 'infinity'::timestamptz), '[)') with &&
  ) where (status <> 'VOID');

alter table public.attendance_events
  add constraint attendance_events_config_project_fk foreign key (config_version_id, project_id)
    references public.project_tracking_config_versions (id, project_id),
  add constraint attendance_events_session_owner_fk foreign key (session_id, project_id, worker_id)
    references public.attendance_sessions (id, project_id, worker_id);

alter table app_private.location_event_receipts
  add constraint receipts_config_project_fk foreign key (config_version_id, project_id)
    references public.project_tracking_config_versions (id, project_id);

alter table public.presence_states
  add column revision bigint not null default 0 check (revision >= 0),
  add column monitoring_status text not null default 'ACTIVE' check (monitoring_status in ('ACTIVE', 'UNAVAILABLE')),
  add column flags text[] not null default '{}' check (cardinality(flags) <= 20),
  add column candidate_started_at timestamptz,
  add column candidate_first_event uuid,
  add column candidate_last_evidence_at timestamptz,
  add column candidate_config_version_id uuid,
  add column candidate_closeout_at timestamptz,
  add column evaluated_at timestamptz,
  add column presence_closeout_at timestamptz,
  add column require_enter_after timestamptz,
  add column continuity_break_at timestamptz,
  add column current_session_id uuid,
  add column previous_session_id uuid,
  add constraint presence_candidate_ck check (
    (candidate_started_at is null) = (candidate_last_evidence_at is null)
    and (candidate_started_at is null) = (candidate_config_version_id is null)
    and (candidate_started_at is null) = (candidate_closeout_at is null)
  ),
  add constraint presence_config_project_fk foreign key (config_version_id, project_id)
    references public.project_tracking_config_versions (id, project_id),
  add constraint presence_candidate_config_fk foreign key (candidate_config_version_id, project_id)
    references public.project_tracking_config_versions (id, project_id),
  add constraint presence_current_session_fk foreign key (current_session_id, project_id, worker_id)
    references public.attendance_sessions (id, project_id, worker_id),
  add constraint presence_previous_session_fk foreign key (previous_session_id, project_id, worker_id)
    references public.attendance_sessions (id, project_id, worker_id);

alter table public.visitor_visits add column closeout_at timestamptz;
create unique index visitor_visits_one_open_uq on public.visitor_visits (project_id, visitor_id) where status = 'OPEN';
create index attendance_sessions_open_idx on public.attendance_sessions (status) where status in ('OPEN', 'PENDING_APPROVAL');

-- Session identity is immutable; VOID sessions are final; sessions are never deleted (except the
-- documented retention purge path).
create function app_private.attendance_session_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.project_id <> old.project_id or new.worker_id <> old.worker_id
     or new.config_version_id <> old.config_version_id
     or new.opened_by_event is distinct from old.opened_by_event then
    raise exception 'attendance session identity is immutable' using errcode = '42501';
  end if;
  if old.status = 'VOID' then
    raise exception 'void attendance sessions are immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger attendance_session_guard before update on public.attendance_sessions
  for each row execute function app_private.attendance_session_guard();
create trigger attendance_session_no_delete before delete on public.attendance_sessions
  for each row execute function app_private.forbid_mutation();

-- ---------------------------------------------------------------------------------------------
-- Load (service role only): one track with everything the engine needs
-- ---------------------------------------------------------------------------------------------
create function app_private.config_seconds(p_config uuid, p_key text, p_default numeric)
returns numeric
language sql
stable
set search_path = ''
as $$
  select coalesce((select (v.settings_json ->> p_key)::numeric
                     from public.project_tracking_config_versions v where v.id = p_config), p_default)
$$;

create function app_private.attendance_session_json(s public.attendance_sessions)
returns jsonb
language sql
stable
set search_path = ''
set timezone = 'UTC'
as $$
  select jsonb_build_object(
    'id', s.id, 'projectId', s.project_id, 'workerId', s.worker_id, 'status', s.status,
    'startAt', s.start_at, 'startSource', s.start_source, 'startConfidence', s.start_confidence,
    'endAt', s.end_at, 'endSource', s.end_source, 'endEarliestAt', s.end_earliest_at,
    'endLatestAt', s.end_latest_at, 'configVersionId', s.config_version_id, 'timezone', s.iana_timezone,
    'lastSeenAt', coalesce(s.last_seen_at, s.start_at), 'lastConfirmedInsideAt', s.last_confirmed_inside_at,
    'closeoutAt', coalesce(s.closeout_at, s.start_at + interval '16 hours'), 'authorizeAt', s.authorize_at,
    'authorizedCloseoutAt', s.authorized_closeout_at, 'windowStartAt', s.window_start_at,
    'windowEndAt', s.window_end_at, 'unscheduled', s.unscheduled, 'unscheduledUntil', s.unscheduled_until,
    'overtimeApprovedAt', s.overtime_approved_at, 'overtimeApprovedBy', s.overtime_approved_by,
    'witnessed', s.witnessed, 'gaps', s.evidence_gaps, 'reviewReasons', to_jsonb(s.review_reasons),
    'unresolvedAt', s.unresolved_at, 'openedByEvent', coalesce(s.opened_by_event, s.id),
    'employerSnapshotId', s.employer_snapshot_id)
$$;

create function public.edge_attendance_load(
  p_project uuid,
  p_worker uuid,
  p_event_uuids uuid[],
  p_session_ids uuid[]
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set timezone = 'UTC'
as $$
declare
  v_project public.projects;
  v_enrollment public.worker_enrollments;
  v_reason text;
  v_track jsonb;
  p public.presence_states;
begin
  select * into v_project from public.projects where id = p_project;
  if v_project.id is null then
    raise exception 'PROJECT_NOT_FOUND' using errcode = '22023';
  end if;
  select * into v_enrollment from public.worker_enrollments e
   where e.project_id = p_project and e.worker_id = p_worker
   order by (e.enrollment_status = 'APPROVED') desc, e.created_at desc limit 1;
  -- Attendance eligibility (decision #56): approved enrollment, verified employer when a company
  -- is claimed, and an active acknowledgement of the project notice.
  v_reason := case
    when v_enrollment.id is null or v_enrollment.enrollment_status <> 'APPROVED' then 'ENROLLMENT_NOT_APPROVED'
    when v_enrollment.subcontractor_id is not null and v_enrollment.employer_status <> 'VERIFIED' then 'EMPLOYER_NOT_VERIFIED'
    when not exists (select 1 from public.tracking_consents c
                      where c.worker_id = p_worker and c.project_id = p_project and c.withdrawn_at is null) then 'CONSENT_MISSING'
  end;
  select * into p from public.presence_states where project_id = p_project and worker_id = p_worker;
  if p.project_id is not null then
    v_track := jsonb_build_object(
      'projectId', p.project_id, 'workerId', p.worker_id, 'revision', p.revision,
      'presence', p.presence_state, 'presenceChangedAt', p.changed_at, 'confidence', p.confidence,
      'monitoring', p.monitoring_status,
      'candidate', case when p.candidate_started_at is null then null else jsonb_build_object(
        'startedAt', p.candidate_started_at, 'firstInsideAt', p.first_inside_at,
        'firstInsideEvent', p.candidate_first_event, 'lastEvidenceAt', p.candidate_last_evidence_at,
        'configVersionId', p.candidate_config_version_id, 'closeoutAt', p.candidate_closeout_at) end,
      'lastSeenAt', p.last_seen_at, 'lastConfirmedInsideAt', p.last_confirmed_inside_at,
      'arrivalConfirmedAt', p.arrival_confirmed_at, 'evaluatedAt', p.evaluated_at,
      'presenceCloseoutAt', p.presence_closeout_at, 'requireEnterAfter', p.require_enter_after,
      'continuityBreakAt', p.continuity_break_at, 'flags', to_jsonb(p.flags),
      'configVersionId', p.config_version_id,
      'current', (select app_private.attendance_session_json(s) from public.attendance_sessions s where s.id = p.current_session_id),
      'previous', (select app_private.attendance_session_json(s) from public.attendance_sessions s where s.id = p.previous_session_id));
  end if;
  return jsonb_build_object(
    'project', jsonb_build_object('id', v_project.id, 'status', v_project.status, 'timezone', v_project.iana_timezone),
    'configs', coalesce((
      select jsonb_agg(jsonb_build_object(
               'configVersionId', v.id, 'projectId', v.project_id, 'versionNumber', v.version_number,
               'effectiveAt', v.effective_at, 'settings', v.settings_json,
               'center', jsonb_build_object('lat', extensions.st_y(g.center::extensions.geometry),
                                            'lng', extensions.st_x(g.center::extensions.geometry)),
               'radiusM', g.radius_m, 'exitHysteresisM', g.exit_hysteresis_m) order by v.version_number)
        from public.project_tracking_config_versions v
        join public.project_geofences g on g.config_version_id = v.id
       where v.project_id = p_project), '[]'::jsonb),
    'eligibility', jsonb_build_object('eligible', v_reason is null, 'reason', v_reason,
                                      'employerId', v_enrollment.subcontractor_id),
    'duplicates', coalesce((
      select jsonb_agg(u) from unnest(coalesce(p_event_uuids, '{}')) u
       where exists (select 1 from app_private.location_event_receipts r where r.event_uuid = u)
          or exists (select 1 from public.attendance_events e where e.event_uuid = u)
          or exists (select 1 from public.attendance_corrections c where c.event_uuid = u)), '[]'::jsonb),
    'track', v_track,
    'extraSessions', coalesce((
      select jsonb_agg(app_private.attendance_session_json(s)) from public.attendance_sessions s
       where s.id = any(coalesce(p_session_ids, '{}')) and s.project_id = p_project and s.worker_id = p_worker), '[]'::jsonb),
    'lastPosition', (
      select jsonb_build_object('lat', extensions.st_y(l.position::extensions.geometry),
                                'lng', extensions.st_x(l.position::extensions.geometry),
                                'accuracyM', l.horizontal_accuracy_m, 'observedAt', l.observed_at)
        from public.latest_onsite_positions l where l.project_id = p_project and l.worker_id = p_worker));
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Commit (service role only): atomic compare-and-swap of one track
-- ---------------------------------------------------------------------------------------------
create function public.edge_attendance_commit(p_changeset jsonb)
returns text
language plpgsql
security definer
set search_path = ''
set timezone = 'UTC'
as $$
declare
  v_project uuid := (p_changeset ->> 'projectId')::uuid;
  v_worker uuid := (p_changeset ->> 'workerId')::uuid;
  v_expected bigint := (p_changeset ->> 'expectedRevision')::bigint;
  v_state jsonb := p_changeset -> 'state';
  v_sessions jsonb := coalesce(p_changeset -> 'sessions', '[]'::jsonb);
  v_events jsonb := coalesce(p_changeset -> 'events', '[]'::jsonb);
  v_receipts jsonb := coalesce(p_changeset -> 'receipts', '[]'::jsonb);
  v_corrections jsonb := coalesce(p_changeset -> 'corrections', '[]'::jsonb);
  v_position jsonb := p_changeset -> 'position';
  v_current bigint;
  v jsonb;
  c jsonb;
begin
  if v_project is null or v_worker is null or v_expected is null or v_state is null
     or (v_state ->> 'projectId')::uuid is distinct from v_project
     or (v_state ->> 'workerId')::uuid is distinct from v_worker then
    raise exception 'INVALID_CHANGESET' using errcode = '22023';
  end if;
  -- Only the latest map position may carry coordinates; everything persisted here is coordinate-free.
  if app_private.jsonb_has_coordinate_keys(v_state) or app_private.jsonb_has_coordinate_keys(v_sessions)
     or app_private.jsonb_has_coordinate_keys(v_events) or app_private.jsonb_has_coordinate_keys(v_receipts)
     or app_private.jsonb_has_coordinate_keys(v_corrections) then
    raise exception 'COORDINATES_NOT_PERMITTED' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(v_sessions) s
              where (s ->> 'projectId')::uuid is distinct from v_project
                 or (s ->> 'workerId')::uuid is distinct from v_worker) then
    raise exception 'INVALID_CHANGESET' using errcode = '22023';
  end if;

  -- One writer per track at a time; a stale revision means another writer won: retry from a load.
  perform pg_advisory_xact_lock(hashtextextended(v_project::text || '|' || v_worker::text, 0));
  select revision into v_current from public.presence_states
   where project_id = v_project and worker_id = v_worker for update;
  if coalesce(v_current, 0) <> v_expected then
    return 'conflict';
  end if;
  if exists (select 1 from jsonb_array_elements(v_receipts) r
              join app_private.location_event_receipts x on x.event_uuid = (r ->> 'event_uuid')::uuid)
     or exists (select 1 from jsonb_array_elements(v_events) r
                 join public.attendance_events x on x.event_uuid = (r ->> 'event_uuid')::uuid)
     or exists (select 1 from jsonb_array_elements(v_corrections) r
                 join public.attendance_corrections x on x.event_uuid = (r ->> 'event_uuid')::uuid) then
    return 'conflict';
  end if;

  begin
    -- Existing sessions first (an unresolved session is bounded before a new one opens).
    for v in
      select value from jsonb_array_elements(v_sessions)
       order by exists (select 1 from public.attendance_sessions s where s.id = (value ->> 'id')::uuid) desc
    loop
      insert into public.attendance_sessions (
        id, project_id, worker_id, employer_snapshot_id, start_at, end_at, start_source, end_source,
        config_version_id, status, end_earliest_at, end_latest_at, last_seen_at, last_confirmed_inside_at,
        iana_timezone, closeout_at, authorize_at, authorized_closeout_at, window_start_at, window_end_at,
        unscheduled, unscheduled_until, overtime_approved_at, overtime_approved_by, witnessed,
        evidence_gaps, review_reasons, unresolved_at, start_confidence, opened_by_event)
      values (
        (v ->> 'id')::uuid, v_project, v_worker, (v ->> 'employerSnapshotId')::uuid,
        (v ->> 'startAt')::timestamptz, (v ->> 'endAt')::timestamptz,
        (v ->> 'startSource')::public.attendance_source, (v ->> 'endSource')::public.attendance_source,
        (v ->> 'configVersionId')::uuid, (v ->> 'status')::public.session_status,
        (v ->> 'endEarliestAt')::timestamptz, (v ->> 'endLatestAt')::timestamptz,
        (v ->> 'lastSeenAt')::timestamptz, (v ->> 'lastConfirmedInsideAt')::timestamptz,
        v ->> 'timezone', (v ->> 'closeoutAt')::timestamptz, (v ->> 'authorizeAt')::timestamptz,
        (v ->> 'authorizedCloseoutAt')::timestamptz, (v ->> 'windowStartAt')::timestamptz,
        (v ->> 'windowEndAt')::timestamptz, coalesce((v ->> 'unscheduled')::boolean, false),
        (v ->> 'unscheduledUntil')::timestamptz, (v ->> 'overtimeApprovedAt')::timestamptz,
        (v ->> 'overtimeApprovedBy')::uuid, coalesce((v ->> 'witnessed')::boolean, false),
        coalesce(v -> 'gaps', '[]'::jsonb),
        array(select jsonb_array_elements_text(coalesce(v -> 'reviewReasons', '[]'::jsonb))),
        (v ->> 'unresolvedAt')::timestamptz, (v ->> 'startConfidence')::public.evidence_confidence,
        (v ->> 'openedByEvent')::uuid)
      on conflict (id) do update set
        start_at = excluded.start_at, end_at = excluded.end_at, start_source = excluded.start_source,
        end_source = excluded.end_source, status = excluded.status, end_earliest_at = excluded.end_earliest_at,
        end_latest_at = excluded.end_latest_at, last_seen_at = excluded.last_seen_at,
        last_confirmed_inside_at = excluded.last_confirmed_inside_at, closeout_at = excluded.closeout_at,
        authorize_at = excluded.authorize_at, authorized_closeout_at = excluded.authorized_closeout_at,
        window_start_at = excluded.window_start_at, window_end_at = excluded.window_end_at,
        unscheduled = excluded.unscheduled, unscheduled_until = excluded.unscheduled_until,
        overtime_approved_at = excluded.overtime_approved_at, overtime_approved_by = excluded.overtime_approved_by,
        witnessed = excluded.witnessed, evidence_gaps = excluded.evidence_gaps,
        review_reasons = excluded.review_reasons, unresolved_at = excluded.unresolved_at,
        start_confidence = excluded.start_confidence;
    end loop;

    insert into app_private.location_event_receipts (
      event_uuid, device_id, worker_id, project_id, config_version_id, event_type, observed_at,
      server_received_at, accuracy_m, qualification_state, terminal_result, rejection_reason)
    select (r ->> 'event_uuid')::uuid, (r ->> 'device_id')::uuid, v_worker, v_project,
           (r ->> 'config_version_id')::uuid, r ->> 'event_type', (r ->> 'observed_at')::timestamptz,
           (r ->> 'server_received_at')::timestamptz, (r ->> 'accuracy_m')::numeric,
           (r ->> 'qualification_state')::public.qualification_state,
           (r ->> 'terminal_result')::public.terminal_result, r ->> 'rejection_reason'
      from jsonb_array_elements(v_receipts) r;

    insert into public.attendance_events (
      event_uuid, worker_id, project_id, session_id, actor_id, kiosk_device_id, device_id,
      config_version_id, source, direction, observed_at, received_at, verification_status, confidence, reason)
    select (e ->> 'event_uuid')::uuid, v_worker, v_project, (e ->> 'session_id')::uuid,
           (e ->> 'actor_id')::uuid, (e ->> 'kiosk_device_id')::uuid, (e ->> 'device_id')::uuid,
           (e ->> 'config_version_id')::uuid, (e ->> 'source')::public.attendance_source,
           (e ->> 'direction')::public.attendance_direction, (e ->> 'observed_at')::timestamptz,
           (e ->> 'received_at')::timestamptz, (e ->> 'verification_status')::public.attendance_verification,
           (e ->> 'confidence')::public.evidence_confidence, e ->> 'reason'
      from jsonb_array_elements(v_events) e;

    for c in select value from jsonb_array_elements(v_corrections) loop
      insert into public.attendance_corrections (
        session_id, project_id, worker_id, channel, requested_by, approved_by, reason,
        original_json, proposed_json, status, action_at, event_uuid)
      values ((c ->> 'session_id')::uuid, v_project, v_worker, 'STAFF_MANUAL',
              (c ->> 'requested_by')::uuid, (c ->> 'approved_by')::uuid, c ->> 'reason',
              coalesce(c -> 'original_json', '{}'::jsonb), c -> 'proposed_json', 'APPROVED',
              (c ->> 'action_at')::timestamptz, (c ->> 'event_uuid')::uuid);
    end loop;

    if v_position ->> 'op' = 'set' then
      insert into public.latest_onsite_positions (project_id, worker_id, position, horizontal_accuracy_m, observed_at, received_at, expiry_at)
      values (v_project, v_worker,
              extensions.st_setsrid(extensions.st_makepoint((v_position ->> 'lng')::float8, (v_position ->> 'lat')::float8), 4326)::extensions.geography,
              (v_position ->> 'accuracyM')::numeric, (v_position ->> 'observedAt')::timestamptz, now(),
              (v_position ->> 'expiryAt')::timestamptz)
      on conflict (project_id, worker_id) do update set
        position = excluded.position, horizontal_accuracy_m = excluded.horizontal_accuracy_m,
        observed_at = excluded.observed_at, received_at = excluded.received_at, expiry_at = excluded.expiry_at;
    elsif v_position ->> 'op' = 'clear' then
      delete from public.latest_onsite_positions where project_id = v_project and worker_id = v_worker;
    end if;

    insert into public.presence_states (
      project_id, worker_id, presence_state, first_inside_at, last_seen_at, last_confirmed_inside_at,
      arrival_confirmed_at, confidence, changed_at, config_version_id, revision, monitoring_status, flags,
      candidate_started_at, candidate_first_event, candidate_last_evidence_at, candidate_config_version_id,
      candidate_closeout_at, evaluated_at, presence_closeout_at, require_enter_after, continuity_break_at,
      current_session_id, previous_session_id)
    values (
      v_project, v_worker, (v_state ->> 'presence')::public.presence_state,
      (v_state #>> '{candidate,firstInsideAt}')::timestamptz, (v_state ->> 'lastSeenAt')::timestamptz,
      (v_state ->> 'lastConfirmedInsideAt')::timestamptz, (v_state ->> 'arrivalConfirmedAt')::timestamptz,
      (v_state ->> 'confidence')::public.evidence_confidence,
      coalesce((v_state ->> 'presenceChangedAt')::timestamptz, now()), (v_state ->> 'configVersionId')::uuid,
      v_expected + 1, v_state ->> 'monitoring',
      array(select jsonb_array_elements_text(coalesce(v_state -> 'flags', '[]'::jsonb))),
      (v_state #>> '{candidate,startedAt}')::timestamptz, (v_state #>> '{candidate,firstInsideEvent}')::uuid,
      (v_state #>> '{candidate,lastEvidenceAt}')::timestamptz, (v_state #>> '{candidate,configVersionId}')::uuid,
      (v_state #>> '{candidate,closeoutAt}')::timestamptz, (v_state ->> 'evaluatedAt')::timestamptz,
      (v_state ->> 'presenceCloseoutAt')::timestamptz, (v_state ->> 'requireEnterAfter')::timestamptz,
      (v_state ->> 'continuityBreakAt')::timestamptz, (v_state #>> '{current,id}')::uuid,
      (v_state #>> '{previous,id}')::uuid)
    on conflict (project_id, worker_id) do update set
      presence_state = excluded.presence_state, first_inside_at = excluded.first_inside_at,
      last_seen_at = excluded.last_seen_at, last_confirmed_inside_at = excluded.last_confirmed_inside_at,
      arrival_confirmed_at = excluded.arrival_confirmed_at, confidence = excluded.confidence,
      changed_at = excluded.changed_at, config_version_id = excluded.config_version_id,
      revision = excluded.revision, monitoring_status = excluded.monitoring_status, flags = excluded.flags,
      candidate_started_at = excluded.candidate_started_at, candidate_first_event = excluded.candidate_first_event,
      candidate_last_evidence_at = excluded.candidate_last_evidence_at,
      candidate_config_version_id = excluded.candidate_config_version_id,
      candidate_closeout_at = excluded.candidate_closeout_at, evaluated_at = excluded.evaluated_at,
      presence_closeout_at = excluded.presence_closeout_at, require_enter_after = excluded.require_enter_after,
      continuity_break_at = excluded.continuity_break_at, current_session_id = excluded.current_session_id,
      previous_session_id = excluded.previous_session_id;
  exception
    when unique_violation then
      return 'conflict';
    when exclusion_violation then
      raise exception 'OVERLAPPING_SESSION' using errcode = '23P01';
  end;
  return 'ok';
end;
$$;

-- Terminal receipts decided before the engine (normalizer rejections, proof-of-life records).
create function public.edge_insert_location_receipts(p_receipts jsonb)
returns integer
language sql
security definer
set search_path = ''
set timezone = 'UTC'
as $$
  with inserted as (
    insert into app_private.location_event_receipts (
      event_uuid, device_id, worker_id, project_id, config_version_id, event_type, observed_at,
      server_received_at, accuracy_m, qualification_state, terminal_result, rejection_reason)
    select (r ->> 'event_uuid')::uuid, (r ->> 'device_id')::uuid, (r ->> 'worker_id')::uuid,
           (r ->> 'project_id')::uuid, (r ->> 'config_version_id')::uuid, r ->> 'event_type',
           (r ->> 'observed_at')::timestamptz, (r ->> 'server_received_at')::timestamptz,
           (r ->> 'accuracy_m')::numeric, (r ->> 'qualification_state')::public.qualification_state,
           (r ->> 'terminal_result')::public.terminal_result, r ->> 'rejection_reason'
      from jsonb_array_elements(p_receipts) r
     where not app_private.jsonb_has_coordinate_keys(r)
    on conflict (event_uuid) do nothing
    returning 1)
  select count(*)::integer from inserted
$$;

-- ---------------------------------------------------------------------------------------------
-- Sweep: time rules only, mirroring the engine's advanceTo (decision #80)
-- ---------------------------------------------------------------------------------------------
create function app_private.attendance_sweep(p_now timestamptz)
returns integer
language plpgsql
security definer
set search_path = ''
set timezone = 'UTC'
as $$
declare
  r public.presence_states;
  s public.attendance_sessions;
  v_unknown interval;
  v_stale timestamptz;
  v_close timestamptz;
  v_auth timestamptz;
  v_lapse timestamptz;
  v_presence public.presence_state;
  v_at timestamptz;
  v_session_changed boolean;
  v_changed boolean;
  v_count integer := 0;
begin
  for r in
    select p.* from public.presence_states p
     where (p.current_session_id is null and (p.candidate_started_at is not null
            or (p.presence_state = 'PRESENCE_UNKNOWN' and p.presence_closeout_at is not null)))
        or exists (select 1 from public.attendance_sessions x
                    where x.id = p.current_session_id and x.status in ('OPEN', 'PENDING_APPROVAL'))
     for update of p skip locked
  loop
    v_changed := false;
    -- Arrival candidate without inside evidence for presence_unknown_seconds: lapses (never counted).
    if r.current_session_id is null and r.candidate_started_at is not null then
      v_lapse := r.candidate_last_evidence_at
                 + make_interval(secs => app_private.config_seconds(r.candidate_config_version_id, 'presence_unknown_seconds', 1200));
      if p_now >= v_lapse then
        r.presence_closeout_at := greatest(r.candidate_closeout_at, v_lapse);
        r.candidate_started_at := null;
        r.first_inside_at := null;
        r.candidate_first_event := null;
        r.candidate_last_evidence_at := null;
        r.candidate_config_version_id := null;
        r.candidate_closeout_at := null;
        if r.presence_state <> 'PRESENCE_UNKNOWN' then
          r.presence_state := 'PRESENCE_UNKNOWN';
          r.changed_at := v_lapse;
        end if;
        v_changed := true;
      end if;
    end if;
    -- A person who was never counted is no longer "unknown" after that shift's close-out.
    if r.current_session_id is null and r.presence_state = 'PRESENCE_UNKNOWN'
       and r.presence_closeout_at is not null and p_now >= r.presence_closeout_at then
      r.presence_state := 'OFFSITE';
      r.changed_at := r.presence_closeout_at;
      r.presence_closeout_at := null;
      v_changed := true;
    end if;
    if r.current_session_id is not null then
      select * into s from public.attendance_sessions where id = r.current_session_id for update;
      if s.status in ('OPEN', 'PENDING_APPROVAL') then
        v_session_changed := false;
        v_unknown := make_interval(secs => app_private.config_seconds(s.config_version_id, 'presence_unknown_seconds', 1200));
        for i in 1..3 loop
          v_stale := s.last_seen_at + v_unknown;
          v_close := greatest(s.closeout_at, v_stale);
          v_auth := case when s.status = 'PENDING_APPROVAL' then s.authorize_at end;
          if v_auth is not null and v_auth <= p_now and v_auth < v_stale and v_auth <= v_close then
            s.status := 'OPEN';
            s.unscheduled_until := s.authorize_at;
            s.closeout_at := coalesce(s.authorized_closeout_at, s.closeout_at);
            s.authorize_at := null;
            v_session_changed := true;
            continue;
          end if;
          if v_close <= p_now then
            s.status := 'UNRESOLVED';
            s.unresolved_at := v_close;
            s.end_earliest_at := greatest(coalesce(s.last_confirmed_inside_at, s.start_at), s.start_at);
            if not ('CLOSEOUT_STALE' = any(s.review_reasons)) then
              s.review_reasons := s.review_reasons || 'CLOSEOUT_STALE'::text;
            end if;
            v_session_changed := true;
          end if;
          exit;
        end loop;
        if v_session_changed then
          update public.attendance_sessions set status = s.status, unscheduled_until = s.unscheduled_until,
                 closeout_at = s.closeout_at, authorize_at = s.authorize_at, unresolved_at = s.unresolved_at,
                 end_earliest_at = s.end_earliest_at, review_reasons = s.review_reasons
           where id = s.id;
          v_changed := true;
        end if;
        if s.status = 'UNRESOLVED' then
          v_presence := 'UNRESOLVED';
          v_at := s.unresolved_at;
          delete from public.latest_onsite_positions where project_id = r.project_id and worker_id = r.worker_id;
        elsif not s.witnessed and (p_now >= s.last_seen_at + v_unknown
              or (r.continuity_break_at is not null and r.continuity_break_at > s.last_seen_at)) then
          v_presence := 'PRESENCE_UNKNOWN';
          v_at := case when r.continuity_break_at is not null and r.continuity_break_at > s.last_seen_at
                       then r.continuity_break_at else s.last_seen_at + v_unknown end;
        else
          v_presence := case when s.status = 'PENDING_APPROVAL' then 'UNSCHEDULED_PENDING' else 'ONSITE_ESTIMATED' end;
          v_at := p_now;
        end if;
        if v_presence <> r.presence_state then
          r.presence_state := v_presence;
          r.changed_at := v_at;
          v_changed := true;
        end if;
      end if;
    end if;
    if v_changed then
      update public.presence_states set
        presence_state = r.presence_state, changed_at = r.changed_at,
        presence_closeout_at = r.presence_closeout_at, first_inside_at = r.first_inside_at,
        candidate_started_at = r.candidate_started_at, candidate_first_event = r.candidate_first_event,
        candidate_last_evidence_at = r.candidate_last_evidence_at,
        candidate_config_version_id = r.candidate_config_version_id,
        candidate_closeout_at = r.candidate_closeout_at,
        evaluated_at = greatest(coalesce(evaluated_at, p_now), p_now), revision = revision + 1
       where project_id = r.project_id and worker_id = r.worker_id;
      v_count := v_count + 1;
    end if;
  end loop;
  delete from public.latest_onsite_positions where expiry_at <= p_now;
  update public.visitor_visits set status = 'UNRESOLVED'
   where status = 'OPEN' and closeout_at is not null and closeout_at <= p_now;
  return v_count;
end;
$$;

create function public.edge_attendance_sweep(p_now timestamptz)
returns integer
language sql
security definer
set search_path = ''
as $$ select app_private.attendance_sweep(p_now) $$;

-- Scheduled every minute. Local and CI databases are marked "development" by seed.sql: there the
-- tests drive the sweep explicitly so background runs never race with test fixtures.
create function app_private.scheduled_attendance_sweep()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if app_private.deployment_environment() = 'development' then
    return;
  end if;
  perform app_private.attendance_sweep(now());
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Visitors (separate from the workforce; service role only)
-- ---------------------------------------------------------------------------------------------
create function public.edge_visitor_load(p_project uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
set timezone = 'UTC'
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', v.id, 'projectId', v.project_id, 'visitorKey', v.visitor_id, 'status', v.status,
           'checkedInAt', v.checked_in_at, 'checkedOutAt', v.checked_out_at,
           'closeoutAt', coalesce(v.closeout_at, v.checked_in_at + interval '16 hours'),
           'idempotencyKey', v.idempotency_key) order by v.checked_in_at), '[]'::jsonb)
    from public.visitor_visits v where v.project_id = p_project
$$;

create function public.edge_visitor_commit(p_visit jsonb, p_actor uuid, p_kiosk uuid)
returns text
language plpgsql
security definer
set search_path = ''
set timezone = 'UTC'
as $$
declare
  v_visitor uuid := (p_visit ->> 'visitorKey')::uuid;
  v_project uuid := (p_visit ->> 'projectId')::uuid;
begin
  if not exists (select 1 from public.visitor_records r where r.id = v_visitor and r.project_id = v_project) then
    raise exception 'VISITOR_NOT_FOUND' using errcode = '22023';
  end if;
  insert into public.visitor_visits (id, visitor_id, project_id, kiosk_actor_id, kiosk_device_id, checked_in_at,
                                     checked_out_at, status, idempotency_key, closeout_at)
  values ((p_visit ->> 'id')::uuid, v_visitor, v_project, p_actor, p_kiosk, (p_visit ->> 'checkedInAt')::timestamptz,
          (p_visit ->> 'checkedOutAt')::timestamptz, (p_visit ->> 'status')::public.visitor_visit_status,
          (p_visit ->> 'idempotencyKey')::uuid, (p_visit ->> 'closeoutAt')::timestamptz)
  on conflict (id) do update set checked_out_at = excluded.checked_out_at, status = excluded.status
   where public.visitor_visits.project_id = excluded.project_id;
  return 'ok';
exception
  when unique_violation then
    return 'conflict';
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Basic counts for project staff (docs/spec/04 "Aggregations"; estimates, never a guarantee)
-- ---------------------------------------------------------------------------------------------
create function public.attendance_counts(p_project_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set timezone = 'UTC'
as $$
declare
  v_out jsonb;
begin
  if auth.uid() is null or not app_private.can_view_roster(p_project_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  with tracks as (
    select p.worker_id, p.presence_state, s.status, s.start_source, s.witnessed,
           -- Live staleness: a counted worker whose evidence is older than presence_unknown_seconds
           -- is shown as unknown even before the next sweep runs.
           (s.status = 'OPEN' and p.presence_state = 'ONSITE_ESTIMATED'
             and (s.witnessed or now() < s.last_seen_at
                  + make_interval(secs => app_private.config_seconds(s.config_version_id, 'presence_unknown_seconds', 1200)))) as counted,
           (s.status in ('OPEN', 'PENDING_APPROVAL') and not s.witnessed and now() >= s.last_seen_at
                  + make_interval(secs => app_private.config_seconds(s.config_version_id, 'presence_unknown_seconds', 1200))) as went_stale
      from public.presence_states p
      left join public.attendance_sessions s on s.id = p.current_session_id
     where p.project_id = p_project_id
  )
  select jsonb_build_object(
    'approved_roster', (select count(*) from public.worker_enrollments e
                         where e.project_id = p_project_id and e.enrollment_status = 'APPROVED'),
    'estimated_onsite', (select count(distinct worker_id) from tracks where counted),
    'onsite_by_source', (select coalesce(jsonb_object_agg(start_source, n), '{}'::jsonb)
                           from (select start_source, count(*) as n from tracks where counted group by start_source) x),
    'manually_verified', (select count(*) from tracks where counted and witnessed),
    'presence_unknown', (select count(*) from tracks where presence_state = 'PRESENCE_UNKNOWN' or went_stale),
    'arriving', (select count(*) from tracks where presence_state = 'ARRIVING'),
    'unscheduled_pending', (select count(*) from tracks where presence_state = 'UNSCHEDULED_PENDING' and not went_stale),
    'departure_pending', (select count(*) from tracks where presence_state = 'DEPARTURE_PENDING'),
    'unresolved_sessions', (select count(*) from public.attendance_sessions s
                             where s.project_id = p_project_id and s.status in ('UNRESOLVED', 'ENDED_UNVERIFIED')),
    'visitors_onsite', (select count(*) from public.visitor_visits v where v.project_id = p_project_id and v.status = 'OPEN'),
    'visitors_unresolved', (select count(*) from public.visitor_visits v where v.project_id = p_project_id and v.status = 'UNRESOLVED'),
    'evaluated_at', now())
  into v_out;
  return v_out;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Grants (deny by default; decision #57)
-- ---------------------------------------------------------------------------------------------
revoke all on function
  app_private.attendance_session_guard(), app_private.config_seconds(uuid, text, numeric),
  app_private.attendance_session_json(public.attendance_sessions), app_private.attendance_sweep(timestamptz),
  app_private.scheduled_attendance_sweep()
  from public, anon, authenticated, service_role;

revoke all on function
  public.edge_attendance_load(uuid, uuid, uuid[], uuid[]), public.edge_attendance_commit(jsonb),
  public.edge_insert_location_receipts(jsonb), public.edge_attendance_sweep(timestamptz),
  public.edge_visitor_load(uuid), public.edge_visitor_commit(jsonb, uuid, uuid),
  public.attendance_counts(uuid)
  from public, anon, authenticated, service_role;

grant execute on function
  public.edge_attendance_load(uuid, uuid, uuid[], uuid[]), public.edge_attendance_commit(jsonb),
  public.edge_insert_location_receipts(jsonb), public.edge_attendance_sweep(timestamptz),
  public.edge_visitor_load(uuid), public.edge_visitor_commit(jsonb, uuid, uuid)
  to service_role;

grant execute on function public.attendance_counts(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Schedule (pg_cron): every minute; no-op on development databases (see above).
-- ---------------------------------------------------------------------------------------------
create extension if not exists pg_cron;
select cron.schedule('sitemuster-attendance-sweep', '* * * * *', 'select app_private.scheduled_attendance_sweep()');
