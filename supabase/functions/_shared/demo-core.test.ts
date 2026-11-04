import { describe, expect, it } from 'vitest';

import { MemoryBackend } from '../../../tests/location-replay/harness/memory-backend.ts';
import {
  DEMO_ARRIVAL_SPAN_SECONDS,
  DemoSimulateResponseSchema,
} from '../../../packages/shared/src/api/demo.ts';
import { configFromSettings } from '../../../packages/shared/src/attendance/config.ts';
import type { DeviceFence } from '../../../packages/shared/src/attendance/normalize.ts';
import { containsCoordinateKeys } from '../../../packages/shared/src/privacy/coordinates.ts';
import {
  buildDemoRecords,
  type DemoContext,
  type DemoDeps,
  demoFence,
  demoPosition,
  DemoRpcError,
  handleDemoSimulate,
} from './demo-core.ts';

const PROJECT = '0d000000-0000-4000-8000-0000000000d1';
const WORKER = '4d000000-0000-4000-8000-0000000000d1';
const DEVICE = '5d000000-0000-4000-8000-0000000000d1';
const KEY = '6d000000-0000-4000-8000-0000000000d1';
const CENTER = { lat: 30.2672, lng: -97.7431 };
const NOW = Date.parse('2026-11-04T18:00:00Z');

const FENCE: DeviceFence = {
  projectId: PROJECT,
  configVersionId: `cv-${PROJECT}`,
  identifier: 'sm_demo_site',
  center: CENTER,
  nativeRadiusM: 200,
};

const deviceJson = (
  fences: (DeviceFence & { current: boolean })[] = [{ ...FENCE, current: true }],
) => ({
  status: 'OK',
  device_id: DEVICE,
  worker_id: WORKER,
  platform: 'IOS',
  coordinates_allowed: true,
  fences,
});

async function world(overrides: Partial<DemoDeps> = {}) {
  const backend = new MemoryBackend();
  await backend.createProject(
    { id: PROJECT, status: 'ACTIVE', timezone: 'America/Chicago' },
    configFromSettings({
      configVersionId: `cv-${PROJECT}`,
      projectId: PROJECT,
      versionNumber: 1,
      effectiveAt: '2026-01-01T00:00:00Z',
      settings: { operates_24_7: true },
      center: CENTER,
      radiusM: 150,
      exitHysteresisM: 50,
    }),
  );
  await backend.enrollWorker(PROJECT, WORKER, { eligible: true, reason: null });
  const begun: Parameters<DemoDeps['begin']>[0][] = [];
  let now = NOW;
  let lastEvidenceAt: string | null = null;
  const logs: Record<string, unknown>[] = [];
  const deps: DemoDeps = {
    now: () => now,
    begin: async (input): Promise<DemoContext> => {
      begun.push(input);
      return { deviceId: DEVICE, workerId: WORKER, projectId: PROJECT, lastEvidenceAt };
    },
    device: async () => deviceJson(),
    receipts: async (deviceId, uuids) => {
      const found = new Map<string, boolean>();
      for (const uuid of uuids) {
        const owner = backend.receiptDevice(uuid);
        if (owner) found.set(uuid, owner === deviceId);
      }
      return found;
    },
    recordTerminals: async (_requestId, rows) => {
      await backend.insertReceipts(rows);
    },
    store: backend.store,
    log: (entry) => logs.push(entry),
    ...overrides,
  };
  return {
    deps,
    backend,
    begun,
    logs,
    setNow: (value: number) => {
      now = value;
    },
    setLastEvidence: (value: string | null) => {
      lastEvidenceAt = value;
    },
  };
}

const request = (body: unknown, authorization: string | null = 'Bearer user-jwt') =>
  new Request('http://edge/demo-simulate', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(authorization ? { authorization } : {}),
    },
    body: JSON.stringify(body),
  });

const simulate = (action: 'ARRIVE' | 'LEAVE', key = KEY) => ({
  schema_version: 1,
  project_id: PROJECT,
  worker_id: WORKER,
  action,
  idempotency_key: key,
});

