-- Milestone 09: the superintendent dashboard, workforce roster, map and private Broadcast.
-- Counts match the sessions (live staleness, witnessed evidence), stale markers are labelled,
-- expired markers are gone, only location roles see the map, GC B and foremen are refused, and a
-- transaction sends ONE minimal message per project and type at commit (no names or positions).
begin;
select plan(42);
select tests.seed_world();

select set_config('t.p', tests.id('p_a1')::text, false), set_config('t.pb', tests.id('p_b1')::text, false),
       set_config('t.cv', tests.id('cv_a1')::text, false),
       set_config('t.midnight', ((date_trunc('day', now() at time zone 'America/Chicago')) at time zone 'America/Chicago')::text, false);

-- ---------------------------------------------------------------------------------------------
-- Scenario on project A (Chicago), relative to now():
--   Ana (w_a1)      GPS session, evidence 2 min old            → counted, fresh marker
--   Ben (w_a2)      foreman-witnessed session, evidence 1 h old → counted (witnessed), stale marker
--   Diego (managed) GPS session, evidence 30 min old            → presence unknown, expired marker
--   Fernando (w_fa) came and left today                         → not on site
-- ---------------------------------------------------------------------------------------------
update public.worker_enrollments set trade = 'Concrete' where id in (tests.id('e_a1'), tests.id('e_a2'));
update public.worker_enrollments set trade = 'Labor' where id = tests.id('e_managed');
update public.attendance_sessions set last_seen_at = now() - interval '2 minutes' where id = tests.id('s_a1');
update public.presence_states set current_session_id = tests.id('s_a1'), last_seen_at = now() - interval '2 minutes'
 where project_id = tests.id('p_a1') and worker_id = tests.id('w_a1');
insert into public.attendance_sessions (id, project_id, worker_id, employer_snapshot_id, start_at, start_source, config_version_id,
                                        status, iana_timezone, last_seen_at, witnessed) values
  ('7a000000-0000-4000-8000-0000000000a2'::uuid, tests.id('p_a1'), tests.id('w_a2'), tests.id('c_a'), current_setting('t.midnight')::timestamptz + interval '1 second',
   'FOREMAN', tests.id('cv_a1'), 'OPEN', 'America/Chicago', now() - interval '1 hour', true),
  ('7a000000-0000-4000-8000-0000000000a3'::uuid, tests.id('p_a1'), tests.id('w_managed'), tests.id('c_a'), current_setting('t.midnight')::timestamptz + interval '2 seconds',
   'GEOFENCE', tests.id('cv_a1'), 'OPEN', 'America/Chicago', now() - interval '30 minutes', false);
insert into public.attendance_sessions (id, project_id, worker_id, employer_snapshot_id, start_at, end_at, start_source, end_source,
                                        config_version_id, status, iana_timezone, last_seen_at, witnessed) values
  ('7a000000-0000-4000-8000-0000000000a4'::uuid, tests.id('p_a1'), tests.id('w_fa'), tests.id('c_a'), current_setting('t.midnight')::timestamptz + interval '3 seconds',
   current_setting('t.midnight')::timestamptz + interval '4 seconds', 'KIOSK_DYNAMIC_BADGE', 'KIOSK_DYNAMIC_BADGE',
   tests.id('cv_a1'), 'CLOSED', 'America/Chicago', current_setting('t.midnight')::timestamptz + interval '4 seconds', true);
insert into public.presence_states (project_id, worker_id, presence_state, last_seen_at, confidence, config_version_id, current_session_id) values
  (tests.id('p_a1'), tests.id('w_a2'), 'ONSITE_ESTIMATED', now() - interval '1 hour', 'HIGH', tests.id('cv_a1'), '7a000000-0000-4000-8000-0000000000a2'::uuid),
  (tests.id('p_a1'), tests.id('w_managed'), 'ONSITE_ESTIMATED', now() - interval '30 minutes', 'MEDIUM', tests.id('cv_a1'), '7a000000-0000-4000-8000-0000000000a3'::uuid);
