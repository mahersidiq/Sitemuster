-- Milestone 12: cross-tenant penetration sweep (docs/spec/09 "Cross-project leakage … are no-go";
-- spec 02; decision #136). Every function a signed-in client may call, and every table or view it
-- may read, is exercised by people from ANOTHER tenant — GC B's owner and superintendent, B's
-- foreman and worker, a signed-in outsider, the platform operator and an anonymous caller — with
-- the real ids of tenant A's organization, project, workers, devices, kiosk, muster, report,
-- invitation, badge, visit, correction and orientation session.
--
-- A call passes when it is refused, or when it returns nothing of A's (no A names, phones,
-- emails, coordinates, or A ids the caller did not supply) AND leaves A's data unchanged. Each
-- call runs in its own subtransaction that is always rolled back, so calls cannot affect each
-- other. New functions and tables are swept automatically.
begin;
select plan(19);
select tests.seed_world();

-- A few more of tenant A's objects, so every id-taking function gets a real A target.
insert into public.orientation_sessions (id, project_id, started_by, starts_at, expires_at, static_code_hash, idempotency_key)
values ('ac000000-0000-4000-8000-00000000000a', tests.id('p_a1'), tests.id('u_a_super'), now(), now() + interval '2 hours',
        sha256('pen-static-code'::bytea), gen_random_uuid());
insert into app_private.orientation_session_secrets (session_id, rotating_secret, static_code)
values ('ac000000-0000-4000-8000-00000000000a', decode(repeat('12', 32), 'hex'), repeat('p', 43));
insert into public.worker_badges (id, worker_id, badge_kind, opaque_badge_hash)
values ('ad000000-0000-4000-8000-00000000000a', tests.id('w_a2'), 'PRINTED', sha256('pen-badge'::bytea));
insert into public.organization_invitations (id, organization_id, project_id, target_email, project_role, expires_at, token_hash, invited_by)
values ('ae000000-0000-4000-8000-00000000000a', tests.id('org_a'), tests.id('p_a1'), 'new.super.a@example.test', 'SUPER',
        now() + interval '7 days', sha256('pen-invite'::bytea), tests.id('u_a_owner'));
insert into public.attendance_corrections (id, session_id, project_id, worker_id, channel, requested_by, reason, proposed_json, event_uuid)
values ('af000000-0000-4000-8000-00000000000a', tests.id('s_a1'), tests.id('p_a1'), tests.id('w_a1'), 'WORKER_REQUEST',
        tests.id('u_worker_a1'), 'Left at 15:00, not 17:00', '{"end_at": "2026-11-02T21:00:00Z"}', gen_random_uuid());
select set_config('pen.report', (select id::text from public.daily_company_reports where project_id = tests.id('p_a1') limit 1), true);

