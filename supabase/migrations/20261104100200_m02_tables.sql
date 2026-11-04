-- Milestone 02 · Multi-tenant schema (docs/spec/05-data-model.md).
-- Conventions: uuid keys, timestamptz (UTC), IANA zone per project, no client writes (all
-- mutations go through audited security-definer functions or Edge Functions).
-- Tracking-affecting settings (radius, hysteresis, dwell, 24/7, windows) live ONLY in immutable
-- config versions (decision #29); `projects.config_version_id` points at the current version.

-- ---------------------------------------------------------------------------------------------
-- Shared helpers used by constraints
-- ---------------------------------------------------------------------------------------------

-- True when any key at any depth names a coordinate. Used to keep coordinates out of
-- quarantine, audit metadata and other diagnostic JSON (privacy contract, spec 09).
create function app_private.jsonb_has_coordinate_keys(doc jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  with recursive walk(v) as (
    select doc
    union all
    select child.value
      from walk w
      cross join lateral (
        select e.value from jsonb_each(case when jsonb_typeof(w.v) = 'object' then w.v else '{}'::jsonb end) e
        union all
        select a.value from jsonb_array_elements(case when jsonb_typeof(w.v) = 'array' then w.v else '[]'::jsonb end) a
      ) child
  )
  select exists (
    select 1
      from walk w
      cross join lateral jsonb_object_keys(case when jsonb_typeof(w.v) = 'object' then w.v else '{}'::jsonb end) k
     where k ~* '^(coords?|coordinates?|lat|lng|lon|long|latitude|longitude|location|position|point|geo|geometry|geography|onsite_point)$'
  );
$$;

create function app_private.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Platform operators (private backend/CLI only; decision #32)
-- ---------------------------------------------------------------------------------------------

create table app_private.platform_operators (
  user_id uuid primary key references auth.users (id) on delete cascade,
  active boolean not null default true,
  note text check (note is null or length(note) <= 200),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------------------------
-- Organizations, membership, projects, configuration versions
-- ---------------------------------------------------------------------------------------------

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 200),
  address text check (address is null or length(address) <= 500),
  business_email text check (business_email is null or length(business_email) <= 320),
  phone text check (phone is null or length(phone) <= 32),
  owner_user_id uuid not null references auth.users (id) on delete restrict,
  status public.org_status not null default 'ACTIVE',
  idempotency_key uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organizations_owner_idempotency_uq unique (owner_user_id, idempotency_key)
);

create table public.organization_members (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.org_role not null,
  membership_status public.membership_status not null default 'ACTIVE',
  added_by uuid references auth.users (id) on delete set null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organization_members_revoked_ck check ((membership_status = 'REVOKED') = (revoked_at is not null))
);
create unique index organization_members_active_uq
  on public.organization_members (organization_id, user_id, role)
  where membership_status = 'ACTIVE';
create index organization_members_user_idx on public.organization_members (user_id);

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  name text not null check (length(btrim(name)) between 1 and 200),
  project_number text check (project_number is null or length(project_number) <= 64),
  address text check (address is null or length(address) <= 500),
  iana_timezone text not null check (length(iana_timezone) between 1 and 64),
  status public.project_status not null default 'DRAFT',
  assigned_superintendent_id uuid references auth.users (id) on delete set null,
  config_version_id uuid,
  created_by uuid references auth.users (id) on delete set null,
  idempotency_key uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint projects_org_idempotency_uq unique (organization_id, idempotency_key)
);
create index projects_org_idx on public.projects (organization_id);

create table public.project_tracking_config_versions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete restrict,
  version_number integer not null check (version_number >= 1),
  effective_at timestamptz not null,
  created_by uuid,
  reason text check (reason is null or length(reason) <= 1000),
  settings_json jsonb not null check (jsonb_typeof(settings_json) = 'object'),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  operates_24_7 boolean not null default false,
  created_at timestamptz not null default now(),
  constraint config_versions_project_version_uq unique (project_id, version_number),
  constraint config_versions_id_project_uq unique (id, project_id)
);

alter table public.projects
  add constraint projects_config_version_fk
  foreign key (config_version_id, id)
  references public.project_tracking_config_versions (id, project_id)
  deferrable initially deferred;

create table public.project_work_windows (
  id uuid primary key default gen_random_uuid(),
  config_version_id uuid not null references public.project_tracking_config_versions (id) on delete restrict,
  weekday smallint not null check (weekday between 1 and 7),
  local_start_time time not null,
  local_end_time time not null,
  crosses_midnight boolean not null,
  enabled boolean not null default true,
  sort_order smallint not null default 0,
  created_at timestamptz not null default now(),
  constraint work_windows_distinct_ck check (local_start_time <> local_end_time),
  constraint work_windows_midnight_ck check (crosses_midnight = (local_end_time < local_start_time))
);
create index project_work_windows_version_idx on public.project_work_windows (config_version_id);

