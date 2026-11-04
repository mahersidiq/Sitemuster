-- =============================================================================================
-- Milestone 08 — kiosk, foreman, manual and visitor operations
-- (docs/spec/11 "Operational offline outbox contract" and "Offline worker badge";
--  docs/spec/04 "Kiosk / foreman / manual state transitions"; docs/spec/02 role matrix).
--
-- The `ingest-operations` Edge Function (verify_jwt = true) asks `operation_context` WITH THE
-- CALLER'S OWN JWT what this person may do on a project, then uses the service-role `edge_*`
-- functions below plus the Milestone 06 reconciler. Identity, role, project and company always
-- come from the database, never from the request body.
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- Receipts keep what the client needs to show again after a lost response (decision #98)
-- ---------------------------------------------------------------------------------------------
alter table app_private.operational_outbox_receipts
  add column worker_id uuid references public.worker_profiles (id) on delete set null,
  add column children jsonb not null default '[]'::jsonb
    check (jsonb_typeof(children) = 'array' and jsonb_array_length(children) <= 100),
  add column review boolean not null default false,
  add column observed_at timestamptz;

-- ---------------------------------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------------------------------

-- Manual attendance corrections: assigned PM/SUPER or the organization owner, with MFA. SAFETY
-- corrects only "if delegated"; V1 has no delegation, so it does not (role matrix, decision #99).
create function app_private.can_correct_attendance(p_project uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app_private.is_aal2() and (
    app_private.is_org_owner(app_private.project_organization(p_project))
    or app_private.has_project_role(p_project, array['PM', 'SUPER']::public.project_staff_role[])
  )
$$;

-- Visitor desk: assigned kiosk attendants with MFA. A foreman with a kiosk grant scans only their
-- own crew and never handles visitors (decision #99).
create function app_private.can_run_visitor_desk(p_project uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app_private.is_aal2() and app_private.has_project_role(p_project, array['ATTENDANT']::public.project_staff_role[])
$$;

-- What the signed-in caller may do on a project. Called by ingest-operations with the caller's
-- JWT; an unknown or foreign project answers with every permission off (no existence leak).
create function public.operation_context(p_project_id uuid)
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
begin
  if v_uid is null then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  select * into v_project from public.projects where id = p_project_id;
  if v_project.id is null then
    return jsonb_build_object('user_id', v_uid, 'project_id', null, 'project_status', null, 'kiosk', null,
                              'visitors', false, 'correct', false, 'foreman_company_ids', '[]'::jsonb);
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
    'foreman_company_ids', coalesce((select jsonb_agg(c) from app_private.foreman_company_ids(p_project_id) c), '[]'::jsonb));
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Kiosk devices (shared attended devices, separate from personal tracking phones)
-- ---------------------------------------------------------------------------------------------

-- The app derives one public id per (installation, project), so a phone can be the kiosk of
-- several projects without its id linking them. Re-registering hands the kiosk to the attendant
-- now signed in (shift change); a revoked kiosk stays revoked.
create function public.register_kiosk(p_project_id uuid, p_device_public_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_kiosk public.kiosk_devices;
begin
  if v_uid is null or not app_private.can_operate_kiosk(p_project_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if (select status from public.projects where id = p_project_id) <> 'ACTIVE' then
    raise exception 'PROJECT_NOT_ACTIVE' using errcode = '22023';
  end if;
  if p_device_public_id is null or p_device_public_id !~ '^[A-Za-z0-9_-]{16,128}$' then
    raise exception 'INVALID_DEVICE_ID' using errcode = '22023';
  end if;
  if not app_private.consume_rate_limit('kiosk_register', v_uid::text, 30, 3600) then
    raise exception 'RATE_LIMITED' using errcode = '22023';
  end if;
  select * into v_kiosk from public.kiosk_devices where device_public_id = p_device_public_id for update;
  if v_kiosk.id is null then
    insert into public.kiosk_devices (project_id, assigned_operator_user_id, device_public_id, last_seen_at)
    values (p_project_id, v_uid, p_device_public_id, now())
    returning * into v_kiosk;
    perform app_private.write_audit('USER', v_uid, 'kiosk.registered', app_private.project_organization(p_project_id),
                                    p_project_id, 'kiosk_device', v_kiosk.id, null, '{}'::jsonb);
  elsif v_kiosk.project_id <> p_project_id then
    raise exception 'KIOSK_OTHER_PROJECT' using errcode = '22023';
  elsif v_kiosk.status = 'REVOKED' then
    raise exception 'KIOSK_REVOKED' using errcode = '22023';
  else
    if v_kiosk.assigned_operator_user_id is distinct from v_uid then
      perform app_private.write_audit('USER', v_uid, 'kiosk.operator_changed', app_private.project_organization(p_project_id),
                                      p_project_id, 'kiosk_device', v_kiosk.id, null, '{}'::jsonb);
    end if;
    update public.kiosk_devices set assigned_operator_user_id = v_uid, last_seen_at = now()
     where id = v_kiosk.id returning * into v_kiosk;
  end if;
  return jsonb_build_object('kiosk_device_id', v_kiosk.id, 'project_id', v_kiosk.project_id, 'status', v_kiosk.status);
end;
$$;

-- A lost or retired kiosk: the project's configurers or the attendant it is assigned to.
create function public.revoke_kiosk(p_kiosk_device_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_kiosk public.kiosk_devices;
begin
  select * into v_kiosk from public.kiosk_devices where id = p_kiosk_device_id for update;
  if v_uid is null or v_kiosk.id is null
     or not (app_private.can_configure_project(v_kiosk.project_id)
             or (v_kiosk.assigned_operator_user_id = v_uid and app_private.can_operate_kiosk(v_kiosk.project_id))) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 3 and 500 then
    raise exception 'REASON_REQUIRED' using errcode = '22023';
  end if;
  if v_kiosk.status = 'REVOKED' then
    return;
  end if;
  update public.kiosk_devices set status = 'REVOKED', revoked_at = now() where id = v_kiosk.id;
  perform app_private.write_audit('USER', v_uid, 'kiosk.revoked', app_private.project_organization(v_kiosk.project_id),
                                  v_kiosk.project_id, 'kiosk_device', v_kiosk.id, null,
                                  jsonb_build_object('reason', left(btrim(p_reason), 500)));
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Service-role functions for ingest-operations
-- ---------------------------------------------------------------------------------------------

create function public.edge_kiosk_device(p_kiosk_device_id uuid)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  update public.kiosk_devices set last_seen_at = now()
   where id = p_kiosk_device_id and status = 'ACTIVE'
  returning jsonb_build_object('id', id, 'project_id', project_id, 'status', status)
$$;

create function public.edge_operation_receipts(p_event_uuids uuid[])
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'event_uuid', r.event_uuid, 'actor_id', r.actor_id, 'project_id', r.project_id,
           'operation_type', r.operation_type, 'status', r.terminal_status, 'reason', r.rejection_reason,
           'worker_id', r.worker_id, 'children', r.children, 'review', r.review)), '[]'::jsonb)
    from app_private.operational_outbox_receipts r
   where r.event_uuid = any (coalesce(p_event_uuids, '{}'))
$$;

-- Terminal results, written once per operation (a lost response is answered from here).
create function public.edge_record_operation_receipts(p_request_id uuid, p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  insert into app_private.operational_outbox_receipts (
    event_uuid, kiosk_device_id, actor_id, project_id, operation_type, payload_schema, terminal_status,
    rejection_reason, request_id, worker_id, children, review, observed_at)
  select (r ->> 'event_uuid')::uuid, (r ->> 'kiosk_device_id')::uuid, (r ->> 'actor_id')::uuid,
         (r ->> 'project_id')::uuid, r ->> 'operation_type', 'operations.v1',
         (r ->> 'status')::public.terminal_result, left(r ->> 'reason', 200), p_request_id,
         (r ->> 'worker_id')::uuid, coalesce(r -> 'children', '[]'::jsonb), coalesce((r ->> 'review')::boolean, false),
         (r ->> 'observed_at')::timestamptz
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
  on conflict (event_uuid) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Printed badge: only the SHA-256 of the opaque code is stored and compared (docs/spec/05 worker_badges).
create function public.edge_printed_badge_worker(p_code_sha256 bytea)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('worker_id', b.worker_id, 'active', b.active)
    from public.worker_badges b
   where b.badge_kind = 'PRINTED' and b.opaque_badge_hash = p_code_sha256
   order by b.active desc, b.issued_at desc
   limit 1
$$;

-- Enrollment facts for named workers on one project. `eligible` is the attendance rule of
-- decision #56 (approved enrollment, verified employer when a company is claimed, an active
-- acknowledgement of the project notice), the same rule edge_attendance_load applies; a kiosk
-- checks it before a badge step is consumed (pgTAP asserts both agree).
create function public.edge_operation_workers(p_project_id uuid, p_worker_ids uuid[])
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'worker_id', w.id, 'enrolled', e.id is not null,
           'approved', coalesce(e.enrollment_status = 'APPROVED', false),
           'eligible', coalesce(e.enrollment_status = 'APPROVED', false)
                       and (e.subcontractor_id is null or e.employer_status = 'VERIFIED')
                       and exists (select 1 from public.tracking_consents c
                                    where c.worker_id = w.id and c.project_id = p_project_id and c.withdrawn_at is null),
           'company_id', e.subcontractor_id)), '[]'::jsonb)
    from unnest(coalesce(p_worker_ids, '{}')) as w(id)
    left join lateral (
      select x.id, x.enrollment_status, x.employer_status, x.subcontractor_id from public.worker_enrollments x
       where x.project_id = p_project_id and x.worker_id = w.id
       order by (x.enrollment_status = 'APPROVED') desc, x.created_at desc limit 1) e on true
$$;

-- A visitor is created on first sign-in with the id the kiosk chose offline (so it can sign the
-- visitor out offline too). An id already used on another project is refused, never reused.
create function public.edge_visitor_register(
  p_project_id uuid, p_visitor_id uuid, p_name text, p_organization text, p_host_user_id uuid,
  p_purpose text, p_actor uuid
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_visitor public.visitor_records;
begin
  select * into v_visitor from public.visitor_records where id = p_visitor_id;
  if v_visitor.id is not null then
    return case when v_visitor.project_id = p_project_id then 'ok' else 'VISITOR_ID_CONFLICT' end;
  end if;
  if p_name is null or length(btrim(p_name)) not between 1 and 200
     or p_purpose is null or length(btrim(p_purpose)) not between 1 and 500
     or (p_organization is not null and length(p_organization) > 200) then
    return 'VISITOR_DETAILS_REQUIRED';
  end if;
  if p_host_user_id is null or not exists (
       select 1 from public.project_staff s
        where s.project_id = p_project_id and s.user_id = p_host_user_id and s.status = 'ACTIVE') then
    return 'HOST_NOT_FOUND';
  end if;
  insert into public.visitor_records (id, project_id, name, organization, host_user_id, purpose, created_by)
  values (p_visitor_id, p_project_id, btrim(p_name), nullif(btrim(p_organization), ''), p_host_user_id,
          btrim(p_purpose), p_actor)
  on conflict (id) do nothing;
  return 'ok';
end;
$$;

-- Project status, time zone and configuration versions for visitor visits (same JSON shape as the
-- `project` and `configs` keys of edge_attendance_load, so one codec reads both).
create function public.edge_visitor_context(p_project uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
set timezone = 'UTC'
as $$
  select jsonb_build_object(
    'project', jsonb_build_object('id', p.id, 'status', p.status, 'timezone', p.iana_timezone),
    'configs', coalesce((
      select jsonb_agg(jsonb_build_object(
               'configVersionId', v.id, 'projectId', v.project_id, 'versionNumber', v.version_number,
               'effectiveAt', v.effective_at, 'settings', v.settings_json,
               'center', jsonb_build_object('lat', extensions.st_y(g.center::extensions.geometry),
                                            'lng', extensions.st_x(g.center::extensions.geometry)),
               'radiusM', g.radius_m, 'exitHysteresisM', g.exit_hysteresis_m) order by v.version_number)
        from public.project_tracking_config_versions v
        join public.project_geofences g on g.config_version_id = v.id
       where v.project_id = p.id), '[]'::jsonb))
    from public.projects p where p.id = p_project
$$;

-- A visitor exit stores its operation id in the same row update that closes the visit (review
-- finding on PR #8). A resend after a lost answer, or after the receipt could not be written,
-- then finds the closed visit and answers `duplicate` instead of VISIT_NOT_FOUND.
alter table public.visitor_visits
  add column exit_idempotency_key uuid,
  add constraint visitor_visits_exit_idempotency_uq unique (exit_idempotency_key),
  add constraint visitor_visits_exit_key_ck check (exit_idempotency_key is null or checked_out_at is not null);

create or replace function public.edge_visitor_load(p_project uuid)
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
           'idempotencyKey', v.idempotency_key,
           'exitIdempotencyKey', v.exit_idempotency_key) order by v.checked_in_at), '[]'::jsonb)
    from public.visitor_visits v where v.project_id = p_project
$$;

-- Compare-and-swap: a visit is closed only while it is still OPEN or UNRESOLVED. 'stale' means
-- another operation closed it first (the caller reloads and decides again); 'conflict' means the
-- operation id is already stored (it was applied before).
create or replace function public.edge_visitor_commit(p_visit jsonb, p_actor uuid, p_kiosk uuid)
returns text
language plpgsql
security definer
set search_path = ''
set timezone = 'UTC'
as $$
declare
  v_visitor uuid := (p_visit ->> 'visitorKey')::uuid;
  v_project uuid := (p_visit ->> 'projectId')::uuid;
  v_rows integer;
begin
  if not exists (select 1 from public.visitor_records r where r.id = v_visitor and r.project_id = v_project) then
    raise exception 'VISITOR_NOT_FOUND' using errcode = '22023';
  end if;
  insert into public.visitor_visits (id, visitor_id, project_id, kiosk_actor_id, kiosk_device_id, checked_in_at,
                                     checked_out_at, status, idempotency_key, closeout_at, exit_idempotency_key)
  values ((p_visit ->> 'id')::uuid, v_visitor, v_project, p_actor, p_kiosk, (p_visit ->> 'checkedInAt')::timestamptz,
          (p_visit ->> 'checkedOutAt')::timestamptz, (p_visit ->> 'status')::public.visitor_visit_status,
          (p_visit ->> 'idempotencyKey')::uuid, (p_visit ->> 'closeoutAt')::timestamptz,
          (p_visit ->> 'exitIdempotencyKey')::uuid)
  on conflict (id) do update
     set checked_out_at = excluded.checked_out_at, status = excluded.status,
         exit_idempotency_key = excluded.exit_idempotency_key
   where public.visitor_visits.project_id = excluded.project_id
     and public.visitor_visits.status in ('OPEN', 'UNRESOLVED');
  get diagnostics v_rows = row_count;
  return case when v_rows = 0 then 'stale' else 'ok' end;
exception
  when unique_violation then
    return 'conflict';
end;
$$;

create function public.edge_operation_rate_limit(p_actor uuid, p_events integer)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- A rush at the gate: 120 requests per minute and 3,000 operations per hour per signed-in person.
  if not app_private.consume_rate_limit('operations_minute', p_actor::text, 120, 60) then
    return false;
  end if;
  return app_private.consume_rate_limit_units('operations_hour', p_actor::text, greatest(p_events, 1), 3000, 3600);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Read functions for the kiosk, foreman and correction screens
-- ---------------------------------------------------------------------------------------------

-- Projects where the caller is a verified foreman of an approved company.
create function public.my_foreman_projects()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'project_id', p.id, 'project_name', p.name, 'project_status', p.status,
           'company_id', c.id, 'company_name', c.canonical_name,
           'kiosk_grant', exists (select 1 from public.foreman_project_grants g
                                   where g.project_id = p.id and g.subcontractor_id = c.id
                                     and g.foreman_profile_id = m.worker_profile_id
                                     and g.revoked_at is null and g.can_operate_kiosk))
           order by p.name, c.canonical_name), '[]'::jsonb)
    from public.subcontractor_members m
    join public.subcontractor_companies c on c.id = m.company_id
    join public.project_subcontractors ps on ps.subcontractor_id = c.id and ps.status = 'APPROVED'
    join public.projects p on p.id = ps.project_id and p.status = 'ACTIVE'
   where app_private.current_worker_id() is not null
     and m.worker_profile_id = app_private.current_worker_id()
     and m.role = 'FOREMAN' and m.verification_status = 'VERIFIED'
     and m.valid_from <= now() and (m.valid_until is null or m.valid_until > now())