delete from public.latest_onsite_positions where project_id = tests.id('p_a1');
insert into public.latest_onsite_positions (project_id, worker_id, position, horizontal_accuracy_m, observed_at, expiry_at) values
  (tests.id('p_a1'), tests.id('w_a1'), extensions.st_setsrid(extensions.st_makepoint(-95.369712, 29.760534), 4326)::extensions.geography,
   12.4, now() - interval '2 minutes', now() + interval '18 minutes'),
  (tests.id('p_a1'), tests.id('w_a2'), extensions.st_setsrid(extensions.st_makepoint(-95.3699, 29.7603), 4326)::extensions.geography,
   20, now() - interval '15 minutes', now() + interval '5 minutes'),
  (tests.id('p_a1'), tests.id('w_managed'), extensions.st_setsrid(extensions.st_makepoint(-95.3698, 29.7604), 4326)::extensions.geography,
   30, now() - interval '25 minutes', now() - interval '5 minutes');
update public.latest_onsite_positions set observed_at = now() - interval '1 minute', expiry_at = now() + interval '19 minutes'
 where project_id = tests.id('p_b1');
-- Send what the setup queued, so the Broadcast checks below see only their own changes.
set constraints all immediate;
set constraints all deferred;

-- ---------------------------------------------------------------------------------------------
-- Dashboard
-- ---------------------------------------------------------------------------------------------
select tests.authenticate_as(tests.id('u_a_super'));
select set_config('t.dash', public.project_dashboard(current_setting('t.p')::uuid)::text, false);
select is((current_setting('t.dash')::jsonb -> 'counts') - 'evaluated_at' - 'onsite_by_source',
  jsonb_build_object('approved_roster', 4, 'estimated_onsite', 2, 'manually_verified', 1, 'presence_unknown', 1,
                     'arriving', 0, 'unscheduled_pending', 0, 'departure_pending', 0, 'unresolved_sessions', 0,
                     'visitors_onsite', 1, 'visitors_unresolved', 0),
  'counts: GPS + witnessed on site, a stale GPS worker is unknown (not gone), the visitor is separate');
select is(current_setting('t.dash')::jsonb -> 'counts' -> 'onsite_by_source', '{"FOREMAN": 1, "GEOFENCE": 1}'::jsonb,
  'on-site breakdown by source');
select is((current_setting('t.dash')::jsonb -> 'counts') - 'evaluated_at',
  public.attendance_counts(current_setting('t.p')::uuid) - 'evaluated_at',
  'the dashboard counts are exactly attendance_counts');
select is((current_setting('t.dash')::jsonb -> 'today') - 'local_date', '{"arrivals": 3, "departures": 1}'::jsonb,
  'today (project time zone): three arrivals and one departure');
select is(current_setting('t.dash')::jsonb -> 'companies',
  jsonb_build_array(jsonb_build_object('company_id', tests.id('c_a'), 'company_name', 'Acme Concrete', 'approved', 4,
                                       'estimated_onsite', 2, 'manually_verified', 1, 'presence_unknown', 1)),
  'per company: approved, on site, witnessed and unknown');
select is(current_setting('t.dash')::jsonb -> 'trades',
  '[{"trade": "Concrete", "approved": 2, "estimated_onsite": 2}, {"trade": "Labor", "approved": 1, "estimated_onsite": 0},
    {"trade": null, "approved": 1, "estimated_onsite": 0}]'::jsonb,
  'per trade, busiest first, no trade last');
select is(current_setting('t.dash')::jsonb -> 'approvals', '{"pending_enrollments": 0, "employer_pending": 0}'::jsonb,
  'approval queue counts');
select is((current_setting('t.dash')::jsonb ->> 'can_view_map')::boolean, true, 'a superintendent may open the map');