-- ---------------------------------------------------------------------------------------------
-- Sweep helpers (exist only inside this test's transaction)
-- ---------------------------------------------------------------------------------------------
create function tests.pen_a_ids() returns text[] language sql stable as $$
  select array[tests.id('org_a'), tests.id('p_a1'), tests.id('cv_a1'), tests.id('c_a'), tests.id('w_a1'), tests.id('w_a2'),
               tests.id('w_fa'), tests.id('w_managed'), tests.id('e_a1'), tests.id('e_a2'), tests.id('d_a1'), tests.id('d_a1_old'),
               tests.id('s_a1'), tests.id('ev_a1'), tests.id('m_a'), tests.id('mm_a1'), tests.id('k_a'), tests.id('v_a'),
               tests.id('vv_a'), tests.id('u_a_owner'), tests.id('u_a_admin'), tests.id('u_a_pm'), tests.id('u_a_super'),
               tests.id('u_a_safety'), tests.id('u_a_attendant'), tests.id('u_foreman_a'), tests.id('u_worker_a1'),
               tests.id('u_worker_a2'), 'ac000000-0000-4000-8000-00000000000a'::uuid, 'ad000000-0000-4000-8000-00000000000a'::uuid,
               'ae000000-0000-4000-8000-00000000000a'::uuid, 'af000000-0000-4000-8000-00000000000a'::uuid,
               current_setting('pen.report')::uuid]::text[]
$$;

-- Tenant A's people, places and contact data as they would appear in any output.
create function tests.pen_content_markers() returns text language sql immutable as $$
  select 'GC Alpha|Alpha Tower|Acme Concrete|Ana Acosta|Ben Avila|Fernando Alvarez|Diego No-Phone|Maria Acosta|Ivy Inspector'
      || '|City of Houston|\+15550000101|\+1555000020[12]|\+15550009991|\+15550008881'
      || '|(owner|admin|pm|super|safety|attendant|new\.super)\.a@example\.test|29\.760|-95\.369'
$$;

-- What a call may not return: A's content, and A's ids except those the caller supplied.
create function tests.pen_markers(p_args text) returns text language sql stable as $$
  select tests.pen_content_markers() || coalesce('|' || string_agg(i, '|'), '')
    from unnest(tests.pen_a_ids()) i where position(i in p_args) = 0
$$;

-- A fingerprint of everything tenant A owns; any change made by an outsider's call shows here.
create function tests.pen_fingerprint() returns text language sql stable as $$
  select md5(coalesce(string_agg(x, '|' order by x), '')) from (
    select 'org ' || t::text from public.organizations t where id = tests.id('org_a')
    union all select 'mem ' || t::text from public.organization_members t where organization_id = tests.id('org_a')
    union all select 'inv ' || t::text from public.organization_invitations t where organization_id = tests.id('org_a')
    union all select 'prj ' || t::text from public.projects t where organization_id = tests.id('org_a')
    union all select 'cfg ' || t::text from public.project_tracking_config_versions t where project_id = tests.id('p_a1')
    union all select 'stf ' || t::text from public.project_staff t where project_id = tests.id('p_a1')
    union all select 'sub ' || t::text from public.project_subcontractors t where project_id = tests.id('p_a1')
    union all select 'enr ' || t::text from public.worker_enrollments t where project_id = tests.id('p_a1')
    union all select 'wkr ' || t::text from public.worker_profiles t
               where id in (tests.id('w_a1'), tests.id('w_a2'), tests.id('w_fa'), tests.id('w_managed'))
    union all select 'smb ' || t::text from public.subcontractor_members t where company_id = tests.id('c_a')
    union all select 'con ' || t::text from public.tracking_consents t where project_id = tests.id('p_a1')
    union all select 'emc ' || t::text from public.emergency_contacts t where worker_profile_id = tests.id('w_a1')
    union all select 'dev ' || t::text from public.device_installations t where worker_id = tests.id('w_a1')
    union all select 'bnd ' || t::text from public.device_project_bindings t where project_id = tests.id('p_a1')
    union all select 'bdg ' || t::text from public.worker_badges t where worker_id in (tests.id('w_a1'), tests.id('w_a2'))
    union all select 'ksk ' || t::text from public.kiosk_devices t where project_id = tests.id('p_a1')
    union all select 'ses ' || t::text from public.attendance_sessions t where project_id = tests.id('p_a1')
    union all select 'evt ' || t::text from public.attendance_events t where project_id = tests.id('p_a1')
    union all select 'cor ' || t::text from public.attendance_corrections t where project_id = tests.id('p_a1')
    union all select 'prs ' || t::text from public.presence_states t where project_id = tests.id('p_a1')
    union all select 'pos ' || t::text from public.latest_onsite_positions t where project_id = tests.id('p_a1')
    union all select 'vis ' || t::text from public.visitor_records t where project_id = tests.id('p_a1')
    union all select 'vsv ' || t::text from public.visitor_visits t where project_id = tests.id('p_a1')
    union all select 'ori ' || t::text from public.orientation_sessions t where project_id = tests.id('p_a1')
    union all select 'mus ' || t::text from public.muster_events t where project_id = tests.id('p_a1')
    union all select 'msm ' || t::text from public.muster_snapshot_members t where muster_id = tests.id('m_a')
    union all select 'rep ' || t::text from public.daily_company_reports t where project_id = tests.id('p_a1')
  ) s(x)
$$;

-- A plausible argument for each parameter, aimed at tenant A.
create function tests.pen_arg(p_fn text, p_name text, p_type oid) returns text language plpgsql stable as $$
declare
  v_type text := format_type(p_type, null);
  v_name text := lower(coalesce(p_name, ''));
  v_label text;
begin
  if v_type = 'uuid' then
    return quote_literal(case
      when v_name ~ 'idempotency|event_uuid|^p_event$|request_uuid|nonce' then gen_random_uuid()
      when v_name ~ 'session' and p_fn ~ 'orientation' then 'ac000000-0000-4000-8000-00000000000a'::uuid
      when v_name ~ 'session' then tests.id('s_a1')
      when v_name ~ 'project' then tests.id('p_a1')
      when v_name ~ 'enrollment' then tests.id('e_a1')
      when v_name ~ 'member' then tests.id('mm_a1')
      when v_name ~ 'muster' then tests.id('m_a')
      when v_name ~ 'report' then current_setting('pen.report')::uuid
      when v_name ~ 'invitation|invite' then 'ae000000-0000-4000-8000-00000000000a'::uuid
      when v_name ~ 'badge' then 'ad000000-0000-4000-8000-00000000000a'::uuid
      when v_name ~ 'correction|request' then 'af000000-0000-4000-8000-00000000000a'::uuid
      when v_name ~ 'visit$|visit_id' then tests.id('vv_a')
      when v_name ~ 'visitor' then tests.id('v_a')
      when v_name ~ 'kiosk' then tests.id('k_a')
      when v_name ~ 'device' then tests.id('d_a1')
      when v_name ~ 'worker|staff_worker|profile' then tests.id('w_a1')
      when v_name ~ 'company|subcontractor|employer' then tests.id('c_a')
      when v_name ~ 'config' then tests.id('cv_a1')
      when v_name ~ 'org' then tests.id('org_a')
      when v_name ~ 'notice' then tests.id('n_en')
      when v_name ~ 'user|actor|staff' then tests.id('u_a_super')
      else tests.id('p_a1') end) || '::uuid';
  elsif v_type = 'uuid[]' then
    return format('array[%L, %L]::uuid[]', tests.id('w_a1'), tests.id('w_a2'));
  elsif v_type in ('text', 'character varying') then
    return quote_literal(case
      when v_name ~ 'reason|note|basis|label|purpose|summary|description|comment' then 'pen test reason'
      when v_name ~ 'code' then 'SMS1.ac000000-0000-4000-8000-00000000000a.' || repeat('p', 43)
      when v_name ~ 'email' then 'owner.a@example.test'
      when v_name ~ 'phone' then '+15550000201'
      when v_name ~ 'query|search' then 'Alpha'
      when v_name ~ 'locale|language' then 'en-US'
      when v_name ~ 'hash' then repeat('0', 64)
      when v_name ~ 'installation' then 'install-pen-0001'
      when v_name ~ 'token' then 'ExponentPushToken[pen-test]'
      when v_name ~ 'zone' then 'America/Chicago'
      when v_name ~ 'public_id' then 'kiosk-alpha-0001'
      when v_name ~ 'name' then 'Pen Test'
      when v_name ~ 'aal' then 'aal2'
      else 'pen-test' end);
  elsif v_type = 'text[]' then
    return quote_literal('{pen-test}') || '::text[]';
  elsif v_type = 'boolean' then
    return 'true';
  elsif v_type in ('integer', 'smallint', 'bigint', 'numeric', 'double precision', 'real') then
    return '1::' || v_type;
  elsif v_type = 'timestamp with time zone' then
    return 'now()';
  elsif v_type = 'date' then
    return quote_literal('2026-11-02') || '::date';
  elsif v_type in ('jsonb', 'json') then
    return quote_literal('{}') || '::' || v_type;
  elsif exists (select 1 from pg_type t where t.oid = p_type and t.typtype = 'e') then
    select e.enumlabel into v_label from pg_enum e where e.enumtypid = p_type order by e.enumsortorder limit 1;
    return quote_literal(v_label) || '::' || v_type;
  end if;
  return 'null::' || v_type;
end;
$$;

-- The call text for a function, with every input argument filled in.
create function tests.pen_call(p_proc oid) returns text language plpgsql stable as $$
declare
  v_p record;
  v_names text[];
  v_modes text[];
  v_inputs text[] := '{}';
  v_args text[] := '{}';
  v_types oid[];
  v_k integer := 0;
  v_i integer;
begin
  select p.proname, p.proargnames, p.proargmodes::text[] as modes, p.proretset
    into v_p from pg_proc p where p.oid = p_proc;
  v_names := coalesce(v_p.proargnames, '{}');
  v_modes := v_p.modes;
  -- proargtypes is a zero-based oidvector: re-index it from 1 like the other arrays.
  select coalesce(array_agg(t order by o), '{}') into v_types
    from pg_proc p, unnest(p.proargtypes::oid[]) with ordinality u(t, o) where p.oid = p_proc;
  for v_i in 1 .. coalesce(array_length(v_names, 1), 0) loop
    if v_modes is null or v_modes[v_i] in ('i', 'b', 'v') then
      v_inputs := v_inputs || v_names[v_i];
    end if;
  end loop;
  for v_i in 1 .. coalesce(array_length(v_types, 1), 0) loop
    v_args := v_args || tests.pen_arg(v_p.proname, v_inputs[v_i], v_types[v_i]);
  end loop;
  if v_p.proretset then
    return format('select coalesce(string_agg(r::text, %L), %L) from public.%I(%s) r', ',', '', v_p.proname, array_to_string(v_args, ', '));
  end if;
  return format('select coalesce(public.%I(%s)::text, %L)', v_p.proname, array_to_string(v_args, ', '), '');
end;
$$;

-- Runs every callable function as the attacker; returns findings ('read …' / 'write …').
create function tests.pen_sweep_functions(p_user uuid, p_role text, p_aal text, p_skip text default '^$')
returns jsonb language plpgsql as $$
declare
  v_fn record;
  v_sql text;
  v_result text;
  v_before text := tests.pen_fingerprint();
  v_after text;
  v_markers text;
  v_findings text[] := '{}';
  v_malformed text[] := '{}';
  v_called integer := 0;
  v_refused integer := 0;
  v_claims text := case when p_user is null then json_build_object('role', 'anon')::text
                        else json_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal)::text end;
