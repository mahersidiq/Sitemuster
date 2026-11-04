-- Milestone 02 · Integrity triggers: updated_at, immutability, last owner, version hashing and
-- cross-table consistency. Business workflows (approval, ingestion, muster) arrive in later
-- milestones as audited security-definer functions; these triggers are the safety net beneath them.

-- ---------------------------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'public.organizations', 'public.organization_members', 'public.projects', 'public.project_staff',
    'public.worker_profiles', 'public.emergency_contacts', 'public.subcontractor_companies',
    'public.project_subcontractors', 'public.subcontractor_members', 'public.worker_enrollments',
    'public.attendance_sessions', 'app_private.push_tokens'
  ]
  loop
    execute format(
      'create trigger touch_updated_at before update on %s for each row execute function app_private.touch_updated_at()',
      t
    );
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- IANA timezone validation (projects and session snapshots)
-- ---------------------------------------------------------------------------------------------
create function app_private.assert_valid_timezone()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = new.iana_timezone) then
    raise exception 'invalid IANA timezone' using errcode = '22023';
  end if;
  return new;
end;
$$;

create trigger projects_valid_timezone before insert or update of iana_timezone on public.projects
  for each row execute function app_private.assert_valid_timezone();
create trigger sessions_valid_timezone before insert or update of iana_timezone on public.attendance_sessions
  for each row execute function app_private.assert_valid_timezone();

-- ---------------------------------------------------------------------------------------------
-- Immutability
-- ---------------------------------------------------------------------------------------------

-- Fully immutable rows: never updated; deleted only by a retention purge function that sets
-- `app.retention_purge = on` inside its own transaction (documented retention policy).
create function app_private.forbid_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and coalesce(current_setting('app.retention_purge', true), '') = 'on' then
    return old;
  end if;
  raise exception '% rows are immutable (append-only)', tg_table_name using errcode = '42501';
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'public.project_tracking_config_versions', 'public.project_work_windows', 'public.project_geofences',
    'public.attendance_events', 'public.report_confirmations', 'public.muster_responses',
    'app_private.location_event_receipts', 'app_private.platform_operator_actions', 'app_private.audit_logs'
  ]
  loop
    execute format(
      'create trigger forbid_mutation before update or delete on %s for each row execute function app_private.forbid_mutation()',
      t
    );
  end loop;
end;
$$;

-- Config versions: the server computes the digest of the complete settings document.
create function app_private.config_version_digest()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.sha256 := encode(pg_catalog.sha256(convert_to(new.settings_json::text, 'UTF8')), 'hex');
  return new;
end;
$$;
create trigger config_version_digest before insert on public.project_tracking_config_versions
  for each row execute function app_private.config_version_digest();

-- Legal notices: content and identity are immutable; only review status/publication may change.
create function app_private.legal_notice_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.content_hash := encode(pg_catalog.sha256(convert_to(new.content, 'UTF8')), 'hex');
    return new;
  end if;
  if new.content is distinct from old.content
     or new.content_hash is distinct from old.content_hash
     or new.document_id is distinct from old.document_id
     or new.version is distinct from old.version
     or new.locale is distinct from old.locale
     or new.project_id is distinct from old.project_id
     or new.document_type is distinct from old.document_type then
    raise exception 'legal notice content is immutable; create a new version' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger legal_notice_guard before insert or update on public.legal_notice_versions
  for each row execute function app_private.legal_notice_guard();

-- Corrections: the request is immutable; a decision is recorded once.
create function app_private.correction_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.reason is distinct from old.reason
     or new.original_json is distinct from old.original_json
     or new.proposed_json is distinct from old.proposed_json
     or new.project_id is distinct from old.project_id
     or new.worker_id is distinct from old.worker_id
     or new.session_id is distinct from old.session_id
     or new.channel is distinct from old.channel
     or new.event_uuid is distinct from old.event_uuid
     or new.requested_by is distinct from old.requested_by then
    raise exception 'correction requests are immutable' using errcode = '42501';
  end if;
  if old.status <> 'PENDING' then
    raise exception 'correction already decided' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger correction_guard before update on public.attendance_corrections
  for each row execute function app_private.correction_guard();
create trigger correction_no_delete before delete on public.attendance_corrections
  for each row execute function app_private.forbid_mutation();

-- Daily reports: a version's content never changes; corrections create a new version.
create function app_private.report_guard()
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
     or new.supersedes_id is distinct from old.supersedes_id then
    raise exception 'report versions are immutable; issue a new version' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger report_guard before update on public.daily_company_reports
  for each row execute function app_private.report_guard();
create trigger report_no_delete before delete on public.daily_company_reports
  for each row execute function app_private.forbid_mutation();