-- A duplicate (the same event recorded twice) never adds a person: counts are per worker.
select tests.as_postgres();
update public.attendance_sessions set last_seen_at = now() - interval '1 minute' where id = tests.id('s_a1');
update public.attendance_sessions set last_seen_at = now() - interval '1 minute' where id = tests.id('s_a1');
select tests.authenticate_as(tests.id('u_a_super'));
select is((public.project_dashboard(current_setting('t.p')::uuid) -> 'counts' ->> 'estimated_onsite')::int, 2,
  'repeated evidence for the same worker does not change the count');

select tests.authenticate_as(tests.id('u_a_attendant'));
select is((public.project_dashboard(current_setting('t.p')::uuid) ->> 'can_view_map')::boolean, false,
  'a kiosk attendant sees counts but not the map');
select tests.authenticate_as(tests.id('u_b_super'));
select throws_ok($$ select public.project_dashboard(current_setting('t.p')::uuid) $$, '42501', 'FORBIDDEN',
  'GC B cannot read project A''s dashboard');
select tests.authenticate_as(tests.id('u_a_super'), 'aal1');
select throws_ok($$ select public.project_dashboard(current_setting('t.p')::uuid) $$, '42501', 'FORBIDDEN',
  'staff without MFA cannot read the dashboard');
select tests.authenticate_as(tests.id('u_foreman_a'), 'aal1');
select throws_ok($$ select public.project_dashboard(current_setting('t.p')::uuid) $$, '42501', 'FORBIDDEN',
  'a foreman cannot read the project-wide dashboard');
select tests.authenticate_as(tests.id('u_worker_a1'), 'aal1');
select throws_ok($$ select public.project_dashboard(current_setting('t.p')::uuid) $$, '42501', 'FORBIDDEN',
  'a worker cannot read the dashboard');

-- ---------------------------------------------------------------------------------------------
-- Workforce roster
-- ---------------------------------------------------------------------------------------------
select tests.authenticate_as(tests.id('u_a_super'));
select set_config('t.roster', public.workforce_roster(current_setting('t.p')::uuid)::text, false);
select is((select jsonb_agg(jsonb_build_object('name', x ->> 'legal_name', 'presence', x ->> 'presence', 'counted', (x ->> 'counted')::boolean,
                                               'source', x ->> 'source', 'tracking', x ->> 'tracking'))
             from jsonb_array_elements(current_setting('t.roster')::jsonb) x),
  '[{"name": "Ana Acosta", "presence": "ONSITE_ESTIMATED", "counted": true, "source": "GEOFENCE", "tracking": "CREDENTIAL_EXPIRED"},
    {"name": "Ben Avila", "presence": "ONSITE_ESTIMATED", "counted": true, "source": "FOREMAN", "tracking": "NO_PHONE"},
    {"name": "Diego No-Phone", "presence": "PRESENCE_UNKNOWN", "counted": false, "source": "GEOFENCE", "tracking": "NO_PHONE"},
    {"name": "Fernando Alvarez", "presence": "NONE", "counted": false, "source": null, "tracking": "NO_PHONE"}]'::jsonb,
  'roster: counted first; stale GPS shows unknown; source and tracking health per worker');
select is((select x ->> 'witnessed' from jsonb_array_elements(current_setting('t.roster')::jsonb) x where x ->> 'legal_name' = 'Ben Avila'),
  'true', 'witnessed evidence is marked');
select ok(current_setting('t.roster') !~ '(phone"|"lat|"lng|emergency|\+1555)',
  'the roster carries no phone numbers, emergency contacts or positions');
-- The phone's upload credential decides the tracking flag (spec 03: expiring at <= 3 days).
select tests.as_postgres();
insert into app_private.device_upload_credentials (device_id, token_sha256, created_at, expires_at)
values (tests.id('d_a1'), decode(repeat('ab', 32), 'hex'), now() - interval '28 days', now() + interval '2 days');
select tests.authenticate_as(tests.id('u_a_super'));
select is((select x ->> 'tracking' from jsonb_array_elements(public.workforce_roster(current_setting('t.p')::uuid)) x
            where x ->> 'legal_name' = 'Ana Acosta'), 'CREDENTIAL_EXPIRING',
  'a credential with two days left is flagged CREDENTIAL_EXPIRING');