begin
  for v_fn in
    select p.oid, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and has_function_privilege(p_role, p.oid, 'EXECUTE') and p.prokind = 'f'
       and p.proname !~ p_skip
     order by p.proname
  loop
    v_sql := tests.pen_call(v_fn.oid);
    v_markers := tests.pen_markers(v_sql);
    v_called := v_called + 1;
    begin
      perform set_config('request.jwt.claims', v_claims, true);
      perform set_config('role', p_role, true);
      execute v_sql into v_result;
      perform set_config('role', 'postgres', true);
      perform set_config('request.jwt.claims', '', true);
      v_after := tests.pen_fingerprint();
      if v_result ~* v_markers then
        v_findings := v_findings || ('read ' || v_fn.proname || ': '
                                     || left(coalesce(regexp_substr(v_result, v_markers, 1, 1, 'i'), '?'), 60));
      end if;
      if v_after <> v_before then
        v_findings := v_findings || ('write ' || v_fn.proname);
      end if;
      raise exception 'PEN_ROLLBACK';
    exception when others then
      if sqlerrm <> 'PEN_ROLLBACK' then
        v_refused := v_refused + 1;
        -- A call the harness built wrongly proves nothing: undefined function, wrong argument
        -- types, unparsable input or a missing column must never be counted as a refusal.
        if sqlstate in ('42883', '42804', '42725', '22P02', '42703', '42P01', '22007', '22008') then
          v_malformed := v_malformed || (v_fn.proname || ' [' || sqlstate || '] ' || left(sqlerrm, 80));
        end if;
      end if;
    end;
  end loop;
  return jsonb_build_object('findings', to_jsonb(v_findings), 'malformed', to_jsonb(v_malformed),
                            'called', v_called, 'refused', v_refused);
