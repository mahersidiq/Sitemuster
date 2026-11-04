-- Milestone 07: native tracking and custom device ingestion (docs/spec/03, docs/spec/11;
-- decisions #24, #27, #39, #44, #45 and #89–#95).
--
-- - Device ↔ project bindings are derived state, kept in sync by triggers: a worker's ONE active
--   phone is bound exactly to the projects where attendance may be recorded (approved enrollment,
--   verified employer when one is claimed, active consent, ACTIVE project).
-- - The ingest/renew Edge Functions authenticate the 32-byte device bearer secret themselves
--   (verify_jwt=false) through service-role-only functions that take the SHA-256 of the secret;
--   every privileged statement is scoped to the ids derived from it.
-- - Continuous coordinates are a release-gated feature: allowed in development and staging, and in
--   production only for a platform/app version with a recorded real-device privacy sign-off.

-- ---------------------------------------------------------------------------------------------
-- Location privacy sign-off (release gate for continuous coordinates; decision #90)
-- ---------------------------------------------------------------------------------------------
create table app_private.location_privacy_signoffs (
  id uuid primary key default gen_random_uuid(),
  platform public.device_platform not null,
  app_version text not null check (app_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  signed_by text not null check (length(btrim(signed_by)) between 3 and 128),
  evidence_reference text not null check (length(btrim(evidence_reference)) between 3 and 512),
  signed_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoke_reason text check (revoke_reason is null or length(btrim(revoke_reason)) between 3 and 512),
  constraint location_privacy_signoffs_revoked_ck check ((revoked_at is null) = (revoke_reason is null))
);
create unique index location_privacy_signoffs_active_uq
  on app_private.location_privacy_signoffs (platform, app_version) where revoked_at is null;
alter table app_private.location_privacy_signoffs enable row level security;
revoke all on app_private.location_privacy_signoffs from anon, authenticated, service_role;

-- Development and staging (synthetic data, test devices) always allow onsite coordinates so the
-- egress gate can be exercised; production requires the exact platform + app version signed off.
create function app_private.location_coordinates_allowed(p_platform public.device_platform, p_app_version text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app_private.deployment_environment() in ('development', 'staging')
      or exists (select 1 from app_private.location_privacy_signoffs s
                  where s.platform = p_platform and s.app_version = p_app_version and s.revoked_at is null)
$$;

-- Recorded only by the database owner after the real-device network capture (HUMAN_CHECKLIST §9);
-- no API role can execute these.
create function app_private.record_location_privacy_signoff(
  p_platform public.device_platform,
  p_app_version text,
  p_signed_by text,
  p_evidence_reference text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into app_private.location_privacy_signoffs (platform, app_version, signed_by, evidence_reference)
  values (p_platform, p_app_version, btrim(p_signed_by), btrim(p_evidence_reference))
  returning id into v_id;
  perform app_private.write_audit('SYSTEM', null, 'location_privacy.signed_off', null, null,
                                  'location_privacy_signoff', v_id, null,
                                  jsonb_build_object('platform', p_platform, 'app_version', p_app_version));
  return v_id;
end;
$$;

create function app_private.revoke_location_privacy_signoff(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update app_private.location_privacy_signoffs
     set revoked_at = now(), revoke_reason = btrim(p_reason)
   where id = p_id and revoked_at is null;
  if not found then
    raise exception 'SIGNOFF_NOT_FOUND' using errcode = '22023';
  end if;
  perform app_private.write_audit('SYSTEM', null, 'location_privacy.signoff_revoked', null, null,
                                  'location_privacy_signoff', p_id, null, jsonb_build_object('reason', btrim(p_reason)));
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Device ↔ project bindings (derived state; decision #89)
-- ---------------------------------------------------------------------------------------------
create function app_private.binding_eligible(p_enrollment uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.worker_enrollments e
      join public.projects p on p.id = e.project_id
     where e.id = p_enrollment
       and e.enrollment_status = 'APPROVED'
       and (e.subcontractor_id is null or e.employer_status = 'VERIFIED')
       and p.status = 'ACTIVE'
       and p.config_version_id is not null
       and exists (select 1 from public.tracking_consents c
                    where c.worker_id = e.worker_id and c.project_id = e.project_id and c.withdrawn_at is null))
$$;

create function app_private.sync_device_bindings(p_worker uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device uuid;
begin
  if p_worker is null then
    return;
  end if;
  select id into v_device from public.device_installations where worker_id = p_worker and active;
  -- Revoke every binding that no longer qualifies or belongs to an inactive phone.
  update public.device_project_bindings b
     set enabled = false, revoked_at = coalesce(b.revoked_at, now())
   where b.revoked_at is null
     and b.device_id in (select d.id from public.device_installations d where d.worker_id = p_worker)
     and (b.device_id is distinct from v_device or not app_private.binding_eligible(b.enrollment_id));
  if v_device is null then
    return;
  end if;
  insert into public.device_project_bindings (device_id, project_id, enrollment_id, config_version_id)
  select v_device, e.project_id, e.id, p.config_version_id
    from public.worker_enrollments e
    join public.projects p on p.id = e.project_id
   where e.worker_id = p_worker
     and app_private.binding_eligible(e.id)
     and not exists (select 1 from public.device_project_bindings b
                      where b.device_id = v_device and b.project_id = e.project_id and b.revoked_at is null);
  -- Keep the configuration pointer of active bindings current.
  update public.device_project_bindings b
     set config_version_id = p.config_version_id
    from public.projects p
   where p.id = b.project_id and b.device_id = v_device and b.revoked_at is null
     and b.config_version_id is distinct from p.config_version_id;
end;
$$;

create function app_private.sync_bindings_for_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app_private.sync_device_bindings(new.worker_id);
  return null;
end;
$$;

create function app_private.sync_bindings_for_project()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
begin
  for r in select distinct e.worker_id from public.worker_enrollments e where e.project_id = new.id loop
    perform app_private.sync_device_bindings(r.worker_id);
  end loop;
  return null;
end;
$$;

create trigger enrollment_binding_sync
  after insert or update of enrollment_status, employer_status on public.worker_enrollments
  for each row execute function app_private.sync_bindings_for_row();
create trigger consent_binding_sync
  after insert or update of withdrawn_at on public.tracking_consents
  for each row execute function app_private.sync_bindings_for_row();
create trigger device_binding_sync
  after insert or update of active on public.device_installations
  for each row execute function app_private.sync_bindings_for_row();
create trigger project_binding_sync
  after update of status, config_version_id on public.projects
  for each row
  when (old.status is distinct from new.status or old.config_version_id is distinct from new.config_version_id)
  execute function app_private.sync_bindings_for_project();

-- Bring bindings in line for data created before this migration.
select app_private.sync_device_bindings(w.id) from public.worker_profiles w;

-- Fences the device may report: the CURRENT version of every bound project, plus the version of a
-- still-open session (its EXIT stays resolvable); never an old boundary for a new arrival.
create function app_private.device_fences(p_device uuid, p_worker uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
set timezone = 'UTC'
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'projectId', g.project_id, 'configVersionId', g.config_version_id, 'identifier', g.sdk_identifier,
           'center', jsonb_build_object('lat', extensions.st_y(g.center::extensions.geometry),
                                        'lng', extensions.st_x(g.center::extensions.geometry)),
           'radiusM', g.radius_m::float8,
           'nativeRadiusM', (g.radius_m + g.exit_hysteresis_m)::float8,
           'current', g.config_version_id = p.config_version_id)
         order by g.project_id, g.config_version_id), '[]'::jsonb)
    from public.device_project_bindings b
    join public.projects p on p.id = b.project_id
    join public.project_geofences g on g.project_id = b.project_id
   where b.device_id = p_device and b.revoked_at is null and b.enabled
     and (g.config_version_id = p.config_version_id
          or exists (select 1 from public.attendance_sessions s
                      where s.project_id = b.project_id and s.worker_id = p_worker
                        and s.status in ('OPEN', 'PENDING_APPROVAL', 'UNRESOLVED')
                        and s.config_version_id = g.config_version_id))
$$;

-- ---------------------------------------------------------------------------------------------
-- Device credential: authentication, rate limits, renewal (service role only)
-- ---------------------------------------------------------------------------------------------
-- The credential an upload or renewal presents, by the SHA-256 of the raw secret. A rotated
-- credential stays valid only for its 24 h overlap (decision #44).
create function public.edge_device_authenticate(p_token_hash bytea)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set timezone = 'UTC'
as $$
declare
  c app_private.device_upload_credentials;
  d public.device_installations;
  v_credential uuid;
  v_valid_until timestamptz;
begin
  if p_token_hash is null or length(p_token_hash) <> 32 then
    return jsonb_build_object('status', 'INVALID');
  end if;
  -- Validity has one definition (Milestone 02 resolver); the rest only classifies a refusal.
  select r.credential_id into v_credential from app_private.resolve_upload_credential(p_token_hash) r;
  select * into c from app_private.device_upload_credentials where token_sha256 = p_token_hash;
  if c.id is null then
    return jsonb_build_object('status', 'INVALID');
  end if;
  select * into d from public.device_installations where id = c.device_id;
  if v_credential is null then
    if c.revoked_at is not null or d.id is null or not d.active
       or not exists (select 1 from public.worker_profiles w where w.id = d.worker_id and w.deleted_at is null) then
      return jsonb_build_object('status', 'REVOKED');
    end if;
    return jsonb_build_object('status', 'EXPIRED');
  end if;
  v_valid_until := case when c.overlap_until is null then c.expires_at else least(c.expires_at, c.overlap_until) end;
  return jsonb_build_object(
    'status', 'OK',
    'device_id', d.id,
    'worker_id', d.worker_id,
    'credential_id', c.id,
    'platform', d.platform,
    'valid_until', v_valid_until,
    'renewable', c.overlap_until is null,
    'coordinates_allowed', app_private.location_coordinates_allowed(d.platform, d.app_version),
    'fences', app_private.device_fences(d.id, d.worker_id));
end;
$$;

create function app_private.consume_rate_limit_units(
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
  v_hits integer;
begin
  if p_units < 1 or p_units > p_limit then
    return false;
  end if;
  insert into app_private.rate_limit_buckets as b (bucket, subject, window_start, hits)
  values (p_bucket, p_subject,
          date_bin(make_interval(secs => p_window_seconds), now(), timestamptz '2000-01-01'), p_units)
  on conflict (bucket, subject, window_start)
  do update set hits = b.hits + excluded.hits where b.hits + excluded.hits <= p_limit
  returning hits into v_hits;
  return v_hits is not null;
end;
$$;

-- Spec 06: 60 requests/minute and 600 events/hour per device (HTTP 429 + Retry-After: 60).
create function public.edge_device_rate_limit(p_device uuid, p_events integer)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not app_private.consume_rate_limit('location_ingest_minute', p_device::text, 60, 60) then
    return false;
  end if;
  return app_private.consume_rate_limit_units('location_ingest_hour', p_device::text, greatest(p_events, 1), 600, 3600);
end;
$$;

-- Which of these SDK uuids already have a durable outcome, and whether it was this device's.
create function public.edge_location_receipt_lookup(p_device uuid, p_event_uuids uuid[])
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('event_uuid', r.event_uuid, 'same_device', r.device_id = p_device)),
                  '[]'::jsonb)
    from app_private.location_event_receipts r
   where r.event_uuid = any(coalesce(p_event_uuids, '{}'))
$$;

-- Terminal outcomes decided before reconciliation (rejected / proof-of-life records) and their
-- bounded, coordinate-free quarantine copies, in one transaction.
create function public.edge_record_location_terminals(p_request_id uuid, p_receipts jsonb, p_quarantine jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
set timezone = 'UTC'
as $$
declare
  v_count integer;
  v_row jsonb;
begin
  for v_row in select value from jsonb_array_elements(coalesce(p_receipts, '[]'::jsonb)) loop
    if app_private.jsonb_has_coordinate_keys(v_row) then
      raise exception 'COORDINATES_NOT_PERMITTED' using errcode = '22023';
    end if;
  end loop;
  insert into app_private.location_event_receipts (
    event_uuid, device_id, worker_id, project_id, config_version_id, event_type, observed_at,
    server_received_at, accuracy_m, qualification_state, terminal_result, rejection_reason, request_id)
  select (r ->> 'event_uuid')::uuid, (r ->> 'device_id')::uuid, (r ->> 'worker_id')::uuid,
         (r ->> 'project_id')::uuid, (r ->> 'config_version_id')::uuid, r ->> 'event_type',
         (r ->> 'observed_at')::timestamptz, (r ->> 'server_received_at')::timestamptz,
         (r ->> 'accuracy_m')::numeric, (r ->> 'qualification_state')::public.qualification_state,
         (r ->> 'terminal_result')::public.terminal_result, r ->> 'rejection_reason', p_request_id
    from jsonb_array_elements(coalesce(p_receipts, '[]'::jsonb)) r
  on conflict (event_uuid) do nothing;
  get diagnostics v_count = row_count;
  insert into app_private.location_ingest_quarantine (event_uuid, device_id, request_id, reason, sanitized_payload)
  select (q ->> 'event_uuid')::uuid, (q ->> 'device_id')::uuid, p_request_id, q ->> 'reason', q -> 'sanitized_payload'
    from jsonb_array_elements(coalesce(p_quarantine, '[]'::jsonb)) q;
  return v_count;
end;
$$;

-- Rotates the device upload credential (decision #44): either the current, not yet rotated,
-- unexpired credential (headless renewal by the SDK) or the signed-in worker's own active phone
-- (foreground renewal, also after expiry). The previous credential keeps working for 24 h.
create function public.edge_device_renew(
  p_token_hash bytea,
  p_user_id uuid,
  p_new_token_hash bytea,
  p_app_version text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set timezone = 'UTC'
as $$
declare
  c app_private.device_upload_credentials;
  d public.device_installations;
  v_auth jsonb;
  v_new uuid;
  v_expires timestamptz := now() + interval '30 days';
begin
  if (p_token_hash is null) = (p_user_id is null) or p_new_token_hash is null or length(p_new_token_hash) <> 32 then
    raise exception 'INVALID_RENEWAL' using errcode = '22023';
  end if;
  if p_token_hash is not null then
    v_auth := public.edge_device_authenticate(p_token_hash);
    if v_auth ->> 'status' <> 'OK' then
      return jsonb_build_object('status', v_auth ->> 'status');
    end if;
    if not (v_auth ->> 'renewable')::boolean then
      return jsonb_build_object('status', 'SUPERSEDED');
    end if;
    select * into c from app_private.device_upload_credentials where id = (v_auth ->> 'credential_id')::uuid for update;
  else
    select dev.* into d
      from public.device_installations dev
      join public.worker_profiles w on w.id = dev.worker_id
     where w.auth_user_id = p_user_id and w.deleted_at is null and dev.active;
    if d.id is null then
      return jsonb_build_object('status', 'NO_DEVICE');
    end if;
    select * into c from app_private.device_upload_credentials
     where device_id = d.id and revoked_at is null and overlap_until is null
     order by created_at desc limit 1 for update;
    if c.id is null then
      return jsonb_build_object('status', 'REVOKED');
    end if;
  end if;
  select * into d from public.device_installations where id = c.device_id for update;
  if not d.active then
    return jsonb_build_object('status', 'REVOKED');
  end if;
  if not app_private.consume_rate_limit('device_renew_hour', d.id::text, 12, 3600) then
    return jsonb_build_object('status', 'RATE_LIMITED');
  end if;
  insert into app_private.device_upload_credentials (device_id, token_sha256, expires_at, rotated_from)
  values (d.id, p_new_token_hash, v_expires, c.id)
  returning id into v_new;
  -- The previous secret stays valid for in-flight batches (24 h, never beyond its own expiry).
  update app_private.device_upload_credentials
     set overlap_until = least(expires_at, now() + interval '24 hours')
   where id = c.id;
  if p_app_version is not null and length(p_app_version) <= 32 and d.app_version is distinct from p_app_version then
    update public.device_installations set app_version = p_app_version where id = d.id;
  end if;
  perform app_private.write_audit(case when p_user_id is null then 'DEVICE' else 'USER' end::public.audit_actor_type,
                                  coalesce(p_user_id, d.id), 'device.credential_renewed', null, null,
                                  'device_installation', d.id, null,
                                  jsonb_build_object('path', case when p_user_id is null then 'DEVICE_TOKEN' else 'USER_SESSION' end));
  return jsonb_build_object('status', 'OK', 'device_id', d.id, 'expires_at', v_expires,
                            'renew_after', v_expires - interval '7 days');
end;
$$;

-- Projects where the worker has an active session: a phone replacement flags them for review
-- (decision #27) through MONITORING REPLACED evidence reconciled by device-activate.
create function public.edge_worker_open_session_projects(p_worker uuid)
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(distinct s.project_id order by s.project_id), '{}')
    from public.attendance_sessions s
   where s.worker_id = p_worker and s.status in ('OPEN', 'PENDING_APPROVAL')
$$;

-- ---------------------------------------------------------------------------------------------
-- Worker: tracking plan for the phone (own data only)
-- ---------------------------------------------------------------------------------------------
create function app_private.credential_status(p_device uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
set timezone = 'UTC'
as $$
  select case
           when c.id is null then jsonb_build_object('status', 'NONE', 'expires_at', null)
           when c.expires_at <= now() then jsonb_build_object('status', 'EXPIRED', 'expires_at', c.expires_at)
           when c.expires_at <= now() + interval '3 days' then jsonb_build_object('status', 'EXPIRING', 'expires_at', c.expires_at)
           else jsonb_build_object('status', 'OK', 'expires_at', c.expires_at)
         end
    from (select null::int) one
    left join lateral (
      select uc.id, uc.expires_at from app_private.device_upload_credentials uc
       where uc.device_id = p_device and uc.revoked_at is null and uc.overlap_until is null
       order by uc.created_at desc limit 1) c on true
$$;

create function public.my_tracking_plan(p_app_version text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
set timezone = 'UTC'
as $$
declare
  v_worker uuid := app_private.current_worker_id();
  d public.device_installations;
begin
  if v_worker is null then
    raise exception 'WORKER_PROFILE_REQUIRED' using errcode = '22023';
  end if;
  select * into d from public.device_installations where worker_id = v_worker and active;
  if d.id is not null and p_app_version is not null and length(p_app_version) <= 32
     and d.app_version is distinct from p_app_version then
    update public.device_installations set app_version = p_app_version where id = d.id;
    d.app_version := p_app_version;
  end if;
  return jsonb_build_object(
    'device_id', d.id,
    'platform', d.platform,
    'credential', case when d.id is null then jsonb_build_object('status', 'NONE', 'expires_at', null)
                       else app_private.credential_status(d.id) end,
    'coordinates_allowed', case when d.id is null then false
                                else app_private.location_coordinates_allowed(d.platform, d.app_version) end,
    'projects', coalesce((
      select jsonb_agg(jsonb_build_object(
               'project_id', p.id, 'project_name', p.name, 'iana_timezone', p.iana_timezone,
               'config_version_id', v.id, 'version_number', v.version_number, 'effective_at', v.effective_at,
               'settings', v.settings_json, 'identifier', g.sdk_identifier,
               'center', jsonb_build_object('lat', extensions.st_y(g.center::extensions.geometry),
                                            'lng', extensions.st_x(g.center::extensions.geometry)),
               'radius_m', g.radius_m::float8,
               'native_radius_m', (g.radius_m + g.exit_hysteresis_m)::float8)
             order by p.name, p.id)
        from public.device_project_bindings b
        join public.projects p on p.id = b.project_id
        join public.project_tracking_config_versions v on v.id = p.config_version_id
        join public.project_geofences g on g.config_version_id = v.id
       where b.device_id = d.id and b.revoked_at is null and b.enabled), '[]'::jsonb),
    'not_monitored', coalesce((
      select jsonb_agg(jsonb_build_object(
               'project_id', p.id, 'project_name', p.name,
               'reason', case
                 when e.subcontractor_id is not null and e.employer_status <> 'VERIFIED' then 'EMPLOYER_NOT_VERIFIED'
                 when p.status <> 'ACTIVE' then 'PROJECT_NOT_ACTIVE'
                 when not exists (select 1 from public.tracking_consents c
                                   where c.worker_id = e.worker_id and c.project_id = e.project_id and c.withdrawn_at is null)
                   then 'CONSENT_MISSING'
                 when d.id is null then 'NO_DEVICE'
                 else 'NOT_BOUND' end)
             order by p.name, p.id)
        from public.worker_enrollments e
        join public.projects p on p.id = e.project_id
       where e.worker_id = v_worker and e.enrollment_status = 'APPROVED'
         and not exists (select 1 from public.device_project_bindings b
                          where b.device_id = d.id and b.project_id = e.project_id
                            and b.revoked_at is null and b.enabled)), '[]'::jsonb));
end;
$$;

-- Signing out revokes this worker's phone immediately (docs/spec/03: revoke on logout): upload
-- secrets and badge secret revoked, device inactive (bindings follow by trigger). The next sign-in
-- activates the phone again.
create function public.revoke_my_device()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_worker uuid := app_private.current_worker_id();
  v_device uuid;
begin
  if v_worker is null then
    return;
  end if;
  select id into v_device from public.device_installations where worker_id = v_worker and active for update;
  if v_device is null then
    return;
  end if;
  update app_private.device_upload_credentials set revoked_at = coalesce(revoked_at, now()) where device_id = v_device;
  update app_private.device_badge_secrets set revoked_at = coalesce(revoked_at, now()) where device_id = v_device;
  update public.device_installations set active = false, deactivated_at = now() where id = v_device;
  perform app_private.write_audit('USER', auth.uid(), 'device.revoked_on_sign_out', null, null,
                                  'device_installation', v_device, null, '{}'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Staff: per-worker tracking health for a project (roster flags CREDENTIAL_EXPIRING/EXPIRED,
-- decision #44). Ids and statuses only; no coordinates.
-- ---------------------------------------------------------------------------------------------
create function public.project_tracking_health(p_project_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set timezone = 'UTC'
as $$
begin
  if not app_private.can_view_roster(p_project_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'worker_id', e.worker_id,
             'device', case when d.id is null then 'NO_DEVICE' else 'ACTIVE' end,
             'bound', b.id is not null,
             'credential', case when d.id is null then 'NONE'
                                else app_private.credential_status(d.id) ->> 'status' end,
             'credential_expires_at', case when d.id is null then null
                                           else app_private.credential_status(d.id) -> 'expires_at' end,
             'monitoring', ps.monitoring_status,
             'last_upload_at', (select max(r.server_received_at) from app_private.location_event_receipts r
                                 where r.device_id = d.id and r.project_id = p_project_id))
           order by e.worker_id)
      from public.worker_enrollments e
      left join public.device_installations d on d.worker_id = e.worker_id and d.active
      left join public.device_project_bindings b
             on b.device_id = d.id and b.project_id = e.project_id and b.revoked_at is null and b.enabled
      left join public.presence_states ps on ps.project_id = e.project_id and ps.worker_id = e.worker_id
     where e.project_id = p_project_id and e.enrollment_status = 'APPROVED'), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Grants (deny by default; decision #57)
-- ---------------------------------------------------------------------------------------------
revoke all on function
  app_private.location_coordinates_allowed(public.device_platform, text),
  app_private.record_location_privacy_signoff(public.device_platform, text, text, text),
  app_private.revoke_location_privacy_signoff(uuid, text),
  app_private.binding_eligible(uuid), app_private.sync_device_bindings(uuid),
  app_private.sync_bindings_for_row(), app_private.sync_bindings_for_project(),
  app_private.device_fences(uuid, uuid),
  app_private.consume_rate_limit_units(text, text, integer, integer, integer),
  app_private.credential_status(uuid)
  from public, anon, authenticated, service_role;

revoke all on function
  public.edge_device_authenticate(bytea), public.edge_device_rate_limit(uuid, integer),
  public.edge_location_receipt_lookup(uuid, uuid[]), public.edge_record_location_terminals(uuid, jsonb, jsonb),
  public.edge_device_renew(bytea, uuid, bytea, text), public.edge_worker_open_session_projects(uuid),
  public.my_tracking_plan(text), public.project_tracking_health(uuid), public.revoke_my_device()
  from public, anon, authenticated, service_role;

grant execute on function
  public.edge_device_authenticate(bytea), public.edge_device_rate_limit(uuid, integer),
  public.edge_location_receipt_lookup(uuid, uuid[]), public.edge_record_location_terminals(uuid, jsonb, jsonb),
  public.edge_device_renew(bytea, uuid, bytea, text), public.edge_worker_open_session_projects(uuid)
  to service_role;

grant execute on function public.my_tracking_plan(text), public.project_tracking_health(uuid), public.revoke_my_device()
  to authenticated;