select tests.authenticate_as(tests.id('u_b_super'));
select throws_ok($$ select public.workforce_roster(current_setting('t.p')::uuid) $$, '42501', 'FORBIDDEN',
  'GC B cannot read project A''s roster');
select tests.authenticate_as(tests.id('u_foreman_a'), 'aal1');
select throws_ok($$ select public.workforce_roster(current_setting('t.p')::uuid) $$, '42501', 'FORBIDDEN',
  'a foreman cannot read the whole-project roster');

-- ---------------------------------------------------------------------------------------------
-- Map: location roles only; fresh vs stale; expired markers gone; rounded positions
-- ---------------------------------------------------------------------------------------------
select tests.authenticate_as(tests.id('u_a_super'));
select set_config('t.map', public.project_map(current_setting('t.p')::uuid)::text, false);
select is((select jsonb_agg(jsonb_build_object('name', x ->> 'legal_name', 'fresh', (x ->> 'fresh')::boolean, 'accuracy', (x ->> 'accuracy_m')::numeric))
             from jsonb_array_elements(current_setting('t.map')::jsonb -> 'markers') x),
  '[{"name": "Ana Acosta", "fresh": true, "accuracy": 12}, {"name": "Ben Avila", "fresh": false, "accuracy": 20}]'::jsonb,
  'markers: newest first, the 15-minute-old one labelled stale, the expired one gone');
select is((select jsonb_build_object('lat', x -> 'lat', 'lng', x -> 'lng') from jsonb_array_elements(current_setting('t.map')::jsonb -> 'markers') x
            where x ->> 'legal_name' = 'Ana Acosta'), '{"lat": 29.7605, "lng": -95.3697}'::jsonb,
  'positions are rounded to about 11 m');
select ok((select bool_and(x ? 'observed_at' and x ? 'accuracy_m') from jsonb_array_elements(current_setting('t.map')::jsonb -> 'markers') x),
  'every marker has its time and accuracy');
select is((current_setting('t.map')::jsonb -> 'site' ->> 'radius_m')::numeric, 150::numeric, 'the site circle comes with the markers');
select is((current_setting('t.map')::jsonb ->> 'fresh_seconds')::numeric, 600::numeric, 'markers are fresh for 10 minutes');
select ok(current_setting('t.map') !~ 'Bolt|-74\.00', 'no marker from project B');
select tests.authenticate_as(tests.id('u_a_safety'));
select is(jsonb_array_length(public.project_map(current_setting('t.p')::uuid) -> 'markers'), 2, 'the safety manager sees the map');
select tests.authenticate_as(tests.id('u_a_attendant'));
select throws_ok($$ select public.project_map(current_setting('t.p')::uuid) $$, '42501', 'FORBIDDEN',
  'a kiosk attendant cannot see worker positions');
select tests.authenticate_as(tests.id('u_b_super'));
select throws_ok($$ select public.project_map(current_setting('t.p')::uuid) $$, '42501', 'FORBIDDEN',
  'GC B is denied project A''s worker map');
select tests.authenticate_as(tests.id('u_foreman_a'), 'aal1');
select throws_ok($$ select public.project_map(current_setting('t.p')::uuid) $$, '42501', 'FORBIDDEN',
  'a foreman cannot see the project map');
select tests.authenticate_as(tests.id('u_operator'));
select throws_ok($$ select public.project_map(current_setting('t.p')::uuid) $$, '42501', 'FORBIDDEN',
  'the platform operator never sees positions');
select tests.authenticate_as(tests.id('u_a_super'), 'aal1');
select throws_ok($$ select public.project_map(current_setting('t.p')::uuid) $$, '42501', 'FORBIDDEN',
  'no MFA, no map');