create table public.project_geofences (
  id uuid primary key default gen_random_uuid(),
  config_version_id uuid not null,
  project_id uuid not null,
  center extensions.geography(point, 4326) not null,
  radius_m numeric(7, 2) not null check (radius_m between 150 and 2000),
  exit_hysteresis_m numeric(6, 2) not null default 50 check (exit_hysteresis_m between 0 and 500),
  sdk_identifier text not null default ('sm_' || replace(gen_random_uuid()::text, '-', '')),
  created_at timestamptz not null default now(),
  constraint project_geofences_version_fk foreign key (config_version_id, project_id)
    references public.project_tracking_config_versions (id, project_id) on delete restrict,
  constraint project_geofences_one_per_version_uq unique (config_version_id),
  constraint project_geofences_sdk_identifier_uq unique (sdk_identifier),
  constraint project_geofences_center_range_ck check (
    extensions.st_y(center::extensions.geometry) between -90 and 90
    and extensions.st_x(center::extensions.geometry) between -180 and 180
  )
);
create index project_geofences_project_idx on public.project_geofences (project_id);

create table public.project_staff (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.project_staff_role not null,
  status public.membership_status not null default 'ACTIVE',
  emergency_designated boolean not null default false,
  can_configure_project boolean not null default false,
  can_assign_staff boolean not null default false,
  can_approve_corrections boolean not null default false,
  added_by uuid references auth.users (id) on delete set null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint project_staff_revoked_ck check ((status = 'REVOKED') = (revoked_at is not null))
);
create unique index project_staff_active_uq
  on public.project_staff (project_id, user_id, role) where status = 'ACTIVE';
create index project_staff_user_idx on public.project_staff (user_id);

create table public.organization_invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  project_id uuid references public.projects (id) on delete cascade,
  target_email text check (target_email is null or length(target_email) <= 320),
  target_phone text check (target_phone is null or length(target_phone) <= 32),
  role public.org_role,
  project_role public.project_staff_role,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  used_at timestamptz,
  token_hash bytea not null check (length(token_hash) = 32),
  invited_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint invitations_target_ck check (target_email is not null or target_phone is not null),
  constraint invitations_kind_ck check (
    (role is not null and project_id is null and project_role is null)
    or (role is null and project_id is not null and project_role is not null)
  ),
  constraint invitations_token_uq unique (token_hash)
);

-- ---------------------------------------------------------------------------------------------
-- Workers, companies, membership and consent
-- ---------------------------------------------------------------------------------------------

create table public.worker_profiles (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid references auth.users (id) on delete set null,
  legal_name text not null check (length(btrim(legal_name)) between 1 and 200),
  email text check (email is null or length(email) <= 320),
  phone text check (phone is null or phone ~ '^\+[1-9][0-9]{7,14}$'),
  primary_language public.locale_code not null default 'en-US',
  managed_identity boolean not null default false,
  created_by uuid references auth.users (id) on delete set null,
  pseudonym_label text check (pseudonym_label is null or pseudonym_label ~ '^Deleted worker #[0-9a-f]{4,12}$'),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A managed (no-phone) identity never gets an invented auth account; a self-registered worker
  -- always has one until account deletion detaches it.
  constraint worker_profiles_identity_ck check (
    deleted_at is not null or managed_identity or auth_user_id is not null
  ),
  constraint worker_profiles_managed_ck check (not (managed_identity and auth_user_id is not null))
);
create unique index worker_profiles_auth_user_uq
  on public.worker_profiles (auth_user_id) where auth_user_id is not null and deleted_at is null;

