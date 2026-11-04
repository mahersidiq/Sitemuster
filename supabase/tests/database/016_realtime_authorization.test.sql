-- Private Realtime Broadcast authorization (decision #19): receive-only for project staff (MFA)
-- who may read the whole roster; never foremen (the project topic carries every company's counts,
-- decision #104), workers, outsiders or operators.
begin;
select plan(13);
select tests.seed_world();

select is(app_private.project_id_from_topic('project:' || tests.id('p_a1')::text), tests.id('p_a1'), 'topic parser extracts the project id');
select is(app_private.project_id_from_topic('project:not-a-uuid'), null, 'malformed topic yields no project');
select is(app_private.project_id_from_topic('projects:' || tests.id('p_a1')::text), null, 'wrong topic prefix yields no project');
select is(app_private.project_id_from_topic('project:' || upper(tests.id('p_a1')::text)), null, 'non-canonical topic yields no project');

select isnt_empty(
  $$select 1 from pg_policies where schemaname = 'realtime' and tablename = 'messages' and policyname = 'project_broadcast_receive' and cmd = 'SELECT' and roles = '{authenticated}'$$,
  'receive policy exists on realtime.messages');
select is_empty(
  $$select 1 from pg_policies where schemaname = 'realtime' and tablename = 'messages' and cmd in ('INSERT', 'ALL') and policyname = 'project_broadcast_receive'$$,
  'clients get no send policy from SiteMuster');

select tests.authenticate_as(tests.id('u_a_super'));
select ok(app_private.can_receive_project_broadcast(tests.id('p_a1')), 'GC A super may receive project A1 broadcasts');
select ok(not app_private.can_receive_project_broadcast(tests.id('p_b1')), 'GC A super may not receive project B1 broadcasts');
select tests.authenticate_as(tests.id('u_a_super'), 'aal1');
select ok(not app_private.can_receive_project_broadcast(tests.id('p_a1')), 'staff without MFA may not receive');
select tests.authenticate_as(tests.id('u_foreman_a'), 'aal1');
select ok(not app_private.can_receive_project_broadcast(tests.id('p_a1')), 'a verified foreman does not receive the project-wide topic (decision #104)');
select tests.authenticate_as(tests.id('u_worker_a1'), 'aal1');
select ok(not app_private.can_receive_project_broadcast(tests.id('p_a1')), 'plain workers do not join the workforce channel');
select tests.authenticate_as(tests.id('u_operator'));
select ok(not app_private.can_receive_project_broadcast(tests.id('p_a1')), 'platform operator may not receive');
select ok(not app_private.can_receive_project_broadcast(null), 'no project, no access');

select tests.as_postgres();
select * from finish();
rollback;