end;
$$;

-- Reads every API-visible table and view as the attacker; returns the ones that show A's rows.
create function tests.pen_sweep_relations(p_user uuid, p_role text, p_aal text)
returns jsonb language plpgsql as $$
declare
  v_rel record;
  v_count bigint;
  v_findings text[] := '{}';
  v_read integer := 0;
  v_markers text := tests.pen_markers('');
  v_claims text := case when p_user is null then json_build_object('role', 'anon')::text
                        else json_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal)::text end;
begin
  for v_rel in
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'v', 'm', 'p') and not c.relispartition
       and has_table_privilege(p_role, c.oid, 'SELECT')
     order by c.relname
  loop
    begin
      perform set_config('request.jwt.claims', v_claims, true);
      perform set_config('role', p_role, true);
      execute format('select count(*) from public.%I t where t::text ~* %L', v_rel.relname, v_markers) into v_count;
      perform set_config('role', 'postgres', true);
      perform set_config('request.jwt.claims', '', true);
      v_read := v_read + 1;
      if v_count > 0 then
        v_findings := v_findings || (v_rel.relname || ': ' || v_count || ' row(s)');
      end if;
      raise exception 'PEN_ROLLBACK';
    exception when others then
      null;
    end;
  end loop;
  return jsonb_build_object('findings', to_jsonb(v_findings), 'read', v_read);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Positive controls: the sweep catches a leaky reader, a leaky writer and an open table
