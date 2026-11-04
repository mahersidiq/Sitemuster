-- Milestone 05: orientation sessions (rotating 60 s QR + printed static QR, 120 minutes), worker
-- join with disclosure acknowledgement → ORIENTATION_COMPLETED + PENDING enrollment (never
-- approval), bulk approval ≤ 100 and employer confirmation as separate staff actions, supervised
-- no-phone profiles, printed opaque badges, device activation for the offline worker badge.

-- ---------------------------------------------------------------------------------------------
-- Deployment environment (decision #70): an unmarked database is PRODUCTION (fail closed).
-- ---------------------------------------------------------------------------------------------
create table app_private.settings (
  key text primary key check (key in ('environment')),
  value text not null check (value in ('development', 'staging', 'production')),
  updated_at timestamptz not null default now()
);
alter table app_private.settings enable row level security;
revoke all on app_private.settings from anon, authenticated, service_role;

create function app_private.deployment_environment()
returns text
language sql
stable
security definer
set search_path = ''
as $$ select coalesce((select s.value from app_private.settings s where s.key = 'environment'), 'production') $$;

create function app_private.b64url(p_bytes bytea)
returns text
language sql
immutable
set search_path = ''
as $$ select rtrim(translate(encode(p_bytes, 'base64'), E'+/\n', '-_'), '=') $$;

-- ---------------------------------------------------------------------------------------------
-- Standard worker location disclosure drafts (docs/legal/drafts). DRAFT_REQUIRES_HUMAN_REVIEW:
-- production refuses acceptance until a human-approved version exists (TRANSLATION_REVIEW.md).
-- ---------------------------------------------------------------------------------------------
insert into public.legal_notice_versions (document_id, project_id, locale, document_type, version, content, content_hash)
values
  ('WORKER_LOCATION_DISCLOSURE_EN_V1', null, 'en-US', 'WORKER_LOCATION_DISCLOSURE', 1, $notice$DRAFT — REQUIRES HUMAN LEGAL REVIEW. NOT APPROVED FOR PRODUCTION USE.

SiteMuster jobsite location notice (version 1)

What this is for
This project uses SiteMuster to keep an ESTIMATED record of who is on the jobsite, to help supervisors plan the day, and to support emergency head counts. It is not a payroll record and does not prove that you were or were not on site.

What is collected
- Your name, employer, trade, phone number, language and one emergency contact.
- If you allow location on your phone: when your phone enters or leaves the jobsite circle, and approximate positions while you are INSIDE the jobsite circle. Each position shows its time and accuracy.
- Your phone watches the jobsite boundary on the phone itself. Locations outside the jobsite are not sent to SiteMuster and are not stored.
- Kiosk, foreman and supervisor entries (for example, badge scans and corrections), with who made them and when.

Who can see it
Supervisors assigned to this project (and your company's authorized representative for your own company's crew) can see your attendance. Only people with an emergency role for this project can see your emergency contact. SiteMuster staff cannot see your location or emergency contact.

How long it is kept
Raw positions are deleted no later than 24 hours after your attendance session closes. Attendance records are kept only as long as there is a documented legal or contractual reason (at most two years), then deleted or de-identified.

Your choices
- You can refuse location tracking. You can still work: check in at the kiosk, with your foreman, or with a supervisor.
- You can withdraw this permission at any time in the app. Location uploads stop.
- You can ask to see, correct or delete your information, and you can delete your account in the app.

Emergencies
SiteMuster helps with head counts during an emergency, but it is not certified life-safety equipment and not an emergency dispatch service. Always follow your site's emergency plan and call 911 when needed.

Questions
Ask your superintendent or the project's safety manager.$notice$, repeat('0', 64)),
  ('WORKER_LOCATION_DISCLOSURE_ES_V1', null, 'es-US', 'WORKER_LOCATION_DISCLOSURE', 1, $notice$BORRADOR — REQUIERE REVISIÓN LEGAL HUMANA. NO APROBADO PARA USO EN PRODUCCIÓN.

Aviso de ubicación en la obra de SiteMuster (versión 1)

Para qué sirve
Este proyecto usa SiteMuster para llevar un registro ESTIMADO de quién está en la obra, ayudar a los supervisores a planear el día y apoyar los conteos de personal en una emergencia. No es un registro de nómina y no prueba que usted estuvo o no estuvo en la obra.

Qué información se recopila
- Su nombre, empleador, oficio, número de teléfono, idioma y un contacto de emergencia.
- Si usted permite la ubicación en su teléfono: cuándo su teléfono entra o sale del círculo de la obra, y posiciones aproximadas mientras usted está DENTRO del círculo de la obra. Cada posición muestra su hora y su precisión.
- Su teléfono vigila el límite de la obra dentro del mismo teléfono. Las ubicaciones fuera de la obra no se envían a SiteMuster y no se guardan.
- Registros del quiosco, del capataz y de los supervisores (por ejemplo, escaneos de credencial y correcciones), con quién los hizo y cuándo.

Quién puede verla
Los supervisores asignados a este proyecto (y el representante autorizado de su empresa, solo para el personal de su propia empresa) pueden ver su asistencia. Solo las personas con una función de emergencia en este proyecto pueden ver su contacto de emergencia. El personal de SiteMuster no puede ver su ubicación ni su contacto de emergencia.

Cuánto tiempo se guarda
Las posiciones sin procesar se borran a más tardar 24 horas después de que se cierra su sesión de asistencia. Los registros de asistencia se guardan solo mientras exista una razón legal o contractual documentada (como máximo dos años) y después se borran o se anonimizan.

Sus opciones
- Usted puede rechazar el seguimiento de ubicación. Aun así puede trabajar: registre su entrada en el quiosco, con su capataz o con un supervisor.
- Usted puede retirar este permiso en cualquier momento en la app. Los envíos de ubicación se detienen.
- Usted puede pedir ver, corregir o borrar su información, y puede borrar su cuenta en la app.

Emergencias
SiteMuster ayuda con los conteos de personal durante una emergencia, pero no es un equipo certificado de seguridad humana ni un servicio de despacho de emergencias. Siga siempre el plan de emergencia de su obra y llame al 911 cuando sea necesario.

Preguntas
Pregunte a su superintendente o al gerente de seguridad del proyecto.$notice$, repeat('0', 64));

-- Current disclosure for a project and language (project-specific version first, newest first).
create function app_private.current_notice(p_project uuid, p_locale public.locale_code)
returns public.legal_notice_versions
language sql
stable
security definer
set search_path = ''
as $$
  select n.* from public.legal_notice_versions n
   where n.locale = p_locale
     and n.document_type = 'WORKER_LOCATION_DISCLOSURE'
     and (n.project_id is null or n.project_id = p_project)
     and n.review_status <> 'RETIRED'
   order by (n.project_id is not null) desc, n.version desc, n.created_at desc
   limit 1
$$;

create function app_private.notice_json(p_notice public.legal_notice_versions)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object('id', p_notice.id, 'document_id', p_notice.document_id, 'version', p_notice.version,
                            'locale', p_notice.locale, 'review_status', p_notice.review_status,
                            'content', p_notice.content, 'content_hash', p_notice.content_hash)
$$;

-- Fails closed: production accepts only APPROVED notices (CONSENT_NOTICE_NOT_APPROVED).
create function app_private.assert_notice_acceptable(p_project uuid, p_locale public.locale_code, p_notice_id uuid, p_accept boolean)
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
  if app_private.deployment_environment() = 'production' and v_notice.review_status <> 'APPROVED' then
    raise exception 'CONSENT_NOTICE_NOT_APPROVED' using errcode = '22023';
  end if;
  return v_notice;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Staff capabilities (decision #69): orientation/approval = org OWNER or assigned PM/SUPER/SAFETY;
-- supervised onboarding and printed badges additionally allow the assigned kiosk ATTENDANT.
-- ---------------------------------------------------------------------------------------------
create function app_private.can_run_orientation(p_project uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app_private.is_aal2() and (
    app_private.is_org_owner(app_private.project_organization(p_project))
    or app_private.has_project_role(p_project, array['PM', 'SUPER', 'SAFETY']::public.project_staff_role[])
  )
$$;

-- ---------------------------------------------------------------------------------------------
-- Orientation sessions
-- ---------------------------------------------------------------------------------------------
alter table public.orientation_sessions add column idempotency_key uuid;
create unique index orientation_sessions_idempotency_uq on public.orientation_sessions (project_id, idempotency_key)
  where idempotency_key is not null;

-- Session-scoped secrets live only while the session is open (purged on close/expiry).
create table app_private.orientation_session_secrets (
  session_id uuid primary key references public.orientation_sessions (id) on delete cascade,
  rotating_secret bytea not null check (length(rotating_secret) = 32),
  static_code text not null check (static_code ~ '^[A-Za-z0-9_-]{43}$'),
  created_at timestamptz not null default now()
);
alter table app_private.orientation_session_secrets enable row level security;
revoke all on app_private.orientation_session_secrets from anon, authenticated, service_role;

create function app_private.session_is_open(p_session public.orientation_sessions)
returns boolean
language sql
stable
set search_path = ''
as $$ select p_session.status = 'OPEN' and p_session.revoked_at is null and p_session.expires_at > now() $$;

create function app_private.session_json(p_session_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('session_id', s.id, 'project_id', s.project_id, 'starts_at', s.starts_at,
                            'expires_at', s.expires_at,
                            'rotating_secret', app_private.b64url(k.rotating_secret),
                            'static_code', k.static_code)
    from public.orientation_sessions s
    join app_private.orientation_session_secrets k on k.session_id = s.id
   where s.id = p_session_id
$$;

create function app_private.close_session_internal(p_session_id uuid, p_status public.orientation_session_status)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.orientation_sessions set status = p_status, closed_at = coalesce(closed_at, now())
   where id = p_session_id and status = 'OPEN';
  delete from app_private.orientation_session_secrets where session_id = p_session_id;
$$;

create function public.start_orientation_session(p_project_id uuid, p_idempotency_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_session public.orientation_sessions;
  v_static text;
  v_old uuid;
begin
  if v_uid is null or not app_private.can_run_orientation(p_project_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_idempotency_key is null then
    raise exception 'IDEMPOTENCY_KEY_REQUIRED' using errcode = '22023';
  end if;
  select * into v_session from public.orientation_sessions
   where project_id = p_project_id and idempotency_key = p_idempotency_key;
  if v_session.id is not null then
    if not app_private.session_is_open(v_session) then
      raise exception 'ORIENTATION_SESSION_CLOSED' using errcode = '22023';
    end if;
    return app_private.session_json(v_session.id);
  end if;
  if (select status from public.projects where id = p_project_id) <> 'ACTIVE' then
    raise exception 'PROJECT_NOT_ACTIVE' using errcode = '22023';
  end if;
  -- One open session per project: starting a new one closes the previous one.
  for v_old in select id from public.orientation_sessions where project_id = p_project_id and status = 'OPEN' loop
    perform app_private.close_session_internal(v_old, 'CLOSED');
  end loop;

  v_static := app_private.b64url(extensions.gen_random_bytes(32));
  insert into public.orientation_sessions (project_id, started_by, starts_at, expires_at, static_code_hash, idempotency_key)
  values (p_project_id, v_uid, now(), now() + interval '120 minutes',
          pg_catalog.sha256(convert_to(v_static, 'UTF8')), p_idempotency_key)
  returning * into v_session;
  update public.orientation_sessions set rotating_secret_id = v_session.id where id = v_session.id;
  insert into app_private.orientation_session_secrets (session_id, rotating_secret, static_code)
  values (v_session.id, extensions.gen_random_bytes(32), v_static);

  perform app_private.write_audit('USER', v_uid, 'orientation.session_started', app_private.project_organization(p_project_id),
                                  p_project_id, 'orientation_session', v_session.id, null,
                                  jsonb_build_object('expires_at', v_session.expires_at));
  return app_private.session_json(v_session.id);
end;
$$;

-- Re-display an open session on the supervisor phone (e.g. after an app restart).
create function public.get_orientation_session(p_session_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_session public.orientation_sessions;
begin
  select * into v_session from public.orientation_sessions where id = p_session_id;
  if v_session.id is null or not app_private.can_run_orientation(v_session.project_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if not app_private.session_is_open(v_session) then
    raise exception 'ORIENTATION_SESSION_CLOSED' using errcode = '22023';
  end if;
  return app_private.session_json(p_session_id);
end;
$$;

create function public.close_orientation_session(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_project uuid;
begin
  select project_id into v_project from public.orientation_sessions where id = p_session_id;
  if v_uid is null or v_project is null or not app_private.can_run_orientation(v_project) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  perform app_private.close_session_internal(p_session_id, 'CLOSED');
  perform app_private.write_audit('USER', v_uid, 'orientation.session_closed', app_private.project_organization(v_project),
                                  v_project, 'orientation_session', p_session_id, null, '{}'::jsonb);
end;
$$;

create function public.list_orientation_sessions(p_project_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not app_private.can_run_orientation(p_project_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'session_id', s.id, 'starts_at', s.starts_at, 'expires_at', s.expires_at,
             'open', app_private.session_is_open(s),
             'completed_count', (select count(*) from public.orientation_records r where r.session_id = s.id))
           order by s.starts_at desc)
      from (select * from public.orientation_sessions where project_id = p_project_id
             order by starts_at desc limit 20) s
  ), '[]'::jsonb);
end;
$$;

-- Validates a scanned code. Failures are RETURNED (not raised) so that the attempt still counts
-- against the caller's rate limit: a raised error would roll back the counter (decision #72).
create function app_private.orientation_code_session(p_code text, out o_session_id uuid, out o_error text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_parts text[];
  v_session public.orientation_sessions;
  v_secret bytea;
  v_step bigint;
  v_now_step bigint := floor(extract(epoch from now()) / 60)::bigint;
  v_kind text;
begin
  if p_code ~ '^SMO1\.[0-9a-f-]{36}\.[0-9]{1,12}\.[A-Za-z0-9_-]{22}$' then
    v_kind := 'ROTATING';
  elsif p_code ~ '^SMS1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$' then
    v_kind := 'STATIC';
  else
    o_error := 'ORIENTATION_CODE_INVALID';
    return;
  end if;
  v_parts := string_to_array(p_code, '.');
  begin
    select * into v_session from public.orientation_sessions where id = v_parts[2]::uuid;
  exception when invalid_text_representation then
    o_error := 'ORIENTATION_CODE_INVALID';
    return;
  end;
  if v_session.id is null then
    o_error := 'ORIENTATION_CODE_INVALID';
    return;
  end if;
  if not app_private.session_is_open(v_session) then
    o_error := 'ORIENTATION_SESSION_CLOSED';
    return;
  end if;
  if v_kind = 'ROTATING' then
    v_step := v_parts[3]::bigint;
    if abs(v_step - v_now_step) > 1 then
      o_error := 'ORIENTATION_CODE_EXPIRED';
      return;
    end if;
    select rotating_secret into v_secret from app_private.orientation_session_secrets where session_id = v_session.id;
    if v_secret is null or left(app_private.b64url(extensions.hmac(
         convert_to('SMO1|' || v_session.id::text || '|' || v_step::text, 'UTF8'), v_secret, 'sha256')), 22) <> v_parts[4] then
      o_error := 'ORIENTATION_CODE_INVALID';
      return;
    end if;
  elsif v_session.static_code_hash is distinct from pg_catalog.sha256(convert_to(v_parts[3], 'UTF8')) then
    o_error := 'ORIENTATION_CODE_INVALID';
    return;
  end if;
  if (select status from public.projects where id = v_session.project_id) <> 'ACTIVE' then
    o_error := 'PROJECT_NOT_ACTIVE';
    return;
  end if;
  o_session_id := v_session.id;
end;
$$;

-- Company chosen at join: an existing company on the project, or a new name (PENDING; GC
-- verification is separate and never self-granted).
create function app_private.resolve_join_company(p_project uuid, p_company_id uuid, p_company_name text, p_actor uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid;
  v_name text := btrim(coalesce(p_company_name, ''));
begin
  if p_company_id is not null then
    select ps.subcontractor_id into v_company from public.project_subcontractors ps
     where ps.project_id = p_project and ps.subcontractor_id = p_company_id and ps.status <> 'REMOVED';
    if v_company is null then
      raise exception 'COMPANY_NOT_ON_PROJECT' using errcode = '22023';
    end if;
    return v_company;
  end if;
  if length(v_name) not between 1 and 200 then
    raise exception 'COMPANY_REQUIRED' using errcode = '22023';
  end if;
  select c.id into v_company
    from public.project_subcontractors ps
    join public.subcontractor_companies c on c.id = ps.subcontractor_id
   where ps.project_id = p_project and ps.status <> 'REMOVED' and lower(c.canonical_name) = lower(v_name)
   limit 1;
  if v_company is not null then
    return v_company;
  end if;
  insert into public.subcontractor_companies (canonical_name, created_by) values (v_name, p_actor) returning id into v_company;
  insert into public.project_subcontractors (project_id, subcontractor_id) values (p_project, v_company);
  return v_company;
end;
$$;

create function app_private.assert_worker_details(p_legal_name text, p_trade text, p_emergency_name text, p_emergency_phone text, p_emergency_relationship text)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if length(btrim(coalesce(p_legal_name, ''))) not between 1 and 200 then
    raise exception 'NAME_REQUIRED' using errcode = '22023';
  end if;
  if length(coalesce(p_trade, '')) > 100 then
    raise exception 'TRADE_TOO_LONG' using errcode = '22023';
  end if;
  if length(btrim(coalesce(p_emergency_name, ''))) not between 1 and 200
     or length(btrim(coalesce(p_emergency_phone, ''))) not between 7 and 32
     or length(coalesce(p_emergency_relationship, '')) > 64 then
    raise exception 'EMERGENCY_CONTACT_REQUIRED' using errcode = '22023';
  end if;
end;
$$;

-- Shared tail of digital join and supervised onboarding.
create function app_private.record_orientation(
  p_project uuid, p_worker uuid, p_session uuid, p_operator uuid, p_company uuid, p_trade text,
  p_notice public.legal_notice_versions, p_method public.consent_method
)
returns public.worker_enrollments
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_enrollment public.worker_enrollments;
  v_consent public.tracking_consents;
  v_now timestamptz := now();
begin
  insert into public.subcontractor_members (company_id, worker_profile_id, role, trade, authorized_by)
  values (p_company, p_worker, 'WORKER', nullif(btrim(coalesce(p_trade, '')), ''), p_operator)
  on conflict (company_id, worker_profile_id, role) where verification_status in ('PENDING', 'VERIFIED') do nothing;

  insert into public.orientation_records (worker_profile_id, project_id, session_id, completed_at, operator_id, notice_version_id)
  values (p_worker, p_project, p_session, v_now, p_operator, p_notice.id);

  select * into v_consent from public.tracking_consents
   where worker_id = p_worker and project_id = p_project and withdrawn_at is null;
  if v_consent.id is null or v_consent.notice_version_id <> p_notice.id then
    if v_consent.id is not null then
      update public.tracking_consents set withdrawn_at = v_now where id = v_consent.id;
    end if;
    insert into public.tracking_consents (worker_id, project_id, notice_version_id, locale, method, accepted_at, reviewing_actor, evidence_digest)
    values (p_worker, p_project, p_notice.id, p_notice.locale, p_method, v_now, p_operator,
            encode(pg_catalog.sha256(convert_to(p_notice.content_hash || '|' || p_worker::text || '|' || p_project::text
                                                || '|' || v_now::text || '|' || p_method::text, 'UTF8')), 'hex'));
  end if;

  select * into v_enrollment from public.worker_enrollments
   where project_id = p_project and worker_id = p_worker and enrollment_status in ('PENDING', 'APPROVED')
   for update;
  if v_enrollment.id is null then
    insert into public.worker_enrollments (project_id, worker_id, subcontractor_id, trade)
    values (p_project, p_worker, p_company, nullif(btrim(coalesce(p_trade, '')), ''))
    returning * into v_enrollment;
  elsif v_enrollment.subcontractor_id is distinct from p_company or v_enrollment.trade is distinct from nullif(btrim(coalesce(p_trade, '')), '') then
    -- A changed employer claim must be confirmed again (never carried over).
    update public.worker_enrollments
       set subcontractor_id = p_company, trade = nullif(btrim(coalesce(p_trade, '')), ''),
           employer_status = case when subcontractor_id is distinct from p_company then 'PENDING_CONFIRMATION' else employer_status end,
           employer_confirmed_by = case when subcontractor_id is distinct from p_company then null else employer_confirmed_by end,
           employer_confirmed_at = case when subcontractor_id is distinct from p_company then null else employer_confirmed_at end,
           updated_at = v_now
     where id = v_enrollment.id
     returning * into v_enrollment;
  end if;
  return v_enrollment;
end;
$$;

create function app_private.replace_emergency_contact(p_worker uuid, p_name text, p_phone text, p_relationship text)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.emergency_contacts where worker_profile_id = p_worker;
  insert into public.emergency_contacts (worker_profile_id, name, phone, relationship)
  values (p_worker, btrim(p_name), btrim(p_phone), nullif(btrim(coalesce(p_relationship, '')), ''));
$$;

-- Worker scans a code: what project is this, what must I read and accept?
create function public.preview_orientation(p_code text, p_locale public.locale_code)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_check record;
  v_session public.orientation_sessions;
  v_notice public.legal_notice_versions;
  v_worker uuid;
begin
  if v_uid is null or not app_private.tenant_access_allowed() then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if not app_private.consume_rate_limit('orientation_join', v_uid::text, 30, 60) then
    return jsonb_build_object('error', 'RATE_LIMITED');
  end if;
  select * into v_check from app_private.orientation_code_session(p_code);
  if v_check.o_error is not null then
    return jsonb_build_object('error', v_check.o_error);
  end if;
  select * into v_session from public.orientation_sessions where id = v_check.o_session_id;
  v_notice := app_private.current_notice(v_session.project_id, p_locale);
  if v_notice.id is null then
    raise exception 'NOTICE_UNAVAILABLE' using errcode = '22023';
  end if;
  v_worker := app_private.current_worker_id();
  return jsonb_build_object(
    'session_id', v_session.id,
    'project_id', v_session.project_id,
    'project_name', (select name from public.projects where id = v_session.project_id),
    'organization_name', (select o.name from public.organizations o join public.projects p on p.organization_id = o.id
                           where p.id = v_session.project_id),
    'session_expires_at', v_session.expires_at,
    'notice', app_private.notice_json(v_notice),
    'notice_acceptable', app_private.deployment_environment() <> 'production' or v_notice.review_status = 'APPROVED',
    'companies', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.canonical_name) order by c.canonical_name)
                             from public.project_subcontractors ps
                             join public.subcontractor_companies c on c.id = ps.subcontractor_id
                            where ps.project_id = v_session.project_id and ps.status <> 'REMOVED'), '[]'::jsonb),
    'profile', (select jsonb_build_object('legal_name', w.legal_name, 'primary_language', w.primary_language)
                  from public.worker_profiles w where w.id = v_worker),
    'existing_enrollment', (select jsonb_build_object('enrollment_status', e.enrollment_status, 'employer_status', e.employer_status)
                              from public.worker_enrollments e
                             where e.project_id = v_session.project_id and e.worker_id = v_worker
                               and e.enrollment_status in ('PENDING', 'APPROVED'))
  );
end;
$$;

-- Worker completes orientation: ORIENTATION_COMPLETED + acknowledgement + PENDING enrollment.
create function public.complete_orientation(
  p_code text,
  p_locale public.locale_code,
  p_legal_name text,
  p_company_id uuid,
  p_company_name text,
  p_trade text,
  p_emergency_name text,
  p_emergency_phone text,
  p_emergency_relationship text,
  p_notice_version_id uuid,
  p_accept boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_check record;
  v_session public.orientation_sessions;
  v_notice public.legal_notice_versions;
  v_worker uuid;
  v_company uuid;
  v_enrollment public.worker_enrollments;
  v_phone text;
begin
  if v_uid is null or not app_private.tenant_access_allowed() then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if not app_private.consume_rate_limit('orientation_join', v_uid::text, 30, 60) then
    return jsonb_build_object('error', 'RATE_LIMITED');
  end if;
  select * into v_check from app_private.orientation_code_session(p_code);
  if v_check.o_error is not null then
    return jsonb_build_object('error', v_check.o_error);
  end if;
  select * into v_session from public.orientation_sessions where id = v_check.o_session_id;
  perform app_private.assert_worker_details(p_legal_name, p_trade, p_emergency_name, p_emergency_phone, p_emergency_relationship);
  v_notice := app_private.assert_notice_acceptable(v_session.project_id, p_locale, p_notice_version_id, p_accept);

  v_worker := app_private.current_worker_id();
  if v_worker is null then
    select case when u.phone is null or u.phone = '' then null else '+' || ltrim(u.phone, '+') end
      into v_phone from auth.users u where u.id = v_uid;
    insert into public.worker_profiles (auth_user_id, legal_name, phone, primary_language, created_by)
    values (v_uid, btrim(p_legal_name), v_phone, p_locale, v_uid)
    returning id into v_worker;
  else
    update public.worker_profiles set legal_name = btrim(p_legal_name), primary_language = p_locale, updated_at = now()
     where id = v_worker;
  end if;
  perform app_private.replace_emergency_contact(v_worker, p_emergency_name, p_emergency_phone, p_emergency_relationship);
  v_company := app_private.resolve_join_company(v_session.project_id, p_company_id, p_company_name, v_uid);
  v_enrollment := app_private.record_orientation(v_session.project_id, v_worker, v_session.id, null, v_company, p_trade,
                                                 v_notice, 'DIGITAL');

  perform app_private.write_audit('USER', v_uid, 'orientation.completed', app_private.project_organization(v_session.project_id),
                                  v_session.project_id, 'worker_enrollment', v_enrollment.id, null,
                                  jsonb_build_object('notice_version_id', v_notice.id, 'method', 'DIGITAL'));
  return jsonb_build_object('enrollment_id', v_enrollment.id, 'project_id', v_session.project_id,
                            'enrollment_status', v_enrollment.enrollment_status,
                            'employer_status', v_enrollment.employer_status);
end;
$$;

create function public.my_enrollments()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'enrollment_id', e.id, 'project_id', e.project_id, 'project_name', p.name,
           'organization_name', o.name, 'project_status', p.status, 'iana_timezone', p.iana_timezone,
           'enrollment_status', e.enrollment_status, 'employer_status', e.employer_status,
           'company_name', c.canonical_name, 'trade', e.trade,
           'orientation_completed_at', (select max(r.completed_at) from public.orientation_records r
                                         where r.worker_profile_id = e.worker_id and r.project_id = e.project_id))
         order by e.created_at desc), '[]'::jsonb)
    from public.worker_enrollments e
    join public.projects p on p.id = e.project_id
    join public.organizations o on o.id = p.organization_id
    left join public.subcontractor_companies c on c.id = e.subcontractor_id
   where e.worker_id = app_private.current_worker_id()
$$;

create function public.get_my_emergency_contact()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('name', c.name, 'phone', c.phone, 'relationship', c.relationship)
    from public.emergency_contacts c
   where c.worker_profile_id = app_private.current_worker_id()
   order by c.created_at desc
   limit 1
$$;

create function public.update_my_emergency_contact(p_name text, p_phone text, p_relationship text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_worker uuid := app_private.current_worker_id();
begin
  if v_worker is null then
    raise exception 'WORKER_PROFILE_REQUIRED' using errcode = '22023';
  end if;
  perform app_private.assert_worker_details('x', null, p_name, p_phone, p_relationship);
  perform app_private.replace_emergency_contact(v_worker, p_name, p_phone, p_relationship);
  perform app_private.write_audit('USER', auth.uid(), 'worker.emergency_contact_updated', null, null,
                                  'worker_profile', v_worker, null, '{}'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Staff review: list, bulk approve ≤ 100, employer confirmation, reject/revoke
-- ---------------------------------------------------------------------------------------------
create function public.list_project_enrollments(p_project_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not app_private.can_view_roster(p_project_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  -- Roster fields only: no phone numbers, e-mails or emergency contacts.
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'enrollment_id', e.id, 'worker_id', w.id, 'legal_name', coalesce(w.pseudonym_label, w.legal_name),
             'managed_identity', w.managed_identity, 'company_id', e.subcontractor_id,
             'company_name', c.canonical_name, 'trade', e.trade,
             'enrollment_status', e.enrollment_status, 'employer_status', e.employer_status,
             'orientation_completed_at', (select max(r.completed_at) from public.orientation_records r
                                           where r.worker_profile_id = w.id and r.project_id = e.project_id),
             'consent_method', (select t.method from public.tracking_consents t
                                 where t.worker_id = w.id and t.project_id = e.project_id and t.withdrawn_at is null),
             'printed_badge_active', exists (select 1 from public.worker_badges b
                                              where b.worker_id = w.id and b.badge_kind = 'PRINTED' and b.active),
             'created_at', e.created_at)
           order by case e.enrollment_status when 'PENDING' then 0 when 'APPROVED' then 1 else 2 end, e.created_at)
      from public.worker_enrollments e
      join public.worker_profiles w on w.id = e.worker_id
      left join public.subcontractor_companies c on c.id = e.subcontractor_id
     where e.project_id = p_project_id
  ), '[]'::jsonb);
end;
$$;

create function public.bulk_approve_enrollments(p_project_id uuid, p_enrollment_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_id uuid;
  v_row public.worker_enrollments;
  v_result text;
  v_results jsonb := '[]'::jsonb;
begin
  if v_uid is null or not app_private.can_run_orientation(p_project_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if coalesce(cardinality(p_enrollment_ids), 0) = 0 then
    raise exception 'NO_ENROLLMENTS' using errcode = '22023';
  end if;
  if cardinality(p_enrollment_ids) > 100 then
    raise exception 'TOO_MANY_ENROLLMENTS' using errcode = '22023';
  end if;
  for v_id in select distinct on (u.id) u.id from unnest(p_enrollment_ids) with ordinality as u(id, n) order by u.id, u.n loop
    select * into v_row from public.worker_enrollments where id = v_id and project_id = p_project_id for update;
    if v_row.id is null then
      v_result := 'NOT_FOUND';
    elsif v_row.enrollment_status = 'APPROVED' then
      v_result := 'ALREADY_APPROVED';
    elsif v_row.enrollment_status <> 'PENDING' then
      v_result := 'NOT_PENDING';
    elsif not exists (select 1 from public.orientation_records r
                       where r.worker_profile_id = v_row.worker_id and r.project_id = p_project_id) then
      v_result := 'ORIENTATION_MISSING';
    else
      update public.worker_enrollments
         set enrollment_status = 'APPROVED', approved_by = v_uid, approval_at = now(), updated_at = now()
       where id = v_id;
      perform app_private.write_audit('USER', v_uid, 'enrollment.approved', app_private.project_organization(p_project_id),
                                      p_project_id, 'worker_enrollment', v_id, null, '{}'::jsonb);
      v_result := 'APPROVED';
    end if;
    v_results := v_results || jsonb_build_object('enrollment_id', v_id, 'result', v_result);
    v_row := null;
  end loop;
  return v_results;
end;
$$;

create function public.bulk_confirm_employer(p_project_id uuid, p_enrollment_ids uuid[], p_decision public.employer_status)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_id uuid;
  v_row public.worker_enrollments;
  v_result text;
  v_results jsonb := '[]'::jsonb;
begin
  if v_uid is null or not app_private.can_run_orientation(p_project_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_decision not in ('VERIFIED', 'REJECTED') then
    raise exception 'INVALID_DECISION' using errcode = '22023';
  end if;
  if coalesce(cardinality(p_enrollment_ids), 0) = 0 then
    raise exception 'NO_ENROLLMENTS' using errcode = '22023';
  end if;
  if cardinality(p_enrollment_ids) > 100 then
    raise exception 'TOO_MANY_ENROLLMENTS' using errcode = '22023';
  end if;
  for v_id in select distinct u.id from unnest(p_enrollment_ids) as u(id) loop
    select * into v_row from public.worker_enrollments where id = v_id and project_id = p_project_id for update;
    if v_row.id is null then
      v_result := 'NOT_FOUND';
    elsif v_row.enrollment_status not in ('PENDING', 'APPROVED') then
      v_result := 'NOT_ACTIVE';
    elsif v_row.subcontractor_id is null then
      v_result := 'NO_COMPANY';
    elsif v_row.employer_status = p_decision then
      v_result := 'UNCHANGED';
    else
      update public.worker_enrollments
         set employer_status = p_decision, employer_confirmed_by = v_uid, employer_confirmed_at = now(), updated_at = now()
       where id = v_id;
      update public.subcontractor_members
         set verification_status = case when p_decision = 'VERIFIED' then 'VERIFIED'::public.member_verification_status
                                        else 'REJECTED'::public.member_verification_status end,
             authorized_by = v_uid, updated_at = now()
       where company_id = v_row.subcontractor_id and worker_profile_id = v_row.worker_id and role = 'WORKER'
         and verification_status in ('PENDING', 'VERIFIED');
      perform app_private.write_audit('USER', v_uid, 'enrollment.employer_' || lower(p_decision::text),
                                      app_private.project_organization(p_project_id), p_project_id,
                                      'worker_enrollment', v_id, null, '{}'::jsonb);
      v_result := p_decision::text;
    end if;
    v_results := v_results || jsonb_build_object('enrollment_id', v_id, 'result', v_result);
    v_row := null;
  end loop;
  return v_results;
end;
$$;

create function public.decide_enrollment(p_enrollment_id uuid, p_decision public.enrollment_status, p_reason text)
returns public.enrollment_status
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.worker_enrollments;
begin
  select * into v_row from public.worker_enrollments where id = p_enrollment_id for update;
  if v_uid is null or v_row.id is null or not app_private.can_run_orientation(v_row.project_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'REASON_REQUIRED' using errcode = '22023';
  end if;
  if p_decision = 'REJECTED' and v_row.enrollment_status = 'PENDING' then
    update public.worker_enrollments set enrollment_status = 'REJECTED', rejected_at = now(), updated_at = now()
     where id = p_enrollment_id;
  elsif p_decision = 'REVOKED' and v_row.enrollment_status = 'APPROVED' then
    update public.worker_enrollments set enrollment_status = 'REVOKED', revoked_at = now(), updated_at = now()
     where id = p_enrollment_id;
    update public.device_project_bindings set enabled = false, revoked_at = coalesce(revoked_at, now())
     where enrollment_id = p_enrollment_id;
  else
    raise exception 'INVALID_DECISION' using errcode = '22023';
  end if;
  perform app_private.write_audit('USER', v_uid, 'enrollment.' || lower(p_decision::text), app_private.project_organization(v_row.project_id),
                                  v_row.project_id, 'worker_enrollment', p_enrollment_id, null,
                                  jsonb_build_object('reason', btrim(p_reason)));
  return p_decision;
end;
$$;

-- The disclosure a supervisor reads to a no-phone worker (same text the app shows workers).
create function public.get_project_notice(p_project_id uuid, p_locale public.locale_code)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_notice public.legal_notice_versions;
begin
  if not app_private.can_view_roster(p_project_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  v_notice := app_private.current_notice(p_project_id, p_locale);
  if v_notice.id is null then
    raise exception 'NOTICE_UNAVAILABLE' using errcode = '22023';
  end if;
  return jsonb_build_object('notice', app_private.notice_json(v_notice),
                            'notice_acceptable', app_private.deployment_environment() <> 'production'
                                                 or v_notice.review_status = 'APPROVED');
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Supervised no-phone workers (managed identity; never a fabricated phone, e-mail or account)
-- ---------------------------------------------------------------------------------------------
alter table public.worker_profiles add column idempotency_key uuid;
create unique index worker_profiles_idempotency_uq on public.worker_profiles (created_by, idempotency_key)
  where idempotency_key is not null;

create function public.create_managed_worker(
  p_project_id uuid,
  p_legal_name text,
  p_company_id uuid,
  p_company_name text,
  p_trade text,
  p_emergency_name text,
  p_emergency_phone text,
  p_emergency_relationship text,
  p_locale public.locale_code,
  p_notice_version_id uuid,
  p_acknowledged boolean,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_worker uuid;
  v_company uuid;
  v_notice public.legal_notice_versions;
  v_enrollment public.worker_enrollments;
begin
  if v_uid is null or not app_private.can_view_roster(p_project_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_idempotency_key is null then
    raise exception 'IDEMPOTENCY_KEY_REQUIRED' using errcode = '22023';
  end if;
  select id into v_worker from public.worker_profiles where created_by = v_uid and idempotency_key = p_idempotency_key;
  if v_worker is not null then
    select * into v_enrollment from public.worker_enrollments
     where worker_id = v_worker and project_id = p_project_id order by created_at desc limit 1;
    return jsonb_build_object('worker_id', v_worker, 'enrollment_id', v_enrollment.id,
                              'enrollment_status', v_enrollment.enrollment_status);
  end if;
  if (select status from public.projects where id = p_project_id) <> 'ACTIVE' then
    raise exception 'PROJECT_NOT_ACTIVE' using errcode = '22023';
  end if;
  perform app_private.assert_worker_details(p_legal_name, p_trade, p_emergency_name, p_emergency_phone, p_emergency_relationship);
  v_notice := app_private.assert_notice_acceptable(p_project_id, p_locale, p_notice_version_id, p_acknowledged);

  insert into public.worker_profiles (legal_name, primary_language, managed_identity, created_by, idempotency_key)
  values (btrim(p_legal_name), p_locale, true, v_uid, p_idempotency_key)
  returning id into v_worker;
  perform app_private.replace_emergency_contact(v_worker, p_emergency_name, p_emergency_phone, p_emergency_relationship);
  v_company := app_private.resolve_join_company(p_project_id, p_company_id, p_company_name, v_uid);
  v_enrollment := app_private.record_orientation(p_project_id, v_worker, null, v_uid, v_company, p_trade, v_notice, 'SUPERVISED');

  perform app_private.write_audit('USER', v_uid, 'worker.managed_created', app_private.project_organization(p_project_id),
                                  p_project_id, 'worker_profile', v_worker, null,
                                  jsonb_build_object('notice_version_id', v_notice.id, 'method', 'SUPERVISED'));
  return jsonb_build_object('worker_id', v_worker, 'enrollment_id', v_enrollment.id,
                            'enrollment_status', v_enrollment.enrollment_status);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Printed badges: opaque permanent identifier (no PII), attended issuance, hash only stored
-- ---------------------------------------------------------------------------------------------
create function public.issue_printed_badge(p_project_id uuid, p_worker_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_code text;
  v_badge uuid;
begin
  if v_uid is null or not app_private.can_view_roster(p_project_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if not exists (select 1 from public.worker_enrollments e
                  where e.project_id = p_project_id and e.worker_id = p_worker_id and e.enrollment_status = 'APPROVED') then
    raise exception 'ENROLLMENT_NOT_APPROVED' using errcode = '22023';
  end if;
  if not app_private.consume_rate_limit('badge_issue', v_uid::text, 30, 60) then
    raise exception 'RATE_LIMITED' using errcode = '22023';
  end if;
  update public.worker_badges set active = false, revoked_at = now()
   where worker_id = p_worker_id and badge_kind = 'PRINTED' and active;
  v_code := 'SMP1.' || app_private.b64url(extensions.gen_random_bytes(24));
  insert into public.worker_badges (worker_id, badge_kind, opaque_badge_hash, issued_by)
  values (p_worker_id, 'PRINTED', pg_catalog.sha256(convert_to(v_code, 'UTF8')), v_uid)
  returning id into v_badge;
  perform app_private.write_audit('USER', v_uid, 'badge.printed_issued', app_private.project_organization(p_project_id),
                                  p_project_id, 'worker_badge', v_badge, null, jsonb_build_object('worker_id', p_worker_id));
  return jsonb_build_object('badge_id', v_badge, 'code', v_code, 'issued_at', now());
end;
$$;

create function public.revoke_printed_badge(p_project_id uuid, p_badge_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_worker uuid;
begin
  select worker_id into v_worker from public.worker_badges where id = p_badge_id and badge_kind = 'PRINTED';
  if v_uid is null or v_worker is null or not app_private.can_view_roster(p_project_id)
     or not exists (select 1 from public.worker_enrollments e where e.project_id = p_project_id and e.worker_id = v_worker) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'REASON_REQUIRED' using errcode = '22023';
  end if;
  update public.worker_badges set active = false, revoked_at = coalesce(revoked_at, now()) where id = p_badge_id;
  perform app_private.write_audit('USER', v_uid, 'badge.printed_revoked', app_private.project_organization(p_project_id),
                                  p_project_id, 'worker_badge', p_badge_id, null, jsonb_build_object('reason', btrim(p_reason)));
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Device activation and badge redemption: Edge Functions only (service_role, decision #71)
-- ---------------------------------------------------------------------------------------------
create function public.edge_activate_device(
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
  if exists (select 1 from app_private.platform_operators o where o.user_id = p_user_id and o.active) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  select id into v_worker from public.worker_profiles where auth_user_id = p_user_id and deleted_at is null;
  if v_worker is null then
    raise exception 'WORKER_PROFILE_REQUIRED' using errcode = '22023';
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

create function public.edge_badge_device(p_device_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('device_id', d.id, 'worker_id', d.worker_id,
                            'active', d.active and s.revoked_at is null,
                            'secret_ciphertext', app_private.b64url(s.secret_ciphertext), 'key_version', s.key_version)
    from public.device_installations d
    join app_private.device_badge_secrets s on s.device_id = d.id
   where d.id = p_device_id
$$;

-- Single use per (project, device, 30-second step). Same kiosk event again = duplicate.
create function public.edge_redeem_badge_step(
  p_project_id uuid, p_device_id uuid, p_time_step bigint, p_event_uuid uuid, p_operator_id uuid, p_kiosk_device_id uuid
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing uuid;
begin
  insert into app_private.badge_nonce_redemptions (project_id, device_id, time_step, operator_id, kiosk_device_id, event_uuid)
  values (p_project_id, p_device_id, p_time_step, p_operator_id, p_kiosk_device_id, p_event_uuid)
  on conflict (project_id, device_id, time_step) do nothing;
  if found then
    return 'accepted';
  end if;
  select event_uuid into v_existing from app_private.badge_nonce_redemptions
   where project_id = p_project_id and device_id = p_device_id and time_step = p_time_step;
  return case when v_existing = p_event_uuid then 'duplicate' else 'replay' end;
end;
$$;

-- Project detail also tells the app which orientation/roster actions to offer (server re-checks).
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
                                      'can_view_roster', app_private.can_view_roster(p.id))
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
  app_private.deployment_environment(), app_private.b64url(bytea),
  app_private.current_notice(uuid, public.locale_code), app_private.notice_json(public.legal_notice_versions),
  app_private.assert_notice_acceptable(uuid, public.locale_code, uuid, boolean),
  app_private.can_run_orientation(uuid), app_private.session_is_open(public.orientation_sessions),
  app_private.session_json(uuid), app_private.close_session_internal(uuid, public.orientation_session_status),
  app_private.orientation_code_session(text), app_private.resolve_join_company(uuid, uuid, text, uuid),
  app_private.assert_worker_details(text, text, text, text, text),
  app_private.record_orientation(uuid, uuid, uuid, uuid, uuid, text, public.legal_notice_versions, public.consent_method),
  app_private.replace_emergency_contact(uuid, text, text, text)
  from public, anon, authenticated, service_role;

revoke all on function
  public.start_orientation_session(uuid, uuid), public.get_orientation_session(uuid),
  public.close_orientation_session(uuid), public.list_orientation_sessions(uuid),
  public.preview_orientation(text, public.locale_code),
  public.complete_orientation(text, public.locale_code, text, uuid, text, text, text, text, text, uuid, boolean),
  public.my_enrollments(), public.get_my_emergency_contact(), public.update_my_emergency_contact(text, text, text),
  public.list_project_enrollments(uuid), public.bulk_approve_enrollments(uuid, uuid[]),
  public.bulk_confirm_employer(uuid, uuid[], public.employer_status),
  public.decide_enrollment(uuid, public.enrollment_status, text), public.get_project_notice(uuid, public.locale_code),
  public.create_managed_worker(uuid, text, uuid, text, text, text, text, text, public.locale_code, uuid, boolean, uuid),
  public.issue_printed_badge(uuid, uuid), public.revoke_printed_badge(uuid, uuid, text),
  public.edge_activate_device(uuid, uuid, public.device_platform, text, text, bytea, smallint, bytea),
  public.edge_badge_device(uuid), public.edge_redeem_badge_step(uuid, uuid, bigint, uuid, uuid, uuid)
  from public, anon, authenticated, service_role;

grant execute on function
  public.start_orientation_session(uuid, uuid), public.get_orientation_session(uuid),
  public.close_orientation_session(uuid), public.list_orientation_sessions(uuid),
  public.preview_orientation(text, public.locale_code),
  public.complete_orientation(text, public.locale_code, text, uuid, text, text, text, text, text, uuid, boolean),
  public.my_enrollments(), public.get_my_emergency_contact(), public.update_my_emergency_contact(text, text, text),
  public.list_project_enrollments(uuid), public.bulk_approve_enrollments(uuid, uuid[]),
  public.bulk_confirm_employer(uuid, uuid[], public.employer_status),
  public.decide_enrollment(uuid, public.enrollment_status, text), public.get_project_notice(uuid, public.locale_code),
  public.create_managed_worker(uuid, text, uuid, text, text, text, text, text, public.locale_code, uuid, boolean, uuid),
  public.issue_printed_badge(uuid, uuid), public.revoke_printed_badge(uuid, uuid, text)
  to authenticated;

grant execute on function
  public.edge_activate_device(uuid, uuid, public.device_platform, text, text, bytea, smallint, bytea),
  public.edge_badge_device(uuid), public.edge_redeem_badge_step(uuid, uuid, bigint, uuid, uuid, uuid)
  to service_role;