describe('demo records (built by the server)', () => {
  it('builds an arrival as a coordinate-free ENTER plus two inside fixes 10 minutes apart, ending now', () => {
    const plan = buildDemoRecords({
      action: 'ARRIVE',
      fence: FENCE,
      workerId: WORKER,
      idempotencyKey: KEY,
      nowMs: NOW,
      lastEvidenceAt: null,
    });
    expect('records' in plan).toBe(true);
    const records = (plan as { records: Record<string, unknown>[] }).records;
    expect(records.map((record) => record.event)).toEqual(['geofence', 'location', 'location']);
    expect(containsCoordinateKeys(records[0])).toBe(false);
    const times = records.map((record) => Date.parse(String(record.timestamp)));
    expect(times[2]).toBe(NOW);
    expect(((times[2] as number) - (times[1] as number)) / 1000).toBeGreaterThanOrEqual(600);
    expect(((times[2] as number) - (times[0] as number)) / 1000).toBe(
      DEMO_ARRIVAL_SPAN_SECONDS + 1,
    );
  });

  it('places each synthetic person at a stable spot well inside the site circle', () => {
    const position = demoPosition(FENCE, WORKER);
    expect(demoPosition(FENCE, WORKER)).toEqual(position);
    const metres =
      Math.hypot(
        (position.latitude - CENTER.lat) * 111_320,
        (position.longitude - CENTER.lng) * 111_320 * Math.cos((CENTER.lat * Math.PI) / 180),
      ) || 0;
    expect(metres).toBeGreaterThanOrEqual(9);
    expect(metres).toBeLessThanOrEqual(61);
    expect(demoPosition(FENCE, '4d000000-0000-4000-8000-0000000000d2')).not.toEqual(position);
  });

  it('never runs time backwards: an arrival right after a departure must wait', () => {
    const plan = buildDemoRecords({
      action: 'ARRIVE',
      fence: FENCE,
      workerId: WORKER,
      idempotencyKey: KEY,
      nowMs: NOW,
      lastEvidenceAt: new Date(NOW - 60_000).toISOString(),
    });
    expect(plan).toEqual({ waitSeconds: DEMO_ARRIVAL_SPAN_SECONDS + 1 - 59 });
  });

  it('stamps a departure just after the previous record, and waits only beyond a minute', () => {
    const soon = buildDemoRecords({
      action: 'LEAVE',
      fence: FENCE,
      workerId: WORKER,
      idempotencyKey: KEY,
      nowMs: NOW,
      lastEvidenceAt: new Date(NOW - 200).toISOString(),
    }) as { records: Record<string, unknown>[] };
    expect(Date.parse(String(soon.records[0]?.timestamp))).toBe(NOW - 200 + 1000);
    expect(
      buildDemoRecords({
        action: 'LEAVE',
        fence: FENCE,
        workerId: WORKER,
        idempotencyKey: KEY,
        nowMs: NOW,
        lastEvidenceAt: new Date(NOW + 120_000).toISOString(),
      }),
    ).toEqual({ waitSeconds: 121 });
  });

  it('builds a departure as one coordinate-free EXIT', () => {
    const plan = buildDemoRecords({
      action: 'LEAVE',
      fence: FENCE,
      workerId: WORKER,
      idempotencyKey: KEY,
      nowMs: NOW,
      lastEvidenceAt: null,
    }) as { records: Record<string, unknown>[] };
    expect(plan.records).toHaveLength(1);
    expect(plan.records[0]).toMatchObject({
      event: 'geofence',
      geofence: { identifier: 'sm_demo_site', action: 'EXIT' },
    });
    expect(containsCoordinateKeys(plan.records[0])).toBe(false);
  });

  it('uses the current boundary for an arrival and an open visit’s older boundary for a departure', () => {
    const old = { ...FENCE, configVersionId: 'cv-old', identifier: 'sm_old', current: false };
    const current = { ...FENCE, current: true };
    expect(demoFence(deviceJson([old, current]), PROJECT, 'ARRIVE')?.identifier).toBe(
      'sm_demo_site',
    );
    expect(demoFence(deviceJson([old, current]), PROJECT, 'LEAVE')?.identifier).toBe('sm_old');
    expect(demoFence(deviceJson([current]), PROJECT, 'LEAVE')?.identifier).toBe('sm_demo_site');
    expect(demoFence({ status: 'INVALID' }, PROJECT, 'ARRIVE')).toBeNull();
    expect(demoFence(deviceJson([current]), '0d000000-0000-4000-8000-0000000000ff', 'ARRIVE')).toBe(
      null,
    );
  });
});