-- ---------------------------------------------------------------------------------------------
create function public.pen_probe_leaky_read(p_project_id uuid) returns text
language sql security definer set search_path = '' as $$ select name from public.projects where id = p_project_id $$;
create function public.pen_probe_leaky_write(p_project_id uuid) returns void
language sql security definer set search_path = '' as $$ update public.projects set name = name || ' ' where id = p_project_id $$;
grant execute on function public.pen_probe_leaky_read(uuid), public.pen_probe_leaky_write(uuid) to authenticated;
create table public.pen_probe_open as select name from public.projects where id = tests.id('p_a1');
grant select on public.pen_probe_open to authenticated;
select set_config('pen.control', tests.pen_sweep_functions(tests.id('u_outsider'), 'authenticated', 'aal2', '^(?!pen_probe_)')::text, true);
select is(current_setting('pen.control')::jsonb -> 'findings',
          '["read pen_probe_leaky_read: Alpha Tower", "write pen_probe_leaky_write"]'::jsonb,
  'control: the sweep reports a function that returns or changes tenant A data');
select is(tests.pen_sweep_relations(tests.id('u_outsider'), 'authenticated', 'aal2') -> 'findings', '["pen_probe_open: 1 row(s)"]'::jsonb,
  'control: the sweep reports a table that shows tenant A rows');
drop function public.pen_probe_leaky_read(uuid);
drop function public.pen_probe_leaky_write(uuid);
drop table public.pen_probe_open;

-- ---------------------------------------------------------------------------------------------
-- Every callable function, as each attacker
-- ---------------------------------------------------------------------------------------------
select set_config('pen.b_owner', tests.pen_sweep_functions(tests.id('u_b_owner'), 'authenticated', 'aal2')::text, true);
select set_config('pen.b_super', tests.pen_sweep_functions(tests.id('u_b_super'), 'authenticated', 'aal2')::text, true);
select set_config('pen.b_foreman', tests.pen_sweep_functions(tests.id('u_foreman_b'), 'authenticated', 'aal1')::text, true);
select set_config('pen.b_worker', tests.pen_sweep_functions(tests.id('u_worker_b1'), 'authenticated', 'aal1')::text, true);
select set_config('pen.outsider', tests.pen_sweep_functions(tests.id('u_outsider'), 'authenticated', 'aal2')::text, true);
-- The operator's own audited RPCs (org metadata by design) are covered by 029/030; everything
-- else must refuse them like any outsider.
select set_config('pen.operator', tests.pen_sweep_functions(tests.id('u_operator'), 'authenticated', 'aal2', '^operator_')::text, true);
select set_config('pen.anon', tests.pen_sweep_functions(null, 'anon', null)::text, true);

