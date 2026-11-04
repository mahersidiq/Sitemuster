-- =============================================================================================
-- Milestone 12 — Security, privacy, resilience and operator tooling (docs/spec/09, 02, 05, 08;
-- decisions #123–#131).
--
-- 1. Legal notices: forward-only review with the human reviewer recorded, and a bilingual
--    production gate (EN and ES of the same version both APPROVED) for consent and for musters.
-- 2. Consent: the worker can switch location off per project (kiosk/foreman stay available) and
--    must accept a materially changed notice before location resumes.
-- 3. Account deletion: immediate revocation, identity removal after 24 h (≤ 30 days) unless a
--    legal hold applies, attendance kept only under a documented retention basis.
-- 4. Privacy maintenance every hour: raw fixes, rate-limit buckets, quarantine, deletions.
-- 5. Rate limits on invitations, push registration and muster starts.
-- 6. Platform operator RPCs (CLI only): MFA, a reason, rate-limited, every call audited; never
--    coordinates, emergency contacts or roster PII.
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- 1. Legal notices
-- ---------------------------------------------------------------------------------------------
alter table public.legal_notice_versions
  add column material_change boolean not null default true,
  add column reviewer_name text check (reviewer_name is null or length(btrim(reviewer_name)) between 2 and 200),
  add column reviewer_role text check (reviewer_role is null or length(btrim(reviewer_role)) between 2 and 200),
  add column review_reference text check (review_reference is null or length(btrim(review_reference)) between 2 and 500),
  add column retired_at timestamptz;
alter table public.legal_notice_versions
  add constraint legal_notice_reviewer_ck check (
    review_status <> 'APPROVED' or (reviewer_name is not null and reviewer_role is not null and approved_at is not null)),
  add constraint legal_notice_retired_ck check ((review_status = 'RETIRED') = (retired_at is not null));

-- Review moves forward only; an approval and its reviewer never change; a retired text is final.
create function app_private.legal_notice_review_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.review_status = 'RETIRED' then
    raise exception 'a retired legal notice never changes' using errcode = '42501';
  end if;
  if old.review_status = 'APPROVED' and new.review_status not in ('APPROVED', 'RETIRED') then
    raise exception 'an approved legal notice can only be retired' using errcode = '42501';
  end if;
  if old.review_status = 'APPROVED'
     and (new.reviewer_name is distinct from old.reviewer_name or new.reviewer_role is distinct from old.reviewer_role
          or new.review_reference is distinct from old.review_reference or new.approved_at is distinct from old.approved_at
          or new.approved_by is distinct from old.approved_by or new.material_change is distinct from old.material_change) then
    raise exception 'approval details never change' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger legal_notice_review_guard before update on public.legal_notice_versions
  for each row execute function app_private.legal_notice_review_guard();

-- The current text of a document for a project and language: project-specific first, newest.
create function app_private.current_legal_document(p_type public.legal_document_type, p_project uuid, p_locale public.locale_code)
returns public.legal_notice_versions
language sql
stable
security definer
set search_path = ''
as $$
  select n.* from public.legal_notice_versions n
   where n.locale = p_locale and n.document_type = p_type
     and (n.project_id is null or n.project_id = p_project)
     and n.review_status <> 'RETIRED'
   order by (n.project_id is not null) desc, n.version desc, n.created_at desc
   limit 1
$$;

-- Production needs BOTH languages of the SAME version approved (spec 08; TRANSLATION_REVIEW).
create function app_private.legal_pair_approved(p_type public.legal_document_type, p_project uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_en public.legal_notice_versions;
  v_es public.legal_notice_versions;
begin
  v_en := app_private.current_legal_document(p_type, p_project, 'en-US');
  v_es := app_private.current_legal_document(p_type, p_project, 'es-US');
  return v_en.id is not null and v_es.id is not null
     and v_en.review_status = 'APPROVED' and v_es.review_status = 'APPROVED'
     and v_en.version = v_es.version
     and v_en.project_id is not distinct from v_es.project_id;
end;
$$;

-- Fails closed (replaces the Milestone 05 version): in production the notice and its other
-- language must both be APPROVED before anyone can accept it.
create or replace function app_private.assert_notice_acceptable(p_project uuid, p_locale public.locale_code, p_notice_id uuid, p_accept boolean)
returns public.legal_notice_versions
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_notice public.legal_notice_versions;
begin
  v_notice := app_private.current_notice(p_project, p_locale);
  if v_notice.id is null then
    raise exception 'NOTICE_UNAVAILABLE' using errcode = '22023';
  end if;
  if v_notice.id is distinct from p_notice_id then
    raise exception 'NOTICE_OUTDATED' using errcode = '22023';
  end if;
  if not coalesce(p_accept, false) then
    raise exception 'CONSENT_REQUIRED' using errcode = '22023';
  end if;
  if app_private.deployment_environment() = 'production'
     and (v_notice.review_status <> 'APPROVED'
          or not app_private.legal_pair_approved('WORKER_LOCATION_DISCLOSURE', p_project)) then
    raise exception 'CONSENT_NOTICE_NOT_APPROVED' using errcode = '22023';
  end if;
  return v_notice;
end;
$$;

-- A production muster shows the safety limitations, so they must be approved in both languages.
create function app_private.muster_legal_gate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if app_private.deployment_environment() = 'production'
     and not app_private.legal_pair_approved('MUSTER_SAFETY_LIMITATIONS', new.project_id) then
    raise exception 'LEGAL_NOTICE_NOT_APPROVED' using errcode = '22023';
  end if;
  return new;
end;
$$;
create trigger muster_legal_gate before insert on public.muster_events
  for each row execute function app_private.muster_legal_gate();

-- Drafts (DRAFT_REQUIRES_HUMAN_REVIEW; docs/legal/drafts, hashes in TRANSLATION_REVIEW.md).
insert into public.legal_notice_versions (document_id, project_id, locale, document_type, version, content, content_hash) values
('MUSTER_SAFETY_LIMITATIONS_EN_V1', null, 'en-US', 'MUSTER_SAFETY_LIMITATIONS', 1, $notice$DRAFT — requires human legal and safety review before production use

Emergency muster: what SiteMuster does and does not do

SiteMuster helps the site team count people during an emergency or a drill. It is not a certified life-safety or evacuation system and it is not an emergency dispatch service.

- Always follow your site's emergency plan and call 911 when needed.
- An alert on your phone can be late, blocked or never arrive. Do not wait for it.
- Tapping I'M SAFE tells the site team that you say you are safe. It is not a physical check. Go to the assembly point so the safety team, your foreman or the kiosk can count you.
- Only a person who checks you at the assembly point marks you as seen there.
- The muster list is frozen when the muster starts. It can include people who are not on site, and the count can be incomplete.
- After the muster, a record is kept of who was seen, who said they were safe and who was not accounted for. It is kept as a safety record of the event.$notice$, repeat('0', 64)),
('MUSTER_SAFETY_LIMITATIONS_ES_V1', null, 'es-US', 'MUSTER_SAFETY_LIMITATIONS', 1, $notice$BORRADOR — requiere revisión legal y de seguridad por una persona antes de usarse en producción

Reunión de emergencia: lo que SiteMuster hace y no hace

SiteMuster ayuda al equipo de la obra a contar a las personas durante una emergencia o un simulacro. No es un sistema certificado de seguridad de vida ni de evacuación, ni un servicio de despacho de emergencias.

- Siga siempre el plan de emergencia de su obra y llame al 911 cuando sea necesario.
- Una alerta en su teléfono puede llegar tarde, bloquearse o no llegar nunca. No la espere.
- Tocar ESTOY A SALVO le dice al equipo de la obra que usted dice estar a salvo. No es una verificación en persona. Vaya al punto de reunión para que el equipo de seguridad, su capataz o el quiosco lo cuenten.
- Solo una persona que lo verifique en el punto de reunión lo marca como visto allí.
- La lista de la reunión se congela cuando empieza la reunión. Puede incluir personas que no están en la obra, y el conteo puede estar incompleto.
- Después de la reunión se guarda un registro de quién fue visto, quién dijo estar a salvo y quién quedó sin localizar. Se guarda como registro de seguridad del evento.$notice$, repeat('0', 64)),
('ACCOUNT_DELETION_RETENTION_EN_V1', null, 'en-US', 'ACCOUNT_DELETION_RETENTION', 1, $notice$DRAFT — requires human legal review before production use

Deleting your SiteMuster account

Right away:
- You are signed out on every phone.
- Your phone stops sending location and your badges stop working.
- You are removed from your projects and companies.

Within 30 days (normally within a day):
- Your name, phone number, email and emergency contact are removed.
- Your past attendance records are deleted, unless a contractor has a documented legal or contractual reason to keep time records. Then they are kept under a label like "Deleted worker #1a2b3c4d", without your name.

Exceptions:
- If a legal hold applies (for example an incident investigation), your records are kept, restricted, until the hold ends, and then removed.
- The record of an emergency muster that already took place is kept as a safety record.

Deleting your account cannot be undone. If you work on a site again, you will join as a new worker.

Questions: ask your superintendent or the project's safety manager.$notice$, repeat('0', 64)),
('ACCOUNT_DELETION_RETENTION_ES_V1', null, 'es-US', 'ACCOUNT_DELETION_RETENTION', 1, $notice$BORRADOR — requiere revisión legal por una persona antes de usarse en producción

Eliminar su cuenta de SiteMuster

De inmediato:
- Se cierra su sesión en todos los teléfonos.
- Su teléfono deja de enviar la ubicación y sus credenciales dejan de funcionar.
- Se le quita de sus proyectos y empresas.

En un plazo de 30 días (normalmente en un día):
- Se eliminan su nombre, número de teléfono, correo electrónico y contacto de emergencia.
- Sus registros de asistencia anteriores se eliminan, salvo que un contratista tenga un motivo legal o contractual documentado para conservar los registros de tiempo. En ese caso se conservan con una etiqueta como "Deleted worker #1a2b3c4d", sin su nombre.

Excepciones:
- Si aplica una retención legal (por ejemplo, la investigación de un incidente), sus registros se conservan, con acceso restringido, hasta que termine la retención, y después se eliminan.
- El registro de una reunión de emergencia que ya ocurrió se conserva como registro de seguridad.

Eliminar su cuenta no se puede deshacer. Si vuelve a trabajar en una obra, se unirá como trabajador nuevo.

Preguntas: consulte a su superintendente o al gerente de seguridad del proyecto.$notice$, repeat('0', 64));

-- Global texts the app shows (account deletion, muster limitations), in the person's language.
create function public.legal_document_text(p_document_type public.legal_document_type, p_locale public.locale_code)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_notice public.legal_notice_versions;
begin
  if auth.uid() is null or p_document_type not in ('ACCOUNT_DELETION_RETENTION', 'MUSTER_SAFETY_LIMITATIONS') then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  v_notice := app_private.current_legal_document(p_document_type, null, p_locale);
  if v_notice.id is null then
    raise exception 'NOTICE_UNAVAILABLE' using errcode = '22023';
  end if;
  return app_private.notice_json(v_notice);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 2. Consent: location off/on per project, renewal after a material notice change
-- ---------------------------------------------------------------------------------------------
-- `withdrawn_at` keeps meaning "this acknowledgement is no longer the active one" (replaced or the
-- account was deleted). Location is a separate, revocable permission on the active consent: the
-- notice acknowledgement stays, so kiosk and foreman attendance remain available (spec 09).
alter table public.tracking_consents
  add column location_withdrawn_at timestamptz,
  add column renewal_required_at timestamptz,
  add column withdrawal_reason text check (withdrawal_reason is null or withdrawal_reason in ('REPLACED', 'ACCOUNT_DELETED'));

create or replace function app_private.binding_eligible(p_enrollment uuid)
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
       -- Location needs the active consent, not switched off and covering the current notice.
       and exists (select 1 from public.tracking_consents c
                    where c.worker_id = e.worker_id and c.project_id = e.project_id and c.withdrawn_at is null
                      and c.location_withdrawn_at is null and c.renewal_required_at is null))
$$;

create trigger consent_location_binding_sync
  after update of location_withdrawn_at, renewal_required_at on public.tracking_consents
  for each row execute function app_private.sync_bindings_for_row();

-- The phone's tracking plan (replaces the Milestone 07 version): two new "not monitored" reasons.
create or replace function public.my_tracking_plan(p_app_version text default null)
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
                 when c.id is null then 'CONSENT_MISSING'
                 when c.renewal_required_at is not null then 'CONSENT_RENEWAL_REQUIRED'
                 when c.location_withdrawn_at is not null then 'LOCATION_WITHDRAWN'
                 when d.id is null then 'NO_DEVICE'
                 else 'NOT_BOUND' end)
             order by p.name, p.id)
        from public.worker_enrollments e
        join public.projects p on p.id = e.project_id
        left join lateral (select x.id, x.renewal_required_at, x.location_withdrawn_at from public.tracking_consents x
                            where x.worker_id = e.worker_id and x.project_id = e.project_id and x.withdrawn_at is null
                            limit 1) c on true
       where e.worker_id = v_worker and e.enrollment_status = 'APPROVED'
         and not exists (select 1 from public.device_project_bindings b
                          where b.device_id = d.id and b.project_id = e.project_id
                            and b.revoked_at is null and b.enabled)), '[]'::jsonb));