$$;

-- The foreman's own approved crew on one project (names only: no contacts, no positions).
create function public.foreman_crew(p_project_id uuid, p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not app_private.is_foreman_of_company_on_project(p_company_id, p_project_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('worker_id', w.id, 'name', w.legal_name, 'trade', e.trade,
                                        'employer_status', e.employer_status) order by w.legal_name)
      from public.worker_enrollments e
      join public.worker_profiles w on w.id = e.worker_id
     where e.project_id = p_project_id and e.subcontractor_id = p_company_id
       and e.enrollment_status = 'APPROVED'), '[]'::jsonb);
end;
$$;

-- Open and unresolved visits for the visitor desk (visitor PII stays with roster-level staff).
create function public.open_visitor_visits(p_project_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (app_private.can_run_visitor_desk(p_project_id) or app_private.can_view_roster(p_project_id)) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('visit_id', v.id, 'visitor_id', r.id, 'name', r.name,
                                        'organization', r.organization, 'host_user_id', r.host_user_id,
                                        'purpose', r.purpose, 'checked_in_at', v.checked_in_at,
                                        'status', v.status) order by v.checked_in_at desc)
      from public.visitor_visits v
      join public.visitor_records r on r.id = v.visitor_id
     where v.project_id = p_project_id and v.status in ('OPEN', 'UNRESOLVED')
       and v.checked_in_at > now() - interval '7 days'), '[]'::jsonb);