select is((current_setting('pen.b_owner')::jsonb -> 'findings') || (current_setting('pen.b_owner')::jsonb -> 'malformed'), '[]'::jsonb, 'GC B owner: no function returns or changes tenant A data');
select is((current_setting('pen.b_super')::jsonb -> 'findings') || (current_setting('pen.b_super')::jsonb -> 'malformed'), '[]'::jsonb, 'GC B superintendent: no function returns or changes tenant A data');
select is((current_setting('pen.b_foreman')::jsonb -> 'findings') || (current_setting('pen.b_foreman')::jsonb -> 'malformed'), '[]'::jsonb, 'B foreman: no function returns or changes tenant A data');
select is((current_setting('pen.b_worker')::jsonb -> 'findings') || (current_setting('pen.b_worker')::jsonb -> 'malformed'), '[]'::jsonb, 'B worker: no function returns or changes tenant A data');
select is((current_setting('pen.outsider')::jsonb -> 'findings') || (current_setting('pen.outsider')::jsonb -> 'malformed'), '[]'::jsonb, 'a signed-in outsider: no function returns or changes tenant A data');
select is((current_setting('pen.operator')::jsonb -> 'findings') || (current_setting('pen.operator')::jsonb -> 'malformed'), '[]'::jsonb, 'the platform operator: no tenant function returns or changes tenant A data');
select is((current_setting('pen.anon')::jsonb -> 'findings') || (current_setting('pen.anon')::jsonb -> 'malformed'), '[]'::jsonb, 'anonymous: no function returns or changes tenant A data');
select ok((current_setting('pen.b_owner')::jsonb ->> 'called')::int >= 80
          and (current_setting('pen.b_owner')::jsonb ->> 'refused')::int >= 50,
  'the sweep really called every client function, well-formed (and most refused outright)');
select is((current_setting('pen.anon')::jsonb ->> 'called')::int, 0, 'anonymous callers can execute no public function at all');

-- ---------------------------------------------------------------------------------------------
-- Every readable table and view, as each attacker
-- ---------------------------------------------------------------------------------------------
select is(tests.pen_sweep_relations(tests.id('u_b_owner'), 'authenticated', 'aal2') -> 'findings', '[]'::jsonb,
  'GC B owner sees no row of tenant A in any table or view');
select is(tests.pen_sweep_relations(tests.id('u_b_super'), 'authenticated', 'aal2') -> 'findings', '[]'::jsonb,
  'GC B superintendent sees no row of tenant A');
select is(tests.pen_sweep_relations(tests.id('u_foreman_b'), 'authenticated', 'aal1') -> 'findings', '[]'::jsonb,
  'B foreman sees no row of tenant A');
select is(tests.pen_sweep_relations(tests.id('u_worker_b1'), 'authenticated', 'aal1') -> 'findings', '[]'::jsonb,
  'B worker sees no row of tenant A');
select is(tests.pen_sweep_relations(tests.id('u_outsider'), 'authenticated', 'aal2') -> 'findings', '[]'::jsonb,
  'a signed-in outsider sees no row of tenant A');
select is(tests.pen_sweep_relations(tests.id('u_operator'), 'authenticated', 'aal2') -> 'findings', '[]'::jsonb,
  'the platform operator sees no row of tenant A (no coordinates, contacts or rosters)');
select ok((tests.pen_sweep_relations(tests.id('u_b_owner'), 'authenticated', 'aal2') ->> 'read')::int >= 20,
  'the sweep really read every API-visible table and view');
select is((tests.pen_sweep_relations(null, 'anon', null) ->> 'read')::int, 0, 'anonymous callers can read no table at all');

select * from finish();
rollback;
