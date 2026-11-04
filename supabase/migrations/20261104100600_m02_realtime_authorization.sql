-- Milestone 02 · Private Realtime Broadcast authorization groundwork (decision #19).
-- Clients may only RECEIVE broadcasts on `project:{uuid}` topics for projects they are staff of
-- (with MFA) or explicitly permitted company members (verified foremen) of. No client may send:
-- invalidation messages are emitted server-side (Milestone 09) with only IDs/aggregate counts.

create policy project_broadcast_receive on realtime.messages
  for select to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and app_private.can_receive_project_broadcast(app_private.project_id_from_topic((select realtime.topic())))
  );