describe('demo-simulate — handler', () => {
  it('refuses without a sign-in and with an invalid body, before any database call', async () => {
    const { deps, begun } = await world();
    expect((await handleDemoSimulate(request(simulate('ARRIVE'), null), deps)).status).toBe(401);
    const invalid = await handleDemoSimulate(
      request({ ...simulate('ARRIVE'), action: 'TELEPORT' }),
      deps,
    );
    expect(invalid.status).toBe(422);
    const extra = await handleDemoSimulate(
      request({ ...simulate('ARRIVE'), lat: 29.76, lng: -95.36 }),
      deps,
    );
    expect(extra.status).toBe(422);
    expect(begun).toEqual([]);
  });

  it('passes the database refusals through: not a demo, not a synthetic person, rate limit', async () => {
    for (const [code, status] of [
      ['DEMO_NOT_ALLOWED', 403],
      ['NOT_A_DEMO_WORKER', 403],
      ['FORBIDDEN', 403],
      ['RATE_LIMITED', 429],
    ] as const) {
      const { deps, backend } = await world({
        begin: async () => {
          throw new DemoRpcError(403, code);
        },
      });
      const response = await handleDemoSimulate(request(simulate('ARRIVE')), deps);
      expect(response.status).toBe(status);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(code);
      expect((await backend.snapshot(PROJECT)).receipts).toBe(0);
    }
  });

  it('records an arrival through the production engine: the synthetic person is counted on site', async () => {
    const { deps, backend } = await world();
    const response = await handleDemoSimulate(request(simulate('ARRIVE')), deps);
    expect(response.status).toBe(200);
    const body = DemoSimulateResponseSchema.parse(await response.json());
    expect(body.simulated).toBe(true);
    expect(body.results.map((result) => result.status)).toEqual([
      'accepted',
      'accepted',
      'accepted',
    ]);
    const snapshot = await backend.snapshot(PROJECT);
    expect(snapshot.tracks[0]?.presence).toBe('ONSITE_ESTIMATED');
    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.sessions[0]?.startAt).toBe(
      new Date(NOW - DEMO_ARRIVAL_SPAN_SECONDS * 1000).toISOString().replace('.000Z', 'Z'),
    );
  });

  it('answers a retried arrival with duplicates instead of a second visit or a wait', async () => {
    const { deps, backend, setLastEvidence, setNow } = await world();
    expect((await handleDemoSimulate(request(simulate('ARRIVE')), deps)).status).toBe(200);
    setLastEvidence(new Date(NOW).toISOString());
    setNow(NOW + 5_000);
    const retry = await handleDemoSimulate(request(simulate('ARRIVE')), deps);
    expect(retry.status).toBe(200);
    const body = DemoSimulateResponseSchema.parse(await retry.json());
    expect(body.results.map((result) => result.status)).toEqual([
      'duplicate',
      'duplicate',
      'duplicate',
    ]);
    expect((await backend.snapshot(PROJECT)).sessions).toHaveLength(1);
  });

  it('closes the visit on a simulated departure, then makes a new arrival wait for the 10-minute rule', async () => {
    const { deps, backend, setLastEvidence, setNow } = await world();
    await handleDemoSimulate(request(simulate('ARRIVE')), deps);
    setLastEvidence(new Date(NOW).toISOString());
    setNow(NOW + 120_000);
    const leave = await handleDemoSimulate(
      request(simulate('LEAVE', '6d000000-0000-4000-8000-0000000000d2')),
      deps,
    );
    expect(leave.status).toBe(200);
    const snapshot = await backend.snapshot(PROJECT);
    expect(snapshot.sessions[0]?.status).toBe('CLOSED');
    expect(snapshot.tracks[0]?.presence).toBe('OFFSITE');

    setLastEvidence(new Date(NOW + 120_000).toISOString());
    setNow(NOW + 180_000);
    const again = await handleDemoSimulate(
      request(simulate('ARRIVE', '6d000000-0000-4000-8000-0000000000d3')),
      deps,
    );
    expect(again.status).toBe(409);
    expect(Number(again.headers.get('retry-after'))).toBeGreaterThan(500);
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe('DEMO_WAIT');
  });

  it('refuses when the synthetic phone record is gone or not monitored on the project', async () => {
    for (const device of [
      async () => ({ status: 'INVALID' }),
      async () => deviceJson([]),
      async () => ({ ...deviceJson(), worker_id: '4d000000-0000-4000-8000-0000000000ff' }),
    ]) {
      const { deps, backend } = await world({ device });
      const response = await handleDemoSimulate(request(simulate('ARRIVE')), deps);
      expect(response.status).toBe(409);
      expect((await backend.snapshot(PROJECT)).receipts).toBe(0);
    }
  });

  it('never claims success when the database is unavailable', async () => {
    const { deps } = await world({
      store: {
        load: async () => {
          throw new Error('down');
        },
        commit: async () => 'conflict',
      },
    });
    const response = await handleDemoSimulate(request(simulate('ARRIVE')), deps);
    expect(response.status).toBe(503);
  });
});
