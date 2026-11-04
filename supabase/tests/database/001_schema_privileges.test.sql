-- Schema shape and deny-by-default privileges (spec 05 "Migration/test requirement").
begin;
select plan(18);

select tables_are('public', array[
  'organizations', 'organization_members', 'organization_invitations', 'projects', 'project_staff',
  'project_work_windows', 'project_tracking_config_versions', 'project_geofences', 'subcontractor_companies',
  'project_subcontractors', 'subcontractor_members', 'foreman_project_grants', 'worker_profiles',
  'emergency_contacts', 'orientation_sessions', 'orientation_records', 'worker_enrollments',
  'tracking_consents', 'legal_notice_versions', 'device_installations', 'device_project_bindings',
  'kiosk_devices', 'worker_badges', 'latest_onsite_positions', 'attendance_events', 'presence_states',
  'attendance_sessions', 'attendance_corrections', 'visitor_records', 'visitor_visits',
  'daily_company_reports', 'report_confirmations', 'muster_events', 'muster_snapshot_members',
  'muster_responses'
], 'public schema holds exactly the client-readable tables');

select ok(
  (select bool_and(exists (select 1 from pg_tables t where t.schemaname = 'app_private' and t.tablename = x))
     from unnest(array['platform_operators', 'orientation_invites', 'device_upload_credentials',
                       'device_badge_secrets', 'push_tokens', 'badge_nonce_redemptions',
                       'location_event_receipts', 'location_ingest_quarantine', 'raw_onsite_fixes',
                       'operational_outbox_receipts', 'platform_operator_actions', 'audit_logs']) x),
  'server-only tables live in the unexposed app_private schema'
);

select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'app_private') and c.relkind in ('r', 'p') and not c.relrowsecurity),
  0, 'row level security is enabled on every table in public and app_private (including partitions)'
);

select is(
  (select count(*)::int from pg_policies where schemaname = 'public' and cmd <> 'SELECT'),
  0, 'no client INSERT/UPDATE/DELETE policy exists on any public table'
);

select is(
  (select count(*)::int from pg_policies where schemaname = 'app_private'),
  0, 'app_private tables have no policies (server functions only)'
);

select is(
  (select count(*)::int from pg_policies where schemaname = 'public' and roles <> '{authenticated}'),
  0, 'every public policy targets authenticated only (never anon/public)'
);

select is(
  (select count(*)::int from information_schema.role_table_grants
    where table_schema in ('public', 'app_private') and grantee in ('anon', 'PUBLIC')),
  0, 'anon and PUBLIC hold no table privileges'
);

select is(
  (select count(*)::int from information_schema.role_table_grants
    where table_schema in ('public', 'app_private') and grantee = 'authenticated'
      and privilege_type <> 'SELECT'),
  0, 'authenticated holds no INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER privilege'
);

select is(
  (select count(*)::int from information_schema.column_privileges
    where table_schema in ('public', 'app_private') and grantee = 'authenticated'
      and privilege_type <> 'SELECT'),
  0, 'authenticated holds no column-level write privilege'
);

select is(
  (select count(*)::int from information_schema.role_table_grants
    where table_schema = 'app_private' and grantee in ('authenticated', 'service_role')),
  0, 'no app_private table is granted to authenticated or service_role'
);

select is(
  (select count(*)::int from information_schema.role_table_grants
    where table_schema = 'public' and grantee = 'service_role'),
  0, 'service_role has no broad table access (Edge Functions use scoped functions; decision #39)'
);

select ok(
  not has_column_privilege('authenticated', 'public.worker_profiles', 'phone', 'SELECT')
  and not has_column_privilege('authenticated', 'public.worker_profiles', 'email', 'SELECT')
  and not has_column_privilege('authenticated', 'public.worker_profiles', 'auth_user_id', 'SELECT'),
  'worker phone, email and auth link are not readable through the table'
);

select ok(
  not has_column_privilege('authenticated', 'public.organization_invitations', 'token_hash', 'SELECT')
  and not has_column_privilege('authenticated', 'public.orientation_sessions', 'static_code_hash', 'SELECT')
  and not has_column_privilege('authenticated', 'public.worker_badges', 'opaque_badge_hash', 'SELECT')
  and not has_column_privilege('authenticated', 'public.device_installations', 'hardware_installation_hash', 'SELECT'),
  'token, QR, badge and device hashes are never readable by clients'
);

select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'app_private')
      and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('public', p.oid, 'EXECUTE'))),
  0, 'no function in public/app_private is executable by anon or PUBLIC'
);

select is(
  (select array_agg(p.proname::text order by p.proname)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and has_function_privilege('authenticated', p.oid, 'EXECUTE')),
  array['accept_invitation', 'address_lookup_allowed', 'bulk_approve_enrollments', 'bulk_confirm_employer',
        'check_project_site', 'close_orientation_session', 'complete_orientation', 'create_managed_worker',
        'create_organization', 'create_project', 'decide_enrollment', 'get_my_access',
        'get_my_emergency_contact', 'get_my_profile', 'get_orientation_session', 'get_project_detail',
        'get_project_notice',
        'invite_org_admin', 'invite_project_staff', 'issue_printed_badge', 'list_my_invitations',
        'list_my_projects', 'list_orientation_sessions', 'list_project_enrollments', 'my_enrollments',
        'preview_orientation', 'remove_project_staff', 'revoke_invitation', 'revoke_printed_badge',
        'set_my_language', 'set_project_status', 'start_orientation_session', 'update_my_emergency_contact',
        'update_project_config'],
  'client-callable RPCs in public are exactly the reviewed allowlist'
);

select is(
  (select array_agg(p.proname::text order by p.proname)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'edge\_%'
      and has_function_privilege('service_role', p.oid, 'EXECUTE')
      and not has_function_privilege('authenticated', p.oid, 'EXECUTE')),
  array['edge_activate_device', 'edge_badge_device', 'edge_redeem_badge_step'],
  'device activation and badge redemption are callable only by the Edge Functions (service_role)'
);

select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'app_private') and p.prosecdef
      and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')),
  0, 'every SECURITY DEFINER function pins search_path'
);

select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and has_function_privilege('authenticated', p.oid, 'EXECUTE')
      and p.proname in ('write_audit', 'resolve_upload_credential', 'ensure_raw_fix_partitions',
                        'purge_expired_raw_fixes', 'forbid_mutation', 'protect_last_owner',
                        'consume_rate_limit', 'build_settings', 'normalize_work_windows', 'tracking_defaults',
                        'deployment_environment', 'current_notice', 'assert_notice_acceptable',
                        'orientation_code_session', 'session_json', 'close_session_internal',
                        'resolve_join_company', 'record_orientation', 'replace_emergency_contact')),
  0, 'privileged internal functions are not executable by clients'
);

select * from finish();
rollback;
