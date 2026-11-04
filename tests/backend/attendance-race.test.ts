import { Client } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

import { configFromSettings, type Evidence, reconcile } from '@sitemuster/shared';

import { backendEnv } from './support/env';
import { PgReplayBackend } from './support/replay-pg-backend';

/**
 * Duplicate race (Milestone 06 acceptance): the same batch reaches the server twice at the same
 * moment (an SDK retry while the first request is still running). Two database connections run the
 * production reconciler concurrently: the track is serialized by the commit's advisory lock and
 * optimistic revision, the loser reloads, sees the event uuids as duplicates, and exactly one
 * session exists. Each call commits on its own, exactly like PostgREST.
 */
const clients: Client[] = [];
async function connect() {
  const client = new Client({ connectionString: backendEnv().dbUrl });
  await client.connect();
  clients.push(client);
  return client;
}

describe('reconciler under concurrency (real database)', () => {
  afterAll(async () => {
    await Promise.all(clients.map((client) => client.end()));
  });

  it('applies a batch sent twice at the same time exactly once', async () => {
    const seed = `race-${crypto.randomUUID()}`;
    const first = new PgReplayBackend(await connect(), seed, false);
    await first.begin();
    const projectId = crypto.randomUUID();
    const workerId = crypto.randomUUID();
    const deviceId = crypto.randomUUID();
    await first.createProject(
      { id: projectId, status: 'ACTIVE', timezone: 'America/Chicago' },
      configFromSettings({
        configVersionId: crypto.randomUUID(),
        projectId,
        versionNumber: 1,
        effectiveAt: '2026-01-01T00:00:00Z',
        settings: {
          work_windows: [1, 2, 3, 4, 5, 6].map((weekday) => ({
            weekday,
            local_start_time: '06:00',
            local_end_time: '18:00',
          })),
        },
        center: { lat: 29.7604, lng: -95.3698 },
      }),
    );
    await first.enrollWorker(projectId, workerId, { eligible: true, reason: null });
    await first.registerDevice(deviceId, workerId);
    const second = first.sharing(await connect());

    const fix = (minute: number): Evidence => ({
      kind: 'FIX',
      eventUuid: crypto.randomUUID(),
      projectId,
      workerId,
      deviceId,
      observedAt: `2026-11-03T12:${String(minute).padStart(2, '0')}:00Z`,
      receivedAt: '2026-11-03T12:12:00Z',
      lat: 29.7604,
      lng: -95.3698,
      accuracyM: 10,
      mock: false,
      ambiguous: false,
    });
    const batch = [fix(1), fix(11)];
    const [a, b] = await Promise.all([
      reconcile(first.store, batch, '2026-11-03T12:12:00Z'),
      reconcile(second.store, batch, '2026-11-03T12:12:00Z'),
    ]);
    const statuses = batch.map((item) =>
      [a.get(item.eventUuid)?.status, b.get(item.eventUuid)?.status].sort().join('/'),
    );
    expect(statuses).toEqual(['accepted/duplicate', 'accepted/duplicate']);
    const snapshot = await first.snapshot(projectId);
    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.sessions[0]).toMatchObject({ status: 'OPEN' });
    expect(Date.parse(snapshot.sessions[0]?.startAt ?? '')).toBe(
      Date.parse('2026-11-03T12:01:00Z'),
    );
    expect(snapshot.receipts).toBe(2);
  });
});
