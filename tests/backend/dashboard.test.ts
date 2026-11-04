import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import type { BroadcastMessage } from '@sitemuster/shared';

import { subscribeProjectChannel } from '../../src/api/supabase-api';
import type { ChannelStatus, ProjectDashboard } from '../../src/api/types';
import { ProjectLiveSync, type LiveState } from '../../src/realtime/live-sync';
import { withDb } from './support/db';
import {
  enroll,
  minutesAgo,
  post,
  results,
  scalar,
  site,
  userIdOf,
  workerSession,
} from './support/operations';
import { staffClient } from './support/staff';

/**
 * Milestone 09 acceptance on the real local stack (Auth, PostgREST, Postgres, Realtime, Edge
 * runtime): the dashboard counts match the sessions, a resent crew batch adds no one, the private
 * project channel reaches project staff with ids and counts only, GC B is refused the channel and
 * the worker map, and the production live sync refetches everything after the channel returns.
 */

async function waitFor(check: () => boolean, label: string, timeoutMs = 15_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function dashboard(client: SupabaseClient, projectId: string): Promise<ProjectDashboard> {
  const { data, error } = await client.rpc('project_dashboard', { p_project_id: projectId });
  expect(error).toBeNull();
  return data as ProjectDashboard;
}

/** A project with one company, `size` approved crew workers and a verified foreman. */
async function crewSite(size: number) {
  const { projectId, companyId } = await site();
  const crew: string[] = [];
  for (let i = 0; i < size; i += 1) {
    crew.push(await enroll(projectId, { companyId, name: `Crew Member ${i + 1}` }));
  }
  const foreman = await workerSession();
  const foremanProfile = await enroll(projectId, {
    userId: foreman.userId,
    companyId,
    name: 'Fran Foreman',
  });
  await withDb((db) =>
    db.query(
      "update public.subcontractor_members set role = 'FOREMAN' where company_id = $1 and worker_profile_id = $2",
      [companyId, foremanProfile],
    ),
  );
  return { projectId, companyId, crew, foreman };
}

async function assignStaff(client: SupabaseClient, projectId: string, role: string) {
  const userId = await userIdOf(client);
  await withDb((db) =>
    db.query(
      'insert into public.project_staff (project_id, user_id, role, emergency_designated) values ($1, $2, $3, false)',
      [projectId, userId, role],
    ),
  );
}

const crewBatch = (
  projectId: string,
  companyId: string,
  workers: string[],
  direction: 'ENTRY' | 'EXIT' = 'ENTRY',
  minutes = 5,
) => ({
  event_uuid: crypto.randomUUID(),
  project_id: projectId,
  operation_type: direction === 'ENTRY' ? 'FOREMAN_BULK_ENTRY' : 'FOREMAN_BULK_EXIT',
  observed_at: minutesAgo(minutes).toISOString(),
  payload: {
    subcontractor_id: companyId,
    worker_ids: workers,
    direction,
    verification_method: 'PHYSICAL_CONFIRMATION',
  },
});

const openSessions = (projectId: string) =>
  scalar<number>(
    "select count(*)::int as v from public.attendance_sessions where project_id = $1 and status = 'OPEN'",
    [projectId],
  );

describe('superintendent dashboard and live updates (local stack)', () => {
  it('counts match the sessions; a resent crew batch adds no one; the roster shows the source', async () => {
    const { projectId, companyId, crew, foreman } = await crewSite(4);
    const superintendent = await staffClient();
    await assignStaff(superintendent.client, projectId, 'SUPER');

    const batch = crewBatch(projectId, companyId, crew.slice(0, 3));
    expect(results((await post(foreman.jwt, [batch])).body)[0]?.status).toBe('accepted');
    const first = await dashboard(superintendent.client, projectId);
    expect(first.counts.estimated_onsite).toBe(3);
    expect(first.counts.estimated_onsite).toBe(await openSessions(projectId));
    expect(first.counts.onsite_by_source).toEqual({ FOREMAN: 3 });
    expect(first.counts.manually_verified).toBe(3);
    expect(first.counts.approved_roster).toBe(5);
    expect(first.companies).toEqual([
      expect.objectContaining({ company_name: 'Crew Concrete', approved: 5, estimated_onsite: 3 }),
    ]);

    // The same operation again (a lost answer, then the outbox resends): nobody is added.
    expect(results((await post(foreman.jwt, [batch])).body)[0]?.status).toBe('duplicate');
    const again = await dashboard(superintendent.client, projectId);
    expect(again.counts.estimated_onsite).toBe(3);
    expect(await openSessions(projectId)).toBe(3);

    const { data: roster } = await superintendent.client.rpc('workforce_roster', {
      p_project_id: projectId,
    });
    const rows = roster as { legal_name: string; counted: boolean; source: string | null }[];
    expect(rows.filter((r) => r.counted).map((r) => r.source)).toEqual([
      'FOREMAN',
      'FOREMAN',
      'FOREMAN',
    ]);
    expect(rows).toHaveLength(5);
    expect(JSON.stringify(rows)).not.toMatch(/phone|"lat|"lng|emergency/);
  });

  it('the private channel reaches project staff with ids and counts only; GC B is refused it and the map', async () => {
    const { projectId, companyId, crew, foreman } = await crewSite(3);
    const superintendent = await staffClient();
    await assignStaff(superintendent.client, projectId, 'SUPER');
    const other = await site();
    const outsider = await staffClient();
    await assignStaff(outsider.client, other.projectId, 'SUPER');

    const received: BroadcastMessage[] = [];
    const statuses: ChannelStatus[] = [];
    const stop = subscribeProjectChannel(superintendent.client, projectId, {
      onMessage: (message) => received.push(message),
      onStatus: (status) => statuses.push(status),
    });
    const outsiderReceived: BroadcastMessage[] = [];
    const outsiderStatuses: ChannelStatus[] = [];
    const stopOutsider = subscribeProjectChannel(outsider.client, projectId, {
      onMessage: (message) => outsiderReceived.push(message),
      onStatus: (status) => outsiderStatuses.push(status),
    });
    try {
      await waitFor(() => statuses.includes('SUBSCRIBED'), 'the superintendent to join');
      await waitFor(() => outsiderStatuses.includes('DENIED'), 'GC B to be refused');

      expect(
        results((await post(foreman.jwt, [crewBatch(projectId, companyId, crew)])).body)[0]?.status,
      ).toBe('accepted');
      await waitFor(
        () => received.some((m) => m.counts.estimated_onsite === 3),
        'a message with the new count',
      );
      const last = received.at(-1) as BroadcastMessage;
      expect(last).toMatchObject({ type: 'WORKFORCE_CHANGED', project_id: projectId });
      expect(JSON.stringify(received)).not.toMatch(/Crew Member|Fran|"lat|"lng|phone/);
      expect(outsiderReceived).toHaveLength(0);

      // GC B cannot read project A's worker map; the superintendent can.
      const denied = await outsider.client.rpc('project_map', { p_project_id: projectId });
      expect(denied.error?.message).toBe('FORBIDDEN');
      await withDb((db) =>
        db.query(
          `insert into public.latest_onsite_positions (project_id, worker_id, position, horizontal_accuracy_m, observed_at, expiry_at)
           values ($1, $2, extensions.st_setsrid(extensions.st_makepoint(-95.36012, 29.75004), 4326)::extensions.geography, 18,
                   now() - interval '1 minute', now() + interval '19 minutes')`,
          [projectId, crew[0]],
        ),
      );
      const map = await superintendent.client.rpc('project_map', { p_project_id: projectId });
      expect(map.error).toBeNull();
      expect((map.data as { markers: unknown[] }).markers).toEqual([
        expect.objectContaining({
          legal_name: 'Crew Member 1',
          lat: 29.75,
          lng: -95.3601,
          accuracy_m: 18,
          fresh: true,
        }),
      ]);
    } finally {
      stop();
      stopOutsider();
    }
  });

  it('an immediate re-join on the same client gets its own channel and reaches SUBSCRIBED', async () => {
    const { projectId } = await site();
    const superintendent = await staffClient();
    await assignStaff(superintendent.client, projectId, 'SUPER');
    const first: ChannelStatus[] = [];
    const stopFirst = subscribeProjectChannel(superintendent.client, projectId, {
      onMessage: () => undefined,
      onStatus: (status) => first.push(status),
    });
    await waitFor(() => first.includes('SUBSCRIBED'), 'the first join');
    // Re-join at once (what the sync does after a drop): the old channel is still being removed.
    stopFirst();
    const second: ChannelStatus[] = [];
    const stopSecond = subscribeProjectChannel(superintendent.client, projectId, {
      onMessage: () => undefined,
      onStatus: (status) => second.push(status),
    });
    try {
      await waitFor(() => second.includes('SUBSCRIBED'), 'the second join');
      expect(second).not.toContain('DISCONNECTED');
    } finally {
      stopSecond();
    }
  });

  it('a second simultaneous subscription on one client reports DISCONNECTED instead of hanging', async () => {
    // The app keeps ONE live provider (decision #106); this guards the transport if that breaks:
    // supabase-js would hand back the first channel object and the second caller would never hear
    // a status, staying "connecting" forever.
    const { projectId } = await site();
    const superintendent = await staffClient();
    await assignStaff(superintendent.client, projectId, 'SUPER');
    const first: ChannelStatus[] = [];
    const second: ChannelStatus[] = [];
    const stopFirst = subscribeProjectChannel(superintendent.client, projectId, {
      onMessage: () => undefined,
      onStatus: (status) => first.push(status),
    });
    let stopSecond = () => undefined as void;
    try {
      await waitFor(() => first.includes('SUBSCRIBED'), 'the first join');
      stopSecond = subscribeProjectChannel(superintendent.client, projectId, {
        onMessage: () => undefined,
        onStatus: (status) => second.push(status),
      });
      await waitFor(() => second.includes('DISCONNECTED'), 'the second subscription to be told');
      expect(first).toEqual(['SUBSCRIBED']);
    } finally {
      stopSecond();
      stopFirst();
    }
  });

  it('the production live sync refetches everything after the channel comes back (missed message)', async () => {
    const { projectId, companyId, crew, foreman } = await crewSite(3);
    const superintendent = await staffClient();
    await assignStaff(superintendent.client, projectId, 'SUPER');
    expect(
      results((await post(foreman.jwt, [crewBatch(projectId, companyId, crew)])).body)[0]?.status,
    ).toBe('accepted');

    const states: LiveState[] = [];
    const seen: number[] = [];
    let refreshes = 0;
    const sync = new ProjectLiveSync(projectId, {
      subscribe: (id, listener) => subscribeProjectChannel(superintendent.client, id, listener),
      refresh: () => {
        refreshes += 1;
        void dashboard(superintendent.client, projectId).then((d) =>
          seen.push(d.counts.estimated_onsite),
        );
      },
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    });
    sync.onState((state) => states.push(state));
    sync.start();
    try {
      await waitFor(() => sync.status === 'LIVE' && seen.includes(3), 'live with 3 on site');

      // The phone loses its connection; a worker leaves while nobody is listening.
      superintendent.client.realtime.disconnect();
      await waitFor(() => sync.status === 'PAUSED', 'the sync to pause');
      const before = refreshes;
      expect(
        results(
          (
            await post(foreman.jwt, [
              crewBatch(projectId, companyId, [crew[0] as string], 'EXIT', 1),
            ])
          ).body,
        )[0]?.status,
      ).toBe('accepted');

      // The channel comes back (re-joined by the sync): everything is refetched, nothing missed.
      await waitFor(
        () => sync.status === 'LIVE' && refreshes > before && seen.at(-1) === 2,
        'the resync',
        25_000,
      );
      expect(states).toEqual(expect.arrayContaining(['LIVE', 'PAUSED']));
      expect(await openSessions(projectId)).toBe(2);
    } finally {
      sync.stop();
    }
  }, 40_000);
});