create table public.emergency_contacts (
  id uuid primary key default gen_random_uuid(),
  worker_profile_id uuid not null references public.worker_profiles (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 200),
  phone text not null check (length(phone) between 7 and 32),
  relationship text check (relationship is null or length(relationship) <= 64),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index emergency_contacts_worker_idx on public.emergency_contacts (worker_profile_id);

create table public.subcontractor_companies (
  id uuid primary key default gen_random_uuid(),
  canonical_name text not null check (length(btrim(canonical_name)) between 1 and 200),
  default_trade text check (default_trade is null or length(default_trade) <= 100),
  verified_status public.company_verification_status not null default 'PENDING',
  verified_by uuid references auth.users (id) on delete set null,
  verified_at timestamptz,
  contact_name text check (contact_name is null or length(contact_name) <= 200),
  contact_phone text check (contact_phone is null or length(contact_phone) <= 32),
  contact_email text check (contact_email is null or length(contact_email) <= 320),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint subcontractor_verified_ck check (verified_status <> 'VERIFIED' or verified_at is not null)
);

create table public.project_subcontractors (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  subcontractor_id uuid not null references public.subcontractor_companies (id) on delete restrict,
  status public.project_company_status not null default 'PENDING',
  approved_by uuid references auth.users (id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index project_subcontractors_active_uq
  on public.project_subcontractors (project_id, subcontractor_id) where status <> 'REMOVED';

create table public.subcontractor_members (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.subcontractor_companies (id) on delete cascade,
  worker_profile_id uuid not null references public.worker_profiles (id) on delete cascade,
  role public.subcontractor_member_role not null,
  trade text check (trade is null or length(trade) <= 100),
  verification_status public.member_verification_status not null default 'PENDING',
  valid_from timestamptz not null default now(),
  valid_until timestamptz,
  authorized_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint subcontractor_members_validity_ck check (valid_until is null or valid_until > valid_from)
);
create unique index subcontractor_members_active_uq
  on public.subcontractor_members (company_id, worker_profile_id, role)
  where verification_status in ('PENDING', 'VERIFIED');
create index subcontractor_members_worker_idx on public.subcontractor_members (worker_profile_id);

-- Explicit GC grants to a foreman for one project (location view, emergency contacts, kiosk).
create table public.foreman_project_grants (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  subcontractor_id uuid not null references public.subcontractor_companies (id) on delete cascade,
  foreman_profile_id uuid not null references public.worker_profiles (id) on delete cascade,
  can_view_locations boolean not null default false,
  can_view_emergency_contacts boolean not null default false,
  can_operate_kiosk boolean not null default false,
  granted_by uuid references auth.users (id) on delete set null,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz
);
create unique index foreman_project_grants_active_uq
  on public.foreman_project_grants (project_id, foreman_profile_id, subcontractor_id) where revoked_at is null;

create table public.legal_notice_versions (
  id uuid primary key default gen_random_uuid(),
  document_id text not null check (document_id ~ '^[A-Z0-9_]{3,80}$'),
  project_id uuid references public.projects (id) on delete restrict,
  locale public.locale_code not null,
  document_type public.legal_document_type not null,
  version integer not null check (version >= 1),
  content text not null check (length(content) between 1 and 100000),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  review_status public.legal_review_status not null default 'DRAFT_REQUIRES_HUMAN_REVIEW',
  approved_by uuid references auth.users (id) on delete set null,
  approved_at timestamptz,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  constraint legal_notice_approval_ck check (review_status <> 'APPROVED' or approved_at is not null)
);
create unique index legal_notice_versions_uq
  on public.legal_notice_versions (document_id, version, locale, coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid));

create table public.orientation_sessions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  started_by uuid references auth.users (id) on delete set null,
  starts_at timestamptz not null default now(),
  expires_at timestamptz not null,
  status public.orientation_session_status not null default 'OPEN',
  static_code_hash bytea check (static_code_hash is null or length(static_code_hash) = 32),
  rotating_secret_id uuid,
  revoked_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint orientation_sessions_window_ck check (
    expires_at > starts_at and expires_at <= starts_at + interval '120 minutes'
  )
);
create index orientation_sessions_project_idx on public.orientation_sessions (project_id, starts_at);

create table app_private.orientation_invites (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.orientation_sessions (id) on delete cascade,
  project_id uuid not null references public.projects (id) on delete cascade,
  invite_token_hash bytea not null check (length(invite_token_hash) = 32),
  kind public.orientation_invite_kind not null,
  expires_at timestamptz not null,
  redeemed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint orientation_invites_token_uq unique (invite_token_hash)
);

create table public.orientation_records (
  id uuid primary key default gen_random_uuid(),
  worker_profile_id uuid not null references public.worker_profiles (id) on delete cascade,
  project_id uuid not null references public.projects (id) on delete cascade,
  session_id uuid references public.orientation_sessions (id) on delete set null,
  status text not null default 'ORIENTATION_COMPLETED' check (status = 'ORIENTATION_COMPLETED'),
  completed_at timestamptz not null,
  operator_id uuid references auth.users (id) on delete set null,
  notice_version_id uuid references public.legal_notice_versions (id) on delete restrict,
  created_at timestamptz not null default now()
);
create index orientation_records_project_worker_idx on public.orientation_records (project_id, worker_profile_id);

create table public.worker_enrollments (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  worker_id uuid not null references public.worker_profiles (id) on delete restrict,
  subcontractor_id uuid references public.subcontractor_companies (id) on delete restrict,
  trade text check (trade is null or length(trade) <= 100),
  enrollment_status public.enrollment_status not null default 'PENDING',
  employer_status public.employer_status not null default 'PENDING_CONFIRMATION',
  approved_by uuid references auth.users (id) on delete set null,
  approval_at timestamptz,
  employer_confirmed_by uuid references auth.users (id) on delete set null,
  employer_confirmed_at timestamptz,
  rejected_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint worker_enrollments_approval_ck check (enrollment_status <> 'APPROVED' or approval_at is not null),
  constraint worker_enrollments_employer_ck check (employer_status <> 'VERIFIED' or employer_confirmed_at is not null)
);
create unique index worker_enrollments_active_uq
  on public.worker_enrollments (project_id, worker_id) where enrollment_status in ('PENDING', 'APPROVED');
create index worker_enrollments_worker_idx on public.worker_enrollments (worker_id);
create index worker_enrollments_company_idx on public.worker_enrollments (subcontractor_id, project_id);

create table public.tracking_consents (
  id uuid primary key default gen_random_uuid(),
  worker_id uuid not null references public.worker_profiles (id) on delete cascade,
  project_id uuid not null references public.projects (id) on delete cascade,
  notice_version_id uuid not null references public.legal_notice_versions (id) on delete restrict,
  locale public.locale_code not null,
  method public.consent_method not null,
  accepted_at timestamptz not null,
  withdrawn_at timestamptz,
  reviewing_actor uuid references auth.users (id) on delete set null,
  evidence_digest text check (evidence_digest is null or evidence_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  constraint tracking_consents_withdrawn_ck check (withdrawn_at is null or withdrawn_at >= accepted_at)
);
create unique index tracking_consents_active_uq
  on public.tracking_consents (worker_id, project_id) where withdrawn_at is null;

-- ---------------------------------------------------------------------------------------------
-- Devices, credentials, kiosks and badges
-- ---------------------------------------------------------------------------------------------

create table public.device_installations (
  id uuid primary key default gen_random_uuid(),
  worker_id uuid not null references public.worker_profiles (id) on delete cascade,
  platform public.device_platform not null,
  hardware_installation_hash text not null check (hardware_installation_hash ~ '^[0-9a-f]{64}$'),
  app_version text check (app_version is null or length(app_version) <= 32),
  active boolean not null default true,
  activated_at timestamptz not null default now(),
  deactivated_at timestamptz,
  replaced_by uuid references public.device_installations (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint device_installations_active_ck check (active = (deactivated_at is null))
);
-- One active personal tracking device per worker (decision #27).
create unique index device_installations_one_active_uq
  on public.device_installations (worker_id) where active;

create table public.device_project_bindings (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.device_installations (id) on delete cascade,
  project_id uuid not null references public.projects (id) on delete cascade,
  enrollment_id uuid not null references public.worker_enrollments (id) on delete cascade,
  enabled boolean not null default true,
  config_version_id uuid references public.project_tracking_config_versions (id) on delete restrict,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index device_project_bindings_active_uq
  on public.device_project_bindings (device_id, project_id) where revoked_at is null;

create table app_private.device_upload_credentials (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.device_installations (id) on delete cascade,
  token_sha256 bytea not null check (length(token_sha256) = 32),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  rotated_from uuid references app_private.device_upload_credentials (id) on delete set null,
  overlap_until timestamptz,
  constraint device_upload_credentials_token_uq unique (token_sha256),
  constraint device_upload_credentials_lifetime_ck check (expires_at <= created_at + interval '30 days'),
  constraint device_upload_credentials_overlap_ck check (
    overlap_until is null or overlap_until <= created_at + interval '30 days' + interval '24 hours'
  )
);
create index device_upload_credentials_device_idx on app_private.device_upload_credentials (device_id);

create table app_private.device_badge_secrets (
  device_id uuid primary key references public.device_installations (id) on delete cascade,
  secret_ciphertext bytea not null,
  key_version smallint not null default 1,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

-- Single owner-only push token store (covers silent renew pushes and notifications; decision #54).
create table app_private.push_tokens (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null references auth.users (id) on delete cascade,
  installation_id text not null check (length(installation_id) between 8 and 128),
  device_id uuid references public.device_installations (id) on delete set null,
  expo_token text not null check (length(expo_token) <= 256),
  platform public.device_platform not null,
  last_validated_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index push_tokens_installation_active_uq
  on app_private.push_tokens (installation_id) where revoked_at is null;

create table public.kiosk_devices (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  assigned_operator_user_id uuid references auth.users (id) on delete set null,
  device_public_id text not null check (length(device_public_id) between 8 and 128),
  status public.kiosk_status not null default 'ACTIVE',
  registered_at timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked_at timestamptz,
  constraint kiosk_devices_public_id_uq unique (device_public_id),
  constraint kiosk_devices_revoked_ck check ((status = 'REVOKED') = (revoked_at is not null))
);

create table public.worker_badges (
  id uuid primary key default gen_random_uuid(),
  worker_id uuid not null references public.worker_profiles (id) on delete cascade,
  badge_kind public.badge_kind not null,
  opaque_badge_hash bytea check (opaque_badge_hash is null or length(opaque_badge_hash) = 32),
  active boolean not null default true,
  issued_by uuid references auth.users (id) on delete set null,
  issued_at timestamptz not null default now(),
  revoked_at timestamptz,
  constraint worker_badges_kind_ck check ((badge_kind = 'PRINTED') = (opaque_badge_hash is not null)),
  constraint worker_badges_active_ck check (active = (revoked_at is null))
);
create unique index worker_badges_hash_uq on public.worker_badges (opaque_badge_hash) where opaque_badge_hash is not null;

create table app_private.badge_nonce_redemptions (
  project_id uuid not null references public.projects (id) on delete cascade,
  device_id uuid not null references public.device_installations (id) on delete cascade,
  time_step bigint not null check (time_step > 0),
  redeemed_at timestamptz not null default now(),
  operator_id uuid references auth.users (id) on delete set null,
  kiosk_device_id uuid references public.kiosk_devices (id) on delete set null,
  event_uuid uuid not null,
  primary key (project_id, device_id, time_step)
);

-- ---------------------------------------------------------------------------------------------
-- Location receipts, raw fixes, latest positions (privacy-critical)
-- ---------------------------------------------------------------------------------------------

-- Immutable, coordinate-free outcome log for every native record (accepted/duplicate/rejected).
create table app_private.location_event_receipts (
  event_uuid uuid primary key,
  device_id uuid not null references public.device_installations (id) on delete restrict,
  worker_id uuid not null references public.worker_profiles (id) on delete restrict,
  project_id uuid references public.projects (id) on delete restrict,
  config_version_id uuid references public.project_tracking_config_versions (id) on delete restrict,
  event_type text not null check (event_type in ('GEOFENCE_ENTER', 'GEOFENCE_EXIT', 'ONSITE_FIX', 'OTHER')),
  observed_at timestamptz not null,
  server_received_at timestamptz not null default now(),
  accuracy_m numeric(8, 2) check (accuracy_m is null or accuracy_m >= 0),
  qualification_state public.qualification_state not null,
  terminal_result public.terminal_result not null,
  rejection_reason text check (rejection_reason is null or length(rejection_reason) <= 64),
  request_id uuid,
  constraint receipts_rejection_ck check ((terminal_result = 'rejected') = (rejection_reason is not null))
);
create index location_event_receipts_device_idx on app_private.location_event_receipts (device_id, server_received_at);
create index location_event_receipts_project_idx on app_private.location_event_receipts (project_id, observed_at);

-- Restricted quarantine for permanently invalid records: bounded, sanitized, coordinate-free.
create table app_private.location_ingest_quarantine (
  id uuid primary key default gen_random_uuid(),
  event_uuid uuid,
  device_id uuid references public.device_installations (id) on delete cascade,
  request_id uuid,
  reason text not null check (length(reason) <= 64),
  sanitized_payload jsonb not null check (length(sanitized_payload::text) <= 4096),
  received_at timestamptz not null default now(),
  constraint quarantine_coordinate_free_ck check (not app_private.jsonb_has_coordinate_keys(sanitized_payload))
);

-- Short-lived raw onsite fixes. Every row expires at most 24 h after receipt (decision #55), and
-- whole daily partitions are dropped by app_private.purge_expired_raw_fixes().
create table app_private.raw_onsite_fixes (
  id uuid not null default gen_random_uuid(),
  event_uuid uuid not null,
  project_id uuid not null,
  worker_id uuid not null,
  session_id uuid,
  point extensions.geography(point, 4326) not null,
  accuracy_m numeric(8, 2) not null check (accuracy_m >= 0),
  observed_at timestamptz not null,
  received_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (id, expires_at),
  constraint raw_fixes_retention_ck check (expires_at <= received_at + interval '24 hours' and expires_at > received_at)
) partition by range (expires_at);

create table public.latest_onsite_positions (
  project_id uuid not null references public.projects (id) on delete cascade,
  worker_id uuid not null references public.worker_profiles (id) on delete cascade,
  position extensions.geography(point, 4326) not null,
  horizontal_accuracy_m numeric(8, 2) not null check (horizontal_accuracy_m >= 0),
  observed_at timestamptz not null,
  received_at timestamptz not null default now(),
  expiry_at timestamptz not null,
  primary key (project_id, worker_id),
  constraint latest_positions_expiry_ck check (expiry_at > observed_at)
);

-- ---------------------------------------------------------------------------------------------
-- Attendance
-- ---------------------------------------------------------------------------------------------

create table public.attendance_sessions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete restrict,
  worker_id uuid not null references public.worker_profiles (id) on delete restrict,
  employer_snapshot_id uuid references public.subcontractor_companies (id) on delete restrict,
  start_at timestamptz not null,
  end_at timestamptz,
  start_source public.attendance_source not null,
  end_source public.attendance_source,
  config_version_id uuid not null references public.project_tracking_config_versions (id) on delete restrict,
  status public.session_status not null,
  start_earliest_at timestamptz,
  start_latest_at timestamptz,
  end_earliest_at timestamptz,
  end_latest_at timestamptz,
  last_seen_at timestamptz,
  last_confirmed_inside_at timestamptz,
  iana_timezone text not null check (length(iana_timezone) between 1 and 64),
  shift_snapshot jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sessions_end_after_start_ck check (end_at is null or end_at >= start_at),
  constraint sessions_end_source_ck check ((end_at is null) = (end_source is null)),
  constraint sessions_start_bounds_ck check (
    start_earliest_at is null or start_latest_at is null or start_earliest_at <= start_latest_at
  ),
  constraint sessions_end_bounds_ck check (
    end_earliest_at is null or end_latest_at is null or end_earliest_at <= end_latest_at
  ),
  constraint sessions_open_has_no_end_ck check (status not in ('OPEN', 'PENDING_APPROVAL') or end_at is null)
);
-- At most one open/pending/unresolved session per project and worker (spec 04/05).
create unique index attendance_sessions_one_open_uq
  on public.attendance_sessions (project_id, worker_id)
  where status in ('OPEN', 'PENDING_APPROVAL', 'UNRESOLVED');
create index attendance_sessions_project_start_idx on public.attendance_sessions (project_id, start_at);
create index attendance_sessions_worker_idx on public.attendance_sessions (project_id, worker_id);

create table public.attendance_events (
  event_uuid uuid primary key,
  worker_id uuid not null references public.worker_profiles (id) on delete restrict,
  project_id uuid not null references public.projects (id) on delete restrict,
  session_id uuid references public.attendance_sessions (id) on delete restrict,
  actor_id uuid,
  kiosk_device_id uuid references public.kiosk_devices (id) on delete restrict,
  device_id uuid references public.device_installations (id) on delete restrict,
  config_version_id uuid not null references public.project_tracking_config_versions (id) on delete restrict,
  source public.attendance_source not null,
  direction public.attendance_direction not null,
  observed_at timestamptz not null,
  received_at timestamptz not null default now(),
  verification_status public.attendance_verification not null,
  confidence public.evidence_confidence not null,
  reason text check (reason is null or length(reason) <= 1000),
  original_payload_digest text check (original_payload_digest is null or original_payload_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  constraint attendance_events_geofence_device_ck check (source <> 'GEOFENCE' or device_id is not null),
  constraint attendance_events_kiosk_ck check (
    source not in ('KIOSK_DYNAMIC_BADGE', 'KIOSK_PRINTED_BADGE') or kiosk_device_id is not null
  ),
  constraint attendance_events_human_actor_ck check (
    source not in ('FOREMAN', 'MANUAL', 'KIOSK_DYNAMIC_BADGE', 'KIOSK_PRINTED_BADGE') or actor_id is not null
  ),
  constraint attendance_events_manual_reason_ck check (source <> 'MANUAL' or reason is not null)
);
create index attendance_events_project_observed_idx on public.attendance_events (project_id, observed_at);
create index attendance_events_project_worker_idx on public.attendance_events (project_id, worker_id);

create table public.presence_states (
  project_id uuid not null references public.projects (id) on delete cascade,
  worker_id uuid not null references public.worker_profiles (id) on delete cascade,
  presence_state public.presence_state not null,
  first_inside_at timestamptz,
  last_seen_at timestamptz,
  last_confirmed_inside_at timestamptz,
  arrival_confirmed_at timestamptz,
  confidence public.evidence_confidence not null,
  changed_at timestamptz not null default now(),
  config_version_id uuid not null references public.project_tracking_config_versions (id) on delete restrict,
  primary key (project_id, worker_id)
);

create table public.attendance_corrections (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references public.attendance_sessions (id) on delete restrict,
  project_id uuid not null references public.projects (id) on delete restrict,
  worker_id uuid not null references public.worker_profiles (id) on delete restrict,
  channel public.correction_channel not null,
  requested_by uuid,
  approved_by uuid,
  reason text not null check (length(btrim(reason)) between 3 and 1000),
  original_json jsonb not null default '{}'::jsonb,
  proposed_json jsonb not null,
  status public.correction_status not null default 'PENDING',
  action_at timestamptz,
  event_uuid uuid not null,
  created_at timestamptz not null default now(),
  constraint attendance_corrections_event_uq unique (event_uuid),
  constraint attendance_corrections_decision_ck check ((status = 'PENDING') = (action_at is null))
);
create index attendance_corrections_project_idx on public.attendance_corrections (project_id, created_at);

create table app_private.operational_outbox_receipts (
  event_uuid uuid primary key,
  kiosk_device_id uuid references public.kiosk_devices (id) on delete set null,
  actor_id uuid references auth.users (id) on delete set null,
  project_id uuid references public.projects (id) on delete cascade,
  operation_type text not null check (length(operation_type) <= 64),
  payload_schema text not null check (length(payload_schema) <= 64),
  terminal_status public.terminal_result not null,
  rejection_reason text check (rejection_reason is null or length(rejection_reason) <= 200),
  accepted_at timestamptz not null default now(),
  request_id uuid
);

-- ---------------------------------------------------------------------------------------------
-- Visitors (never counted in workforce totals)
-- ---------------------------------------------------------------------------------------------

create table public.visitor_records (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 200),
  organization text check (organization is null or length(organization) <= 200),
  host_user_id uuid references auth.users (id) on delete set null,
  purpose text not null check (length(btrim(purpose)) between 1 and 500),
  contact_phone text check (contact_phone is null or length(contact_phone) <= 32),
  identity_status public.visitor_identity_status not null default 'UNVERIFIED',
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.visitor_visits (
  id uuid primary key default gen_random_uuid(),
  visitor_id uuid not null references public.visitor_records (id) on delete cascade,
  project_id uuid not null references public.projects (id) on delete cascade,
  kiosk_actor_id uuid references auth.users (id) on delete set null,
  kiosk_device_id uuid references public.kiosk_devices (id) on delete set null,
  checked_in_at timestamptz not null,
  checked_out_at timestamptz,
  status public.visitor_visit_status not null default 'OPEN',
  correction_audit_id uuid,
  idempotency_key uuid not null,
  constraint visitor_visits_idempotency_uq unique (idempotency_key),
  constraint visitor_visits_interval_ck check (checked_out_at is null or checked_out_at >= checked_in_at),
  constraint visitor_visits_closed_ck check ((status = 'CLOSED') = (checked_out_at is not null))
);
create index visitor_visits_project_idx on public.visitor_visits (project_id, checked_in_at);

-- ---------------------------------------------------------------------------------------------
-- Daily company reports and foreman confirmations
-- ---------------------------------------------------------------------------------------------

create table public.daily_company_reports (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete restrict,
  subcontractor_id uuid not null references public.subcontractor_companies (id) on delete restrict,
  local_date date not null,
  report_version integer not null default 1 check (report_version >= 1),
  summary jsonb not null check (jsonb_typeof(summary) = 'object'),
  generated_at timestamptz not null default now(),
  status public.report_status not null default 'PENDING_CONFIRMATION',
  due_at timestamptz not null,
  supersedes_id uuid references public.daily_company_reports (id) on delete restrict,
  constraint daily_reports_version_uq unique (project_id, subcontractor_id, local_date, report_version),
  constraint daily_reports_coordinate_free_ck check (not app_private.jsonb_has_coordinate_keys(summary))
);
create index daily_company_reports_project_date_idx on public.daily_company_reports (project_id, local_date);

create table public.report_confirmations (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.daily_company_reports (id) on delete restrict,
  version integer not null check (version >= 1),
  foreman_user_id uuid not null,
  action public.report_action not null,
  comment text check (comment is null or length(comment) <= 2000),
  proposed_correction jsonb,
  event_uuid uuid not null,
  created_at timestamptz not null default now(),
  constraint report_confirmations_event_uq unique (event_uuid),
  constraint report_confirmations_reason_ck check (action = 'CONFIRM' or comment is not null)
);

-- ---------------------------------------------------------------------------------------------
-- Active Muster Mode (supplemental; never certified life-safety)
-- ---------------------------------------------------------------------------------------------

create table public.muster_events (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete restrict,
  triggered_by uuid,
  triggered_at timestamptz not null default now(),
  ended_at timestamptz,
  ended_by uuid,
  status public.muster_status not null default 'ACTIVE',
  incident_label text not null check (length(btrim(incident_label)) between 1 and 200),
  incident_key text not null default 'default' check (length(incident_key) between 1 and 64),
  roster_snapshot_hash text check (roster_snapshot_hash is null or roster_snapshot_hash ~ '^[0-9a-f]{64}$'),
  closeout_report_digest text check (closeout_report_digest is null or closeout_report_digest ~ '^[0-9a-f]{64}$'),
  closeout_note text check (closeout_note is null or length(closeout_note) <= 2000),
  closeout_acknowledged_incomplete boolean,
  config_version_id uuid references public.project_tracking_config_versions (id) on delete restrict,
  idempotency_key uuid not null,
  constraint muster_events_idempotency_uq unique (project_id, idempotency_key),
  constraint muster_events_closed_ck check ((status = 'CLOSED') = (ended_at is not null))
);
-- One ACTIVE muster per project and incident key; concurrent starts collapse (spec 12).
create unique index muster_events_one_active_uq
  on public.muster_events (project_id, incident_key) where status = 'ACTIVE';

create table public.muster_snapshot_members (
  id uuid primary key default gen_random_uuid(),
  muster_id uuid not null references public.muster_events (id) on delete restrict,
  worker_id uuid references public.worker_profiles (id) on delete restrict,
  visitor_id uuid references public.visitor_records (id) on delete restrict,
  employer_id uuid references public.subcontractor_companies (id) on delete restrict,
  source text check (source is null or length(source) <= 64),
  last_detection_at timestamptz,
  initial_status public.muster_member_status not null,
  canonical_status public.muster_member_status not null,
  created_at timestamptz not null default now(),
  constraint muster_members_person_ck check ((worker_id is null) <> (visitor_id is null)),
  constraint muster_members_initial_ck check (initial_status in ('UNACCOUNTED', 'STATUS_UNKNOWN'))
);
create unique index muster_snapshot_members_worker_uq on public.muster_snapshot_members (muster_id, worker_id) where worker_id is not null;
create unique index muster_snapshot_members_visitor_uq on public.muster_snapshot_members (muster_id, visitor_id) where visitor_id is not null;

create table public.muster_responses (
  id uuid primary key default gen_random_uuid(),
  muster_id uuid not null references public.muster_events (id) on delete restrict,
  snapshot_member_id uuid not null references public.muster_snapshot_members (id) on delete restrict,
  action public.muster_response_action not null,
  responder_id uuid,
  channel public.muster_channel not null,
  kiosk_device_id uuid references public.kiosk_devices (id) on delete restrict,
  observed_at timestamptz not null,
  received_at timestamptz not null default now(),
  reason text check (reason is null or length(reason) <= 1000),
  resulting_status public.muster_member_status not null,
  event_uuid uuid not null,
  constraint muster_responses_event_uq unique (event_uuid),
  -- Self reports can only ever produce SELF_REPORTED_SAFE (never VERIFIED_ACCOUNTED).
  constraint muster_responses_self_ck check (action <> 'SELF_REPORT' or resulting_status = 'SELF_REPORTED_SAFE'),
  constraint muster_responses_self_channel_ck check (
    action <> 'SELF_REPORT' or channel in ('APP', 'NOTIFICATION_ACTION')
  ),
  constraint muster_responses_verify_ck check (
    action <> 'PHYSICAL_VERIFICATION' or (resulting_status = 'VERIFIED_ACCOUNTED' and channel in ('KIOSK', 'FOREMAN', 'SAFETY_STAFF'))
  )
);
create index muster_responses_member_idx on public.muster_responses (snapshot_member_id, observed_at);

-- ---------------------------------------------------------------------------------------------
-- Audit (append-only, minimal data)
-- ---------------------------------------------------------------------------------------------

create table app_private.platform_operator_actions (
  id uuid primary key default gen_random_uuid(),
  platform_user_id uuid not null,
  action public.platform_operator_action not null,
  target_organization_id uuid references public.organizations (id) on delete set null,
  reason text not null check (length(btrim(reason)) between 3 and 500),
  executed_at timestamptz not null default now(),
  result text not null check (length(result) <= 200)
);

create table app_private.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_type public.audit_actor_type not null,
  actor_id uuid,
  organization_id uuid,
  project_id uuid,
  action text not null check (action ~ '^[a-z0-9_.]{3,80}$'),
  resource_type text check (resource_type is null or length(resource_type) <= 64),
  resource_id uuid,
  occurred_at timestamptz not null default now(),
  request_id uuid,
  metadata jsonb not null default '{}'::jsonb check (length(metadata::text) <= 4096),
  constraint audit_logs_coordinate_free_ck check (not app_private.jsonb_has_coordinate_keys(metadata))
);
create index audit_logs_project_idx on app_private.audit_logs (project_id, occurred_at);