end;
$$;

-- Recent sessions of one worker, for a manual correction (assigned PM/SUPER/owner with MFA).
create function public.worker_attendance_sessions(p_project_id uuid, p_worker_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not app_private.can_correct_attendance(p_project_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('session_id', s.id, 'start_at', s.start_at, 'end_at', s.end_at,
                                        'status', s.status, 'start_source', s.start_source,
                                        'end_source', s.end_source) order by s.start_at desc)
      from (select * from public.attendance_sessions x
             where x.project_id = p_project_id and x.worker_id = p_worker_id and x.status <> 'VOID'
               and x.start_at > now() - interval '14 days'
             order by x.start_at desc limit 50) s), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Project detail tells the app which fallback screens to offer (the server re-checks each one)
-- ---------------------------------------------------------------------------------------------
create or replace function public.get_project_detail(p_project_id uuid)
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
                                      'can_assign_staff', app_private.can_assign_staff(p.id),
                                      'can_run_orientation', app_private.can_run_orientation(p.id),
                                      'can_view_roster', app_private.can_view_roster(p.id),
                                      'can_operate_kiosk', app_private.can_operate_kiosk(p.id),
                                      'can_run_visitor_desk', app_private.can_run_visitor_desk(p.id),
                                      'can_correct_attendance', app_private.can_correct_attendance(p.id))
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
-- Grants (deny by default; decision #57)
-- ---------------------------------------------------------------------------------------------
revoke all on function
  app_private.can_correct_attendance(uuid), app_private.can_run_visitor_desk(uuid)
  from public, anon, authenticated, service_role;

revoke all on function
  public.operation_context(uuid), public.register_kiosk(uuid, text), public.revoke_kiosk(uuid, text),
  public.edge_kiosk_device(uuid), public.edge_operation_receipts(uuid[]),
  public.edge_record_operation_receipts(uuid, jsonb), public.edge_printed_badge_worker(bytea),
  public.edge_operation_workers(uuid, uuid[]),
  public.edge_visitor_register(uuid, uuid, text, text, uuid, text, uuid),
  public.edge_visitor_context(uuid), public.edge_operation_rate_limit(uuid, integer),
  public.my_foreman_projects(), public.foreman_crew(uuid, uuid), public.open_visitor_visits(uuid),
  public.worker_attendance_sessions(uuid, uuid)
  from public, anon, authenticated, service_role;

grant execute on function
  public.edge_kiosk_device(uuid), public.edge_operation_receipts(uuid[]),
  public.edge_record_operation_receipts(uuid, jsonb), public.edge_printed_badge_worker(bytea),
  public.edge_operation_workers(uuid, uuid[]),
  public.edge_visitor_register(uuid, uuid, text, text, uuid, text, uuid),
  public.edge_visitor_context(uuid), public.edge_operation_rate_limit(uuid, integer)
  to service_role;

grant execute on function
  public.operation_context(uuid), public.register_kiosk(uuid, text), public.revoke_kiosk(uuid, text),
  public.my_foreman_projects(), public.foreman_crew(uuid, uuid), public.open_visitor_visits(uuid),
  public.worker_attendance_sessions(uuid, uuid)
  to authenticated;