end;
$$;

-- The worker's consents per project, with the updated notice when it must be accepted again.
create function public.my_consents()
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
  if v_worker is null then
    raise exception 'WORKER_PROFILE_REQUIRED' using errcode = '22023';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'project_id', p.id, 'project_name', p.name,
             'consent_id', c.id, 'locale', c.locale, 'method', c.method, 'accepted_at', c.accepted_at,
             'notice_version_id', c.notice_version_id,
             'notice_version', (select n.version from public.legal_notice_versions n where n.id = c.notice_version_id),
             'location_enabled', c.location_withdrawn_at is null and c.renewal_required_at is null,
             'renewal_required', c.renewal_required_at is not null,
             'renewal_notice', case when c.renewal_required_at is not null
                                    then app_private.notice_json(app_private.current_notice(p.id, c.locale)) end)
           order by p.name, p.id)
      from public.tracking_consents c
      join public.projects p on p.id = c.project_id
     where c.worker_id = v_worker and c.withdrawn_at is null
       and exists (select 1 from public.worker_enrollments e
                    where e.worker_id = v_worker and e.project_id = c.project_id
                      and e.enrollment_status in ('PENDING', 'APPROVED'))), '[]'::jsonb);
end;
$$;

-- Location off/on for one project. Off is immediate (bindings follow by trigger); on needs the
-- current notice to be the accepted one (otherwise renew_my_consent).
create function public.set_my_location_consent(p_project_id uuid, p_enabled boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_worker uuid := app_private.current_worker_id();
  v_consent public.tracking_consents;
begin
  if v_worker is null then
    raise exception 'WORKER_PROFILE_REQUIRED' using errcode = '22023';
  end if;
  if p_enabled is null then
    raise exception 'INVALID_REQUEST' using errcode = '22023';
  end if;
  if not app_private.consume_rate_limit('consent_change', v_worker::text, 30, 3600) then
    raise exception 'RATE_LIMITED' using errcode = '22023';
  end if;
  select * into v_consent from public.tracking_consents
   where worker_id = v_worker and project_id = p_project_id and withdrawn_at is null
   for update;
  if v_consent.id is null then
    raise exception 'CONSENT_REQUIRED' using errcode = '22023';
  end if;
  if p_enabled then
    if v_consent.renewal_required_at is not null then
      raise exception 'CONSENT_RENEWAL_REQUIRED' using errcode = '22023';
    end if;
    update public.tracking_consents set location_withdrawn_at = null
     where id = v_consent.id and location_withdrawn_at is not null;
  else
    update public.tracking_consents set location_withdrawn_at = now()
     where id = v_consent.id and location_withdrawn_at is null;
  end if;
  if found then
    perform app_private.write_audit('USER', auth.uid(),
                                    case when p_enabled then 'consent.location_resumed' else 'consent.location_withdrawn' end,
                                    app_private.project_organization(p_project_id), p_project_id,
                                    'tracking_consent', v_consent.id, null, '{}'::jsonb);
  end if;
  return jsonb_build_object('project_id', p_project_id, 'location_enabled', p_enabled);
end;
$$;

-- Accept the current notice again (after a material change, or to resume after reading it).
create function public.renew_my_consent(p_project_id uuid, p_notice_id uuid, p_accept boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
set timezone = 'UTC'
as $$
declare
  v_worker uuid := app_private.current_worker_id();
  v_locale public.locale_code;
  v_notice public.legal_notice_versions;
  v_old public.tracking_consents;
  v_now timestamptz := now();
  v_id uuid;
begin
  if v_worker is null then
    raise exception 'WORKER_PROFILE_REQUIRED' using errcode = '22023';
  end if;
  if not app_private.consume_rate_limit('consent_change', v_worker::text, 30, 3600) then
    raise exception 'RATE_LIMITED' using errcode = '22023';
  end if;
  if not exists (select 1 from public.worker_enrollments
                  where worker_id = v_worker and project_id = p_project_id and enrollment_status in ('PENDING', 'APPROVED')) then
    raise exception 'NO_ENROLLMENTS' using errcode = '22023';
  end if;
  select locale into v_locale from public.legal_notice_versions where id = p_notice_id;
  if v_locale is null then
    raise exception 'NOTICE_UNAVAILABLE' using errcode = '22023';
  end if;
  v_notice := app_private.assert_notice_acceptable(p_project_id, v_locale, p_notice_id, p_accept);
  select * into v_old from public.tracking_consents
   where worker_id = v_worker and project_id = p_project_id and withdrawn_at is null
   for update;
  if v_old.id is not null and v_old.notice_version_id = v_notice.id and v_old.renewal_required_at is null then
    update public.tracking_consents set location_withdrawn_at = null where id = v_old.id;
    v_id := v_old.id;
  else
    if v_old.id is not null then
      update public.tracking_consents set withdrawn_at = v_now, withdrawal_reason = 'REPLACED' where id = v_old.id;
    end if;
    insert into public.tracking_consents (worker_id, project_id, notice_version_id, locale, method, accepted_at, evidence_digest)
    values (v_worker, p_project_id, v_notice.id, v_notice.locale, 'DIGITAL', v_now,
            encode(pg_catalog.sha256(convert_to(v_notice.content_hash || '|' || v_worker::text || '|' || p_project_id::text
                                                || '|' || v_now::text || '|DIGITAL', 'UTF8')), 'hex'))
    returning id into v_id;
  end if;
  perform app_private.write_audit('USER', auth.uid(), 'consent.renewed', app_private.project_organization(p_project_id),
                                  p_project_id, 'tracking_consent', v_id, null,
                                  jsonb_build_object('notice_version_id', v_notice.id));
  return jsonb_build_object('project_id', p_project_id, 'consent_id', v_id, 'notice_version_id', v_notice.id,
                            'location_enabled', true);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 3. Account deletion (spec 09, spec 05 "Data retention and deletion")
-- ---------------------------------------------------------------------------------------------
-- A documented reason to keep data: LEGAL_HOLD postpones identity removal; CONTRACT_RETENTION
-- keeps a deleted worker's attendance (pseudonymized) for that organization or project.
create table app_private.retention_holds (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  project_id uuid references public.projects (id) on delete cascade,
  kind text not null check (kind in ('LEGAL_HOLD', 'CONTRACT_RETENTION')),
  basis text not null check (length(btrim(basis)) between 3 and 500),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  released_at timestamptz,
  released_by uuid,
  constraint retention_holds_release_ck check ((released_at is null) = (released_by is null))
);
create index retention_holds_active_idx on app_private.retention_holds (organization_id, project_id) where released_at is null;
alter table app_private.retention_holds enable row level security;

create table app_private.account_deletion_requests (
  id uuid primary key default gen_random_uuid(),
  -- No foreign key: the auth user is deleted when the request is processed.
  auth_user_id uuid not null unique,
  worker_profile_id uuid references public.worker_profiles (id) on delete set null,
  requested_at timestamptz not null default now(),
  process_after timestamptz not null,
  processed_at timestamptz,
  status text not null default 'REQUESTED' check (status in ('REQUESTED', 'PROCESSED')),
  constraint account_deletion_window_ck check (process_after > requested_at and process_after <= requested_at + interval '30 days'),
  constraint account_deletion_processed_ck check ((status = 'PROCESSED') = (processed_at is not null))
);
alter table app_private.account_deletion_requests enable row level security;

-- Replaces the Milestone 02 helper: a person who asked to delete their account loses every
-- tenant read and write at once, even with an access token that has not expired yet.
create or replace function app_private.tenant_access_allowed()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null
     and not app_private.is_platform_operator()
     and not exists (select 1 from app_private.account_deletion_requests r where r.auth_user_id = auth.uid())
$$;

-- Called by the account-delete Edge Function after it checked a fresh sign-in (service role);
-- p_aal is the assurance level of that sign-in, taken from the verified access token.
create function public.edge_request_account_deletion(p_user uuid, p_aal text)
returns jsonb
language plpgsql
security definer
set search_path = ''
set timezone = 'UTC'
as $$
declare
  v_worker uuid;
  v_existing app_private.account_deletion_requests;
  v_request app_private.account_deletion_requests;
  v_now timestamptz := now();
begin
  if p_user is null or not exists (select 1 from auth.users u where u.id = p_user) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  select * into v_existing from app_private.account_deletion_requests where auth_user_id = p_user;
  if v_existing.id is not null then
    return jsonb_build_object('status', v_existing.status, 'requested_at', v_existing.requested_at,
                              'process_after', v_existing.process_after, 'duplicate', true);
  end if;
  -- Platform operators are removed by the platform owner, not through the app (spec 02).
  if exists (select 1 from app_private.platform_operators o where o.user_id = p_user and o.active) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  -- Someone with an authenticator must have used it in this sign-in: deleting is never a way
  -- around MFA.
  if exists (select 1 from auth.mfa_factors f where f.user_id = p_user and f.status = 'verified')
     and coalesce(p_aal, 'aal1') <> 'aal2' then
    raise exception 'MFA_REQUIRED' using errcode = '42501';
  end if;
  -- An organization always keeps an owner: the founding owner or the last OWNER transfers first.
  if exists (select 1 from public.organizations o where o.owner_user_id = p_user)
     or exists (select 1 from public.organization_members m
                 where m.user_id = p_user and m.role = 'OWNER' and m.membership_status = 'ACTIVE'
                   and not exists (select 1 from public.organization_members x
                                    where x.organization_id = m.organization_id and x.role = 'OWNER'
                                      and x.membership_status = 'ACTIVE' and x.user_id <> p_user)) then
    raise exception 'ORG_OWNER_TRANSFER_REQUIRED' using errcode = '22023';
  end if;
  if not app_private.consume_rate_limit('account_delete', p_user::text, 5, 86400) then
    raise exception 'RATE_LIMITED' using errcode = '22023';
  end if;
  select id into v_worker from public.worker_profiles where auth_user_id = p_user and deleted_at is null;
  insert into app_private.account_deletion_requests (auth_user_id, worker_profile_id, requested_at, process_after)
  values (p_user, v_worker, v_now, v_now + interval '24 hours')
  returning * into v_request;

  -- Immediately: the phone, badges, alerts, kiosks, memberships and consent stop working.
  if v_worker is not null then
    update app_private.device_upload_credentials set revoked_at = coalesce(revoked_at, v_now)
     where device_id in (select d.id from public.device_installations d where d.worker_id = v_worker);
    update app_private.device_badge_secrets set revoked_at = coalesce(revoked_at, v_now)
     where device_id in (select d.id from public.device_installations d where d.worker_id = v_worker);
    update public.device_installations set active = false, deactivated_at = coalesce(deactivated_at, v_now)
     where worker_id = v_worker and active;
    update public.worker_badges set active = false, revoked_at = coalesce(revoked_at, v_now)
     where worker_id = v_worker and active;
    update public.tracking_consents set withdrawn_at = v_now, withdrawal_reason = 'ACCOUNT_DELETED'
     where worker_id = v_worker and withdrawn_at is null;
    update public.worker_enrollments set enrollment_status = 'REVOKED', revoked_at = v_now, updated_at = v_now
     where worker_id = v_worker and enrollment_status in ('PENDING', 'APPROVED');
    -- REVOKED is what ends the membership; the end time is recorded when it can follow the start.
    update public.subcontractor_members
       set verification_status = 'REVOKED',
           valid_until = case when valid_until is null and valid_from < v_now then v_now else valid_until end,
           updated_at = v_now
     where worker_profile_id = v_worker and verification_status in ('PENDING', 'VERIFIED');
  end if;
  update app_private.push_tokens set revoked_at = v_now, updated_at = v_now
   where auth_user_id = p_user and revoked_at is null;
  update public.kiosk_devices set status = 'REVOKED', revoked_at = coalesce(revoked_at, v_now)
   where assigned_operator_user_id = p_user and status = 'ACTIVE';
  update public.project_staff set status = 'REVOKED', revoked_at = v_now, updated_at = v_now
   where user_id = p_user and status = 'ACTIVE';
  update public.organization_members set membership_status = 'REVOKED', revoked_at = v_now, updated_at = v_now
   where user_id = p_user and membership_status = 'ACTIVE';
  perform app_private.write_audit('USER', p_user, 'account.deletion_requested', null, null,
                                  'account_deletion_request', v_request.id, null, '{}'::jsonb);
  return jsonb_build_object('status', 'REQUESTED', 'requested_at', v_request.requested_at,
                            'process_after', v_request.process_after, 'duplicate', false);
end;
$$;

-- Identity removal for due requests (hourly job; p_now for tests). A LEGAL_HOLD on any of the
-- worker's projects or organizations postpones it. Attendance is deleted unless a
-- CONTRACT_RETENTION basis covers that project; kept attendance points at the pseudonymized
-- profile ("Deleted worker #xxxxxxxx"). Muster records stay as safety records.
create function app_private.process_account_deletions(p_now timestamptz default now())
returns integer
language plpgsql
security definer
set search_path = ''
set timezone = 'UTC'
as $$
declare
  r app_private.account_deletion_requests;
  p record;
  v_label text;
  v_done integer := 0;
begin
  for r in select * from app_private.account_deletion_requests
            where status = 'REQUESTED' and process_after <= p_now
            order by requested_at
            for update skip locked loop
    if r.worker_profile_id is not null and exists (
         select 1 from app_private.retention_holds h
          where h.released_at is null and h.kind = 'LEGAL_HOLD'
            and exists (select 1 from public.worker_enrollments e
                          join public.projects pr on pr.id = e.project_id
                         where e.worker_id = r.worker_profile_id
                           and (h.project_id = e.project_id or (h.project_id is null and h.organization_id = pr.organization_id)))) then
      continue;
    end if;
    if r.worker_profile_id is not null then
      v_label := 'Deleted worker #' || left(encode(pg_catalog.sha256(convert_to(r.worker_profile_id::text || '|' || r.id::text, 'UTF8')), 'hex'), 8);
      delete from public.presence_states where worker_id = r.worker_profile_id;
      delete from public.latest_onsite_positions where worker_id = r.worker_profile_id;
      delete from app_private.raw_onsite_fixes where worker_id = r.worker_profile_id;
      perform set_config('app.retention_purge', 'on', true);
      for p in select distinct e.project_id, pr.organization_id
                 from public.worker_enrollments e
                 join public.projects pr on pr.id = e.project_id
                where e.worker_id = r.worker_profile_id loop
        if not exists (select 1 from app_private.retention_holds h
                        where h.released_at is null and h.kind = 'CONTRACT_RETENTION'
                          and (h.project_id = p.project_id or (h.project_id is null and h.organization_id = p.organization_id))) then
          delete from public.attendance_events where worker_id = r.worker_profile_id and project_id = p.project_id;
          delete from public.attendance_corrections where worker_id = r.worker_profile_id and project_id = p.project_id;
          delete from public.attendance_sessions where worker_id = r.worker_profile_id and project_id = p.project_id;
          delete from app_private.location_event_receipts where worker_id = r.worker_profile_id and project_id = p.project_id;
        end if;
      end loop;
      perform set_config('app.retention_purge', 'off', true);
      delete from public.emergency_contacts where worker_profile_id = r.worker_profile_id;
      delete from app_private.device_badge_secrets
       where device_id in (select d.id from public.device_installations d where d.worker_id = r.worker_profile_id);
      update public.worker_profiles
         set legal_name = v_label, pseudonym_label = v_label, email = null, phone = null,
             auth_user_id = null, deleted_at = coalesce(deleted_at, p_now), updated_at = p_now
       where id = r.worker_profile_id;
    end if;
    delete from app_private.push_tokens where auth_user_id = r.auth_user_id;
    delete from auth.users where id = r.auth_user_id;
    update app_private.account_deletion_requests set status = 'PROCESSED', processed_at = p_now where id = r.id;
    perform app_private.write_audit('SYSTEM', null, 'account.deleted', null, null,
                                    'account_deletion_request', r.id, null, '{}'::jsonb);
    v_done := v_done + 1;
  end loop;
  return v_done;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 4. Privacy maintenance (hourly; every environment)
-- ---------------------------------------------------------------------------------------------
-- Raw fixes expire ≤ 24 h after receipt (decision #55): partitions are kept ready and expired ones
-- dropped. Rate-limit buckets older than two days and quarantine rows (coordinate-free) older than
-- 30 days are removed. Due account deletions are processed.
create function app_private.privacy_maintenance(p_now timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path = ''
set timezone = 'UTC'
as $$
declare
  v_fixes bigint;
  v_buckets integer;
  v_quarantine integer;
  v_deletions integer;
begin
  perform app_private.ensure_raw_fix_partitions((p_now at time zone 'UTC')::date, 3);
  v_fixes := app_private.purge_expired_raw_fixes(p_now);
  delete from app_private.rate_limit_buckets where window_start < p_now - interval '2 days';
  get diagnostics v_buckets = row_count;
  delete from app_private.location_ingest_quarantine where received_at < p_now - interval '30 days';
  get diagnostics v_quarantine = row_count;
  v_deletions := app_private.process_account_deletions(p_now);
  return jsonb_build_object('raw_fixes_purged', v_fixes, 'rate_limit_buckets_purged', v_buckets,
                            'quarantine_purged', v_quarantine, 'accounts_deleted', v_deletions);
end;
$$;

select cron.schedule('sitemuster-privacy-maintenance', '17 * * * *', 'select app_private.privacy_maintenance()');

-- ---------------------------------------------------------------------------------------------
-- 5. Rate limits on inserts made through the RPCs (spec 09: invites, …; per signed-in person)
-- ---------------------------------------------------------------------------------------------
create function app_private.rate_limit_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is not null
     and not app_private.consume_rate_limit(tg_argv[0], auth.uid()::text, tg_argv[1]::integer, tg_argv[2]::integer) then
    raise exception 'RATE_LIMITED' using errcode = '22023';
  end if;
  return new;
end;
$$;
create trigger invitations_rate_limit before insert on public.organization_invitations
  for each row execute function app_private.rate_limit_insert('invitation_hour', '30', '3600');
create trigger push_tokens_rate_limit before insert on app_private.push_tokens
  for each row execute function app_private.rate_limit_insert('push_token_hour', '20', '3600');
create trigger muster_start_rate_limit before insert on public.muster_events
  for each row execute function app_private.rate_limit_insert('muster_start_hour', '20', '3600');

-- ---------------------------------------------------------------------------------------------
-- 6. Platform operator RPCs (private CLI only; spec 02 column A, spec 09 "Platform operator")
-- ---------------------------------------------------------------------------------------------
-- Every call: an active operator, MFA (aal2), a reason, at most 60 calls a minute, and an
-- append-only platform_operator_actions row. Never coordinates, emergency contacts, roster names,
-- phone numbers or attendance.
create function app_private.assert_operator(p_reason text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or not app_private.is_platform_operator() or not app_private.is_aal2() then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 3 and 500 then
    raise exception 'REASON_REQUIRED' using errcode = '22023';
  end if;
  if not app_private.consume_rate_limit('operator_minute', v_uid::text, 60, 60) then
    raise exception 'RATE_LIMITED' using errcode = '22023';
  end if;
  return v_uid;
end;
$$;

create function app_private.record_operator_action(
  p_action public.platform_operator_action, p_organization uuid, p_reason text, p_result text
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into app_private.platform_operator_actions (platform_user_id, action, target_organization_id, reason, result)
  values (auth.uid(), p_action, p_organization, btrim(p_reason), left(coalesce(p_result, ''), 200))
$$;

-- Organization metadata and counts only (never people).
create function public.operator_org_lookup(p_query text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
set timezone = 'UTC'
as $$
declare
  v_rows jsonb;
begin
  perform app_private.assert_operator(p_reason);
  if p_query is null or length(btrim(p_query)) not between 2 and 100 then
    raise exception 'INVALID_REQUEST' using errcode = '22023';
  end if;
  select coalesce(jsonb_agg(x.row order by x.name), '[]'::jsonb) into v_rows
    from (select o.name, jsonb_build_object(
                   'organization_id', o.id, 'name', o.name, 'status', o.status, 'created_at', o.created_at,
                   'projects', (select count(*) from public.projects p where p.organization_id = o.id),
                   'active_projects', (select count(*) from public.projects p where p.organization_id = o.id and p.status = 'ACTIVE'),
                   'staff_members', (select count(*) from public.organization_members m
                                      where m.organization_id = o.id and m.membership_status = 'ACTIVE'),
                   'approved_workers', (select count(distinct e.worker_id) from public.worker_enrollments e
                                          join public.projects p on p.id = e.project_id
                                         where p.organization_id = o.id and e.enrollment_status = 'APPROVED')) as row
            from public.organizations o
           where o.name ilike '%' || replace(replace(btrim(p_query), '%', ''), '_', '') || '%'
              or o.id::text = btrim(p_query)
           order by o.name
           limit 20) x;
  perform app_private.record_operator_action('ORG_LOOKUP', null, p_reason, jsonb_array_length(v_rows) || ' matches');
  return v_rows;
end;
$$;

-- A lost or stolen phone: its upload and badge secrets stop working at once.
create function public.operator_revoke_device(p_device_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  d public.device_installations;
  v_org uuid;
begin
  perform app_private.assert_operator(p_reason);
  select * into d from public.device_installations where id = p_device_id for update;
  if d.id is null then
    raise exception 'NOT_FOUND' using errcode = '22023';
  end if;
  select pr.organization_id into v_org from public.worker_enrollments e join public.projects pr on pr.id = e.project_id
   where e.worker_id = d.worker_id order by e.created_at desc limit 1;
  update app_private.device_upload_credentials set revoked_at = coalesce(revoked_at, now()) where device_id = d.id;
  update app_private.device_badge_secrets set revoked_at = coalesce(revoked_at, now()) where device_id = d.id;
  update public.device_installations set active = false, deactivated_at = coalesce(deactivated_at, now())
   where id = d.id and active;
  perform app_private.record_operator_action('REVOKE_DEVICE_CREDENTIAL', v_org, p_reason,
                                             case when d.active then 'revoked' else 'already_inactive' end);
  perform app_private.write_audit('PLATFORM_OPERATOR', auth.uid(), 'device.revoked_by_operator', v_org, null,
                                  'device_installation', d.id, null, '{}'::jsonb);
  return jsonb_build_object('device_id', d.id, 'was_active', d.active);
end;
$$;

-- In-app invitations are not e-mailed: "resend" re-arms a pending one for 7 more days.
create function public.operator_resend_invitation(p_invitation_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
set timezone = 'UTC'
as $$
declare
  i public.organization_invitations;
begin
  perform app_private.assert_operator(p_reason);
  select * into i from public.organization_invitations where id = p_invitation_id for update;
  if i.id is null then
    raise exception 'NOT_FOUND' using errcode = '22023';
  end if;
  if i.used_at is not null or i.revoked_at is not null then
    raise exception 'INVITATION_NOT_ACTIVE' using errcode = '22023';
  end if;
  update public.organization_invitations set expires_at = greatest(expires_at, now()) + interval '7 days'
   where id = i.id returning * into i;
  perform app_private.record_operator_action('RESEND_INVITE', i.organization_id, p_reason, 'expires ' || i.expires_at::text);
  return jsonb_build_object('invitation_id', i.id, 'expires_at', i.expires_at);
end;
$$;

-- Non-sensitive health: counts, job runs and queue ages only.
create function public.operator_health(p_reason text)
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
  v_result := jsonb_build_object(
    'generated_at', now(),
    'environment', app_private.deployment_environment(),
    'organizations', (select count(*) from public.organizations),
    'active_projects', (select count(*) from public.projects where status = 'ACTIVE'),
    'approved_enrollments', (select count(*) from public.worker_enrollments where enrollment_status = 'APPROVED'),
    'active_devices', (select count(*) from public.device_installations where active),
    'location_receipts_last_hour', (
      select jsonb_build_object('accepted', count(*) filter (where terminal_result = 'accepted'),
                                'duplicate', count(*) filter (where terminal_result = 'duplicate'),
                                'rejected', count(*) filter (where terminal_result = 'rejected'))
        from app_private.location_event_receipts where server_received_at > now() - interval '1 hour'),
    'operations_last_hour', (
      select jsonb_build_object('accepted', count(*) filter (where terminal_status = 'accepted'),
                                'duplicate', count(*) filter (where terminal_status = 'duplicate'),
                                'rejected', count(*) filter (where terminal_status = 'rejected'))
        from app_private.operational_outbox_receipts where accepted_at > now() - interval '1 hour'),
    'quarantine_last_day', (select count(*) from app_private.location_ingest_quarantine where received_at > now() - interval '1 day'),
    'sessions', (select jsonb_build_object('open', count(*) filter (where status = 'OPEN'),
                                           'unresolved', count(*) filter (where status = 'UNRESOLVED'))
                   from public.attendance_sessions where status in ('OPEN', 'UNRESOLVED')),
    'active_musters', (select count(*) from public.muster_events where status = 'ACTIVE'),
    'reports_waiting', (select count(*) from public.daily_company_reports where status = 'PENDING_CONFIRMATION'),
    'account_deletions', (select jsonb_build_object('pending', count(*),
                                                     'oldest_requested_at', min(requested_at))
                            from app_private.account_deletion_requests where status = 'REQUESTED'),
    'jobs', coalesce((
      select jsonb_agg(jsonb_build_object('job', j.jobname, 'schedule', j.schedule, 'active', j.active,
                                          'last_status', d.status, 'last_end', d.end_time) order by j.jobname)
        from cron.job j
        left join lateral (select r.status, r.end_time from cron.job_run_details r
                            where r.jobid = j.jobid order by r.runid desc limit 1) d on true), '[]'::jsonb));
  perform app_private.record_operator_action('HEALTH_CHECK', null, p_reason, 'ok');
  return v_result;
end;
$$;

create function public.operator_list_legal_notices(p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
set timezone = 'UTC'
as $$
declare
  v_rows jsonb;
begin
  perform app_private.assert_operator(p_reason);
  select coalesce(jsonb_agg(jsonb_build_object(
           'notice_id', n.id, 'document_id', n.document_id, 'document_type', n.document_type,
           'project_id', n.project_id, 'locale', n.locale, 'version', n.version, 'review_status', n.review_status,
           'content_hash', n.content_hash, 'material_change', n.material_change, 'approved_at', n.approved_at,
           'reviewer_name', n.reviewer_name, 'reviewer_role', n.reviewer_role, 'retired_at', n.retired_at)
         order by n.document_type, n.project_id nulls first, n.version, n.locale), '[]'::jsonb) into v_rows
    from public.legal_notice_versions n;
  perform app_private.record_operator_action('LEGAL_NOTICE_LIST', null, p_reason, jsonb_array_length(v_rows) || ' notices');
  return v_rows;
end;
$$;

-- Records a human reviewer's approval of the EXACT text reviewed (the hash must match). A material
-- change asks everyone who accepted an older version of that notice to accept it again.
create function public.operator_approve_legal_notice(
  p_notice_id uuid, p_content_hash text, p_reviewer_name text, p_reviewer_role text,
  p_review_reference text, p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set timezone = 'UTC'
as $$
declare
  n public.legal_notice_versions;
  v_org uuid;
  v_renewals integer := 0;
begin
  perform app_private.assert_operator(p_reason);
  select * into n from public.legal_notice_versions where id = p_notice_id for update;
  if n.id is null then
    raise exception 'NOT_FOUND' using errcode = '22023';
  end if;
  if n.review_status not in ('DRAFT_REQUIRES_HUMAN_REVIEW', 'REVIEWED') then
    raise exception 'NOTICE_NOT_PENDING_REVIEW' using errcode = '22023';
  end if;
  if p_content_hash is null or lower(btrim(p_content_hash)) <> n.content_hash then
    raise exception 'CONTENT_HASH_MISMATCH' using errcode = '22023';
  end if;
  if p_reviewer_name is null or length(btrim(p_reviewer_name)) not between 2 and 200
     or p_reviewer_role is null or length(btrim(p_reviewer_role)) not between 2 and 200 then
    raise exception 'REVIEWER_REQUIRED' using errcode = '22023';
  end if;
  update public.legal_notice_versions
     set review_status = 'APPROVED', approved_by = auth.uid(), approved_at = now(), published_at = now(),
         reviewer_name = btrim(p_reviewer_name), reviewer_role = btrim(p_reviewer_role),
         review_reference = nullif(btrim(coalesce(p_review_reference, '')), '')
   where id = n.id
   returning * into n;
  if n.material_change and n.document_type in ('WORKER_LOCATION_DISCLOSURE', 'GC_CUSTOM_NOTICE') then
    update public.tracking_consents c set renewal_required_at = now()
      from public.legal_notice_versions o
     where c.notice_version_id = o.id and c.withdrawn_at is null and c.renewal_required_at is null
       and o.id <> n.id and o.document_type = n.document_type and o.locale = n.locale
       and (case when n.project_id is null then o.project_id is null and o.version < n.version
                 else c.project_id = n.project_id end);
    get diagnostics v_renewals = row_count;
  end if;
  v_org := case when n.project_id is null then null else app_private.project_organization(n.project_id) end;
  perform app_private.record_operator_action('LEGAL_NOTICE_APPROVE', v_org, p_reason,
                                             n.document_id || ' v' || n.version || ' ' || n.locale);
  return jsonb_build_object('notice_id', n.id, 'document_id', n.document_id, 'review_status', n.review_status,
                            'renewals_required', v_renewals);
end;
$$;

create function public.operator_retire_legal_notice(p_notice_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  n public.legal_notice_versions;
begin
  perform app_private.assert_operator(p_reason);
  update public.legal_notice_versions set review_status = 'RETIRED', retired_at = now()
   where id = p_notice_id and review_status <> 'RETIRED'
   returning * into n;
  if n.id is null then
    raise exception 'NOT_FOUND' using errcode = '22023';
  end if;
  perform app_private.record_operator_action('LEGAL_NOTICE_RETIRE',
                                             case when n.project_id is null then null else app_private.project_organization(n.project_id) end,
                                             p_reason, n.document_id || ' v' || n.version || ' ' || n.locale);
  return jsonb_build_object('notice_id', n.id, 'review_status', n.review_status);
end;
$$;

create function public.operator_set_retention_hold(
  p_organization_id uuid, p_project_id uuid, p_kind text, p_basis text, p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform app_private.assert_operator(p_reason);
  if p_kind is null or p_kind not in ('LEGAL_HOLD', 'CONTRACT_RETENTION') then
    raise exception 'INVALID_REQUEST' using errcode = '22023';
  end if;
  if not exists (select 1 from public.organizations o where o.id = p_organization_id)
     or (p_project_id is not null and not exists (select 1 from public.projects p
                                                   where p.id = p_project_id and p.organization_id = p_organization_id)) then
    raise exception 'NOT_FOUND' using errcode = '22023';
  end if;
  if p_basis is null or length(btrim(p_basis)) not between 3 and 500 then
    raise exception 'REASON_REQUIRED' using errcode = '22023';
  end if;
  insert into app_private.retention_holds (organization_id, project_id, kind, basis, created_by)
  values (p_organization_id, p_project_id, p_kind, btrim(p_basis), auth.uid())
  returning id into v_id;
  perform app_private.record_operator_action('RETENTION_HOLD_SET', p_organization_id, p_reason, p_kind);
  return jsonb_build_object('hold_id', v_id, 'kind', p_kind);
end;
$$;

create function public.operator_release_retention_hold(p_hold_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  h app_private.retention_holds;
begin
  perform app_private.assert_operator(p_reason);
  update app_private.retention_holds set released_at = now(), released_by = auth.uid()
   where id = p_hold_id and released_at is null
   returning * into h;
  if h.id is null then
    raise exception 'NOT_FOUND' using errcode = '22023';
  end if;
  perform app_private.record_operator_action('RETENTION_HOLD_RELEASE', h.organization_id, p_reason, h.kind);
  return jsonb_build_object('hold_id', h.id, 'released_at', h.released_at);
end;
$$;

-- A staff member lost their authenticator: after an out-of-band identity check, remove their
-- TOTP factors so they enroll again at the next sign-in (decision #60). Never another operator.
create function public.operator_reset_staff_mfa(p_user_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_removed integer;
begin
  perform app_private.assert_operator(p_reason);
  if p_user_id = auth.uid() or exists (select 1 from app_private.platform_operators o where o.user_id = p_user_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  select coalesce((select m.organization_id from public.organization_members m
                    where m.user_id = p_user_id and m.membership_status = 'ACTIVE' limit 1),
                  (select app_private.project_organization(s.project_id) from public.project_staff s
                    where s.user_id = p_user_id and s.status = 'ACTIVE' limit 1)) into v_org;
  if v_org is null then
    raise exception 'NOT_FOUND' using errcode = '22023';
  end if;
  delete from auth.mfa_factors where user_id = p_user_id;
  get diagnostics v_removed = row_count;
  perform app_private.record_operator_action('STAFF_MFA_RESET', v_org, p_reason, v_removed || ' factors');
  perform app_private.write_audit('PLATFORM_OPERATOR', auth.uid(), 'staff.mfa_reset', v_org, null,
                                  'auth_user', p_user_id, null, '{}'::jsonb);
  return jsonb_build_object('user_id', p_user_id, 'factors_removed', v_removed);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 7. Grants (deny by default; decision #57)
-- ---------------------------------------------------------------------------------------------
revoke all on table app_private.retention_holds, app_private.account_deletion_requests
  from public, anon, authenticated, service_role;

revoke all on function
  app_private.legal_notice_review_guard(), app_private.current_legal_document(public.legal_document_type, uuid, public.locale_code),
  app_private.legal_pair_approved(public.legal_document_type, uuid), app_private.muster_legal_gate(),
  app_private.process_account_deletions(timestamptz), app_private.privacy_maintenance(timestamptz),
  app_private.rate_limit_insert(), app_private.assert_operator(text),
  app_private.record_operator_action(public.platform_operator_action, uuid, text, text)
  from public, anon, authenticated, service_role;

revoke all on function
  public.legal_document_text(public.legal_document_type, public.locale_code), public.my_consents(),
  public.set_my_location_consent(uuid, boolean), public.renew_my_consent(uuid, uuid, boolean),
  public.edge_request_account_deletion(uuid, text),
  public.operator_org_lookup(text, text), public.operator_revoke_device(uuid, text),
  public.operator_resend_invitation(uuid, text), public.operator_health(text),
  public.operator_list_legal_notices(text),
  public.operator_approve_legal_notice(uuid, text, text, text, text, text),
  public.operator_retire_legal_notice(uuid, text),
  public.operator_set_retention_hold(uuid, uuid, text, text, text),
  public.operator_release_retention_hold(uuid, text),
  public.operator_reset_staff_mfa(uuid, text)
  from public, anon, authenticated, service_role;

grant execute on function public.edge_request_account_deletion(uuid, text) to service_role;

grant execute on function
  public.legal_document_text(public.legal_document_type, public.locale_code), public.my_consents(),
  public.set_my_location_consent(uuid, boolean), public.renew_my_consent(uuid, uuid, boolean),
  public.operator_org_lookup(text, text), public.operator_revoke_device(uuid, text),
  public.operator_resend_invitation(uuid, text), public.operator_health(text),
  public.operator_list_legal_notices(text),
  public.operator_approve_legal_notice(uuid, text, text, text, text, text),
  public.operator_retire_legal_notice(uuid, text),
  public.operator_set_retention_hold(uuid, uuid, text, text, text),
  public.operator_release_retention_hold(uuid, text),
  public.operator_reset_staff_mfa(uuid, text)
  to authenticated;