-- Muster: a closed event and its snapshot can never change (corrections are amendments).
create function app_private.muster_event_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'muster events cannot be deleted' using errcode = '42501';
  end if;
  if old.status = 'CLOSED' then
    raise exception 'closed muster is immutable' using errcode = '42501';
  end if;
  if new.project_id is distinct from old.project_id
     or new.triggered_at is distinct from old.triggered_at
     or new.triggered_by is distinct from old.triggered_by
     or new.idempotency_key is distinct from old.idempotency_key
     or new.roster_snapshot_hash is distinct from old.roster_snapshot_hash and old.roster_snapshot_hash is not null then
    raise exception 'muster identity is immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger muster_event_guard before update or delete on public.muster_events
  for each row execute function app_private.muster_event_guard();

create function app_private.muster_member_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_status public.muster_status;
begin
  select status into v_status from public.muster_events where id = coalesce(old.muster_id, new.muster_id);
  if tg_op = 'DELETE' or v_status = 'CLOSED' then
    raise exception 'muster snapshot is immutable' using errcode = '42501';
  end if;
  if new.muster_id is distinct from old.muster_id
     or new.worker_id is distinct from old.worker_id
     or new.visitor_id is distinct from old.visitor_id
     or new.initial_status is distinct from old.initial_status
     or new.source is distinct from old.source
     or new.last_detection_at is distinct from old.last_detection_at
     or new.employer_id is distinct from old.employer_id then
    raise exception 'muster snapshot identity is immutable' using errcode = '42501';
  end if;
  -- Never silently downgrade a physical verification (corrections are audited amendments).
  if old.canonical_status = 'VERIFIED_ACCOUNTED' and new.canonical_status <> 'VERIFIED_ACCOUNTED' then
    raise exception 'verified status can only change through an audited amendment' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger muster_member_guard before update or delete on public.muster_snapshot_members
  for each row execute function app_private.muster_member_guard();

-- ---------------------------------------------------------------------------------------------
-- Last owner protection: an organization always keeps at least one active OWNER.
-- ---------------------------------------------------------------------------------------------
create function app_private.protect_last_owner()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_remaining integer;
begin
  if old.role <> 'OWNER' or old.membership_status <> 'ACTIVE' then
    return coalesce(new, old);
  end if;
  if tg_op = 'UPDATE' and new.role = 'OWNER' and new.membership_status = 'ACTIVE' then
    return new;
  end if;
  -- Organization itself being deleted (cascade): nothing to protect.
  if not exists (select 1 from public.organizations where id = old.organization_id) then
    return coalesce(new, old);
  end if;
  select count(*) into v_remaining
    from public.organization_members
   where organization_id = old.organization_id
     and role = 'OWNER'
     and membership_status = 'ACTIVE'
     and id <> old.id;
  if v_remaining = 0 then
    raise exception 'an organization must keep at least one active owner' using errcode = '23514';
  end if;
  return coalesce(new, old);
end;
$$;
create trigger protect_last_owner before update or delete on public.organization_members
  for each row execute function app_private.protect_last_owner();

-- ---------------------------------------------------------------------------------------------
-- Cross-table consistency
-- ---------------------------------------------------------------------------------------------

-- A device-project binding must use an enrollment of the device's own worker for that project.
create function app_private.binding_consistency()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (
    select 1
      from public.worker_enrollments e
      join public.device_installations d on d.worker_id = e.worker_id
     where e.id = new.enrollment_id
       and d.id = new.device_id
       and e.project_id = new.project_id
  ) then
    raise exception 'binding enrollment does not belong to the device worker and project' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger binding_consistency before insert or update on public.device_project_bindings
  for each row execute function app_private.binding_consistency();

-- APPROVED enrollment requires a recorded orientation for that worker and project. Employer
-- verification is a separate administrator action checked by attendance eligibility (#56).
create function app_private.enrollment_approval_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.enrollment_status = 'APPROVED'
     and (tg_op = 'INSERT' or old.enrollment_status is distinct from 'APPROVED')
     and not exists (
       select 1 from public.orientation_records r
        where r.worker_profile_id = new.worker_id and r.project_id = new.project_id
     ) then
    raise exception 'approval requires ORIENTATION_COMPLETED for this project' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger enrollment_approval_guard before insert or update on public.worker_enrollments
  for each row execute function app_private.enrollment_approval_guard();

-- Consent must reference a notice that is global or belongs to the same project, in the same locale.
create function app_private.consent_notice_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.legal_notice_versions n
     where n.id = new.notice_version_id
       and (n.project_id is null or n.project_id = new.project_id)
       and n.locale = new.locale
       and n.document_type in ('WORKER_LOCATION_DISCLOSURE', 'GC_CUSTOM_NOTICE')
  ) then
    raise exception 'consent notice must be a location/GC notice for this project and locale' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger consent_notice_guard before insert or update of notice_version_id, project_id, locale
  on public.tracking_consents for each row execute function app_private.consent_notice_guard();

-- Muster responses must target a member of the same muster.
create function app_private.muster_response_consistency()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.muster_snapshot_members m
     where m.id = new.snapshot_member_id and m.muster_id = new.muster_id
  ) then
    raise exception 'response member does not belong to this muster' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger muster_response_consistency before insert on public.muster_responses
  for each row execute function app_private.muster_response_consistency();