-- ---------------------------------------------------------------------------------------------
-- Private Broadcast: one message per transaction, project and type, at commit
-- ---------------------------------------------------------------------------------------------
select tests.as_postgres();
create temp table seen_messages on commit drop as select id from realtime.messages;
update public.presence_states set last_seen_at = now() where project_id = tests.id('p_a1') and worker_id = tests.id('w_a1');
update public.attendance_sessions set last_seen_at = now() where id = tests.id('s_a1');
update public.attendance_sessions set last_seen_at = now() - interval '1 hour' where id = '7a000000-0000-4000-8000-0000000000a2'::uuid;
select is((select count(*)::int from realtime.messages where id not in (select id from seen_messages)), 0,
  'nothing is sent before commit');
set constraints all immediate;
set constraints all deferred;
select set_config('t.msgs', (select coalesce(jsonb_agg(jsonb_build_object('topic', topic, 'event', event, 'private', private,
                                                                          'payload', payload)), '[]')::text
                               from realtime.messages where id not in (select id from seen_messages)), false);
select is(jsonb_array_length(current_setting('t.msgs')::jsonb), 1, 'three workforce changes in one transaction send ONE message');
select is((select jsonb_build_object('topic', x ->> 'topic', 'event', x ->> 'event', 'private', (x ->> 'private')::boolean)
             from jsonb_array_elements(current_setting('t.msgs')::jsonb) x),
  jsonb_build_object('topic', 'project:' || tests.id('p_a1'), 'event', 'WORKFORCE_CHANGED', 'private', true),
  'on the private project topic, as WORKFORCE_CHANGED');
select is((select array_agg(k order by k) from jsonb_array_elements(current_setting('t.msgs')::jsonb) x, jsonb_object_keys(x -> 'payload') k),
  array['aggregate_version', 'changed_ids', 'counts', 'id', 'occurred_at', 'project_id', 'schema_version', 'type'],
  'the payload has exactly the contract keys (plus the transport id)');
select is((select x -> 'payload' -> 'counts' from jsonb_array_elements(current_setting('t.msgs')::jsonb) x),
  '{"estimated_onsite": 2, "presence_unknown": 1, "approved_roster": 4, "visitors_onsite": 1}'::jsonb,
  'the message counts match the database counts');
select is((select (select array_agg(v order by v) from jsonb_array_elements_text(x -> 'payload' -> 'changed_ids') v)
             from jsonb_array_elements(current_setting('t.msgs')::jsonb) x),
  (select array_agg(v::text order by v::text) from unnest(array[tests.id('w_a1'), tests.id('w_a2')]) v),
  'changed ids are the changed workers, once each');
select ok(current_setting('t.msgs') !~ '(Acosta|Avila|29\.76|-95\.36|phone)', 'no names or positions in the message');

-- Enrollment and project changes send their own types; project B's change stays on B's topic.
truncate seen_messages;
insert into seen_messages select id from realtime.messages;
update public.worker_enrollments set trade = 'Rebar' where id = tests.id('e_a1');
update public.projects set name = 'Alpha Tower North' where id = tests.id('p_a1');
update public.presence_states set last_seen_at = now() where project_id = tests.id('p_b1');
set constraints all immediate;
select is((select array_agg(event || ' ' || replace(topic, tests.id('p_b1')::text, 'B') order by event)
             from realtime.messages
            where id not in (select id from seen_messages)
              and (topic = 'project:' || tests.id('p_a1') or topic = 'project:' || tests.id('p_b1'))),
  array['ENROLLMENT_CHANGED project:' || tests.id('p_a1'), 'PROJECT_CONFIG_CHANGED project:' || tests.id('p_a1'),
        'WORKFORCE_CHANGED project:B'],
  'each type is its own message, and project B''s change is sent only on B''s topic');

-- Who may receive: roster staff (including attendants) yes; foremen, GC B and workers no.
select tests.authenticate_as(tests.id('u_a_attendant'));
select ok(app_private.can_receive_project_broadcast(tests.id('p_a1')), 'an attendant of project A may receive its topic');
select tests.authenticate_as(tests.id('u_b_super'));
select ok(not app_private.can_receive_project_broadcast(tests.id('p_a1')), 'GC B may not receive project A''s topic');

select * from finish();
rollback;
