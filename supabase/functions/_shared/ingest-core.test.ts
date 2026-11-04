import { sha256 } from '@noble/hashes/sha2.js';
import { describe, expect, it } from 'vitest';

import { MemoryBackend } from '../../../tests/location-replay/harness/memory-backend.ts';
import { LocationIngestResponseSchema } from '../../../packages/shared/src/api/location-ingest.ts';
import { configFromSettings } from '../../../packages/shared/src/attendance/config.ts';
import type { AttendanceStore } from '../../../packages/shared/src/attendance/reconcile.ts';
import type { ReceiptRow } from '../../../packages/shared/src/attendance/types.ts';
import { base64UrlEncode } from '../../../packages/shared/src/crypto/encoding.ts';
import {
  type DeviceAuth,
  type DeviceAuthResult,
  deviceAuthFromJson,
  handleIngest,
  type IngestDeps,
  type QuarantineRow,
} from './ingest-core.ts';

const PROJECT_A = '0a000000-0000-4000-8000-0000000000a1';
const PROJECT_B = '0b000000-0000-4000-8000-0000000000b1';
const WORKER_A = '4a000000-0000-4000-8000-0000000000a1';
const WORKER_B = '4b000000-0000-4000-8000-0000000000b1';
const DEVICE_A = '5d000000-0000-4000-8000-0000000000a1';
const DEVICE_OTHER = '5d000000-0000-4000-8000-0000000000ff';
const CENTER_A = { lat: 29.7604, lng: -95.3698 };
const NOW = '2026-11-04T15:00:00Z';
const SECRET = base64UrlEncode(new Uint8Array(32).fill(7));
const SECRET_HASH = sha256(new Uint8Array(32).fill(7));

const config = (projectId: string, center: { lat: number; lng: number }) =>
  configFromSettings({
    configVersionId: `cv-${projectId}`,
    projectId,
    versionNumber: 1,
    effectiveAt: '2026-01-01T00:00:00Z',
    settings: { operates_24_7: true },
    center,
    radiusM: 150,
    exitHysteresisM: 50,
  });

const DEVICE: DeviceAuth = {
  deviceId: DEVICE_A,
  workerId: WORKER_A,
  coordinatesAllowed: true,
  fences: [
    {
      projectId: PROJECT_A,
      configVersionId: `cv-${PROJECT_A}`,
      identifier: 'sm_project_a',
      center: CENTER_A,
      nativeRadiusM: 200,
    },
  ],
};

interface World {
  deps: IngestDeps;
  backend: MemoryBackend;
  terminals: ReceiptRow[];
  quarantine: QuarantineRow[];
  loads: { projectId: string; workerId: string }[];
  receiptQueries: { deviceId: string; uuids: readonly string[] }[];
  logs: Record<string, unknown>[];
}

async function world(overrides: Partial<IngestDeps> = {}, device = DEVICE): Promise<World> {
  const backend = new MemoryBackend();
  await backend.createProject(
    { id: PROJECT_A, status: 'ACTIVE', timezone: 'America/Chicago' },
    config(PROJECT_A, CENTER_A),
  );
  await backend.createProject(
    { id: PROJECT_B, status: 'ACTIVE', timezone: 'America/New_York' },
    config(PROJECT_B, { lat: 40.7128, lng: -74.006 }),
  );
  await backend.enrollWorker(PROJECT_A, WORKER_A, { eligible: true, reason: null });
  await backend.enrollWorker(PROJECT_B, WORKER_B, { eligible: true, reason: null });
  const terminals: ReceiptRow[] = [];
  const quarantine: QuarantineRow[] = [];
  const loads: World['loads'] = [];
  const receiptQueries: World['receiptQueries'] = [];
  const logs: Record<string, unknown>[] = [];
  // Instrumented store: every privileged read/write names its (project, worker).
  const store: AttendanceStore = {
    load: async (projectId, workerId, uuids, sessions) => {
      loads.push({ projectId, workerId });
      return backend.load(projectId, workerId, uuids, sessions);
    },
    commit: (output, revision) => backend.commit(output, revision),
  };
  const deps: IngestDeps = {
    now: () => NOW,
    authenticate: async (hash): Promise<DeviceAuthResult> =>
      Buffer.from(hash).equals(Buffer.from(SECRET_HASH))
        ? { status: 'OK', device }
        : { status: 'INVALID' },
    rateLimit: async () => true,
    receipts: async (deviceId, uuids) => {
      receiptQueries.push({ deviceId, uuids });
      const found = new Map<string, boolean>();
      for (const uuid of uuids) {
        const owner = backend.receiptDevice(uuid);
        if (owner) found.set(uuid, owner === deviceId);
      }
      return found;
    },
    recordTerminals: async (_requestId, rows, copies) => {
      await backend.insertReceipts(rows);
      terminals.push(...rows);
      quarantine.push(...copies);
    },
    store,
    log: (entry) => logs.push(entry),
    ...overrides,
  };
  return { deps, backend, terminals, quarantine, loads, receiptQueries, logs };
}

function post(body: unknown, init: { secret?: string | null; type?: string } = {}): Request {
  const headers: Record<string, string> = {
    'content-type': init.type ?? 'application/json',
  };
  const secret = init.secret === undefined ? SECRET : init.secret;
  if (secret) headers.authorization = `Bearer ${secret}`;
  return new Request('http://edge/ingest-location-batch', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const uuid = (n: number) => `22222222-2222-4222-8222-${n.toString().padStart(12, '0')}`;
const enter = (n: number, identifier = 'sm_project_a') => ({
  uuid: uuid(n),
  timestamp: '2026-11-04T14:59:00Z',
  event: 'geofence',
  geofence: { identifier, action: 'ENTER' },
  accuracy: 12,
});
const fix = (n: number, lat: number, lng: number) => ({
  uuid: uuid(n),
  timestamp: '2026-11-04T14:59:30Z',
  event: 'location',
  coords: { latitude: lat, longitude: lng, accuracy: 10 },
  is_moving: false,
});

describe('ingest-location-batch — HTTP contract', () => {
  it('accepts only POST', async () => {
    const { deps } = await world();
    const response = await handleIngest(new Request('http://edge/x', { method: 'GET' }), deps);
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });

  it('answers 401 without a well-formed device secret, and for unknown/revoked/expired ones', async () => {
    const { deps } = await world();
    expect(
      (await handleIngest(post({ locations: [enter(1)] }, { secret: null }), deps)).status,
    ).toBe(401);
    expect(
      (await handleIngest(post({ locations: [enter(1)] }, { secret: 'abc' }), deps)).status,
    ).toBe(401);
    const wrong = base64UrlEncode(new Uint8Array(32).fill(8));
    expect(
      (await handleIngest(post({ locations: [enter(1)] }, { secret: wrong }), deps)).status,
    ).toBe(401);
    for (const status of ['REVOKED', 'EXPIRED'] as const) {
      const { deps: d } = await world({ authenticate: async () => ({ status }) });
      const response = await handleIngest(post({ locations: [enter(1)] }), d);
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
    }
  });

  it('answers 415 for non-JSON and 413 above 256 KiB', async () => {
    const { deps } = await world();
    expect((await handleIngest(post('x', { type: 'text/plain' }), deps)).status).toBe(415);
    const big = { locations: [{ ...enter(1), extras: { pad: 'x'.repeat(262_200) } }] };
    expect((await handleIngest(post(big), deps)).status).toBe(413);
  });

  it('answers 422 for invalid JSON or envelopes (no client authority keys, 1–25 records)', async () => {
    const { deps } = await world();
    expect((await handleIngest(post('{oops'), deps)).status).toBe(422);
    expect((await handleIngest(post({ locations: [] }), deps)).status).toBe(422);
    const tooMany = { locations: Array.from({ length: 26 }, (_, i) => enter(i + 1)) };
    expect((await handleIngest(post(tooMany), deps)).status).toBe(422);
    const authority = { locations: [enter(1)], worker_id: WORKER_B, project_id: PROJECT_B };
    expect((await handleIngest(post(authority), deps)).status).toBe(422);
    expect((await handleIngest(post({ locations: [{ event: 'heartbeat' }] }), deps)).status).toBe(
      422,
    );
  });

  it('answers 429 with Retry-After: 60 over the device rate limit', async () => {
    const { deps } = await world({ rateLimit: async () => false });
    const response = await handleIngest(post({ locations: [enter(1)] }), deps);
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
  });

  it('parses the database authentication result and fails closed on anything unexpected', () => {
    expect(deviceAuthFromJson({ status: 'REVOKED' })).toEqual({ status: 'REVOKED' });
    expect(deviceAuthFromJson({ status: 'OK' })).toEqual({ status: 'INVALID' });
    expect(deviceAuthFromJson(null)).toEqual({ status: 'INVALID' });
    const ok = deviceAuthFromJson({
      status: 'OK',
      device_id: DEVICE_A,
      worker_id: WORKER_A,
      coordinates_allowed: true,
      fences: [
        {
          projectId: PROJECT_A,
          configVersionId: 'cv',
          identifier: 'sm_a',
          center: { lat: 1, lng: 2 },
          nativeRadiusM: '200',
        },
      ],
    });
    expect(ok).toMatchObject({ status: 'OK', device: { fences: [{ nativeRadiusM: 200 }] } });
  });
});

describe('ingest-location-batch — whole-batch durability (SDK acknowledges entire batches)', () => {
  it('returns 200 only when every record is terminal: accepted, duplicate and rejected in input order', async () => {
    const { deps, terminals, quarantine } = await world();
    const batch = {
      locations: [
        enter(1),
        enter(2, 'sm_project_b_unbound'),
        fix(3, 29.9, -95.9), // ~40 km away: an offsite coordinate reached the server
        enter(1), // same uuid twice inside one batch
        { uuid: uuid(5), timestamp: '2026-11-04T14:59:40Z', event: 'heartbeat' },
      ],
    };
    const response = await handleIngest(post(batch), deps);
    expect(response.status).toBe(200);
    const body = LocationIngestResponseSchema.parse(await response.json());
    expect(body.results).toEqual([
      { event_uuid: uuid(1), status: 'accepted', reason: null },
      { event_uuid: uuid(2), status: 'rejected', reason: 'PROJECT_NOT_AUTHORIZED' },
      { event_uuid: uuid(3), status: 'rejected', reason: 'COORDINATES_NOT_PERMITTED' },
      { event_uuid: uuid(1), status: 'duplicate', reason: null },
      { event_uuid: uuid(5), status: 'accepted', reason: null },
    ]);
    expect(terminals.map((row) => row.event_uuid).sort()).toEqual([uuid(2), uuid(3), uuid(5)]);
    expect(JSON.stringify(quarantine)).not.toMatch(/29\.9|-95\.9|latitude|longitude/);
  });

  it('answers 503 for the WHOLE batch when one record cannot be committed, then applies it once on retry', async () => {
    let failing = true;
    const base = await world();
    const { deps } = await world({
      store: {
        load: (...args) => base.deps.store.load(...args),
        commit: async (output, revision) => {
          if (failing) throw new Error('database unavailable');
          return base.deps.store.commit(output, revision);
        },
      },
      recordTerminals: base.deps.recordTerminals,
      receipts: base.deps.receipts,
    });
    const batch = { locations: [enter(1), enter(2, 'sm_project_b_unbound')] };
    const first = await handleIngest(post(batch), deps);
    expect(first.status).toBe(503);
    failing = false;
    const second = await handleIngest(post(batch), deps);
    expect(second.status).toBe(200);
    const body = LocationIngestResponseSchema.parse(await second.json());
    expect(body.results.map((r) => [r.event_uuid, r.status])).toEqual([
      [uuid(1), 'accepted'],
      [uuid(2), 'duplicate'], // its rejection was already durable from the first attempt
    ]);
    const third = LocationIngestResponseSchema.parse(
      await (await handleIngest(post(batch), deps)).json(),
    );
    expect(third.results.every((r) => r.status === 'duplicate')).toBe(true);
    const snapshot = await base.backend.snapshot(PROJECT_A);
    expect(snapshot.tracks).toHaveLength(1);
  });

  it('answers 503 when the terminal outcomes cannot be stored (never a fake success)', async () => {
    const { deps } = await world({
      recordTerminals: async () => {
        throw new Error('quarantine down');
      },
    });
    const response = await handleIngest(post({ locations: [enter(2, 'sm_unbound')] }), deps);
    expect(response.status).toBe(503);
  });

  it('answers 503 when authentication is temporarily unavailable', async () => {
    const { deps } = await world({
      authenticate: async () => {
        throw new Error('db down');
      },
    });
    expect((await handleIngest(post({ locations: [enter(1)] }), deps)).status).toBe(503);
  });

  it('quarantines a record without a uuid (cannot be acknowledged on its own)', async () => {
    const { deps, quarantine } = await world();
    const response = await handleIngest(
      post({ locations: [enter(1), { event: 'location', timestamp: NOW }] }),
      deps,
    );
    expect(response.status).toBe(200);
    const body = LocationIngestResponseSchema.parse(await response.json());
    expect(body.results).toHaveLength(1);
    expect(quarantine).toEqual([
      expect.objectContaining({ event_uuid: null, reason: 'INVALID_RECORD' }),
    ]);
  });
});

describe('ingest-location-batch — tenant isolation and privacy', () => {
  it('a project-A credential carrying project-B identifiers, ids and worker never reads or writes B', async () => {
    const w = await world();
    const hostile = {
      locations: [
        { ...enter(1, 'sm_project_b_identifier'), extras: { project_id: PROJECT_B } },
        { ...enter(2), extras: { worker_id: WORKER_B, organization_id: PROJECT_B } },
        { ...fix(3, 40.7128, -74.006), extras: { project_id: PROJECT_B } }, // inside project B
      ],
    };
    const response = await handleIngest(post(hostile), w.deps);
    expect(response.status).toBe(200);
    const body = LocationIngestResponseSchema.parse(await response.json());
    expect(body.results).toEqual([
      { event_uuid: uuid(1), status: 'rejected', reason: 'PROJECT_NOT_AUTHORIZED' },
      { event_uuid: uuid(2), status: 'accepted', reason: null },
      { event_uuid: uuid(3), status: 'rejected', reason: 'COORDINATES_NOT_PERMITTED' },
    ]);
    // Instrumented access log: every privileged read targets project A / worker A only.
    expect(w.loads.length).toBeGreaterThan(0);
    expect(w.loads.every((l) => l.projectId === PROJECT_A && l.workerId === WORKER_A)).toBe(true);
    expect(w.receiptQueries.every((q) => q.deviceId === DEVICE_A)).toBe(true);
    expect(JSON.stringify(w.terminals)).not.toContain(PROJECT_B);
    expect(JSON.stringify(w.terminals)).not.toContain(WORKER_B);
    expect((await w.backend.snapshot(PROJECT_B)).tracks).toHaveLength(0);
  });

  it('refuses every coordinate while continuous coordinates are not released for this build', async () => {
    const { deps } = await world({}, { ...DEVICE, coordinatesAllowed: false });
    const response = await handleIngest(
      post({ locations: [enter(1), fix(2, CENTER_A.lat, CENTER_A.lng)] }),
      deps,
    );
    const body = LocationIngestResponseSchema.parse(await response.json());
    expect(body.results).toEqual([
      { event_uuid: uuid(1), status: 'accepted', reason: null },
      { event_uuid: uuid(2), status: 'rejected', reason: 'COORDINATES_NOT_PERMITTED' },
    ]);
  });

  it('refuses a uuid that already belongs to another device, without touching that record', async () => {
    const w = await world();
    await w.backend.insertReceipts([
      {
        event_uuid: uuid(9),
        device_id: DEVICE_OTHER,
        worker_id: WORKER_B,
        project_id: PROJECT_B,
        config_version_id: null,
        event_type: 'GEOFENCE_ENTER',
        observed_at: NOW,
        server_received_at: NOW,
        accuracy_m: null,
        qualification_state: 'NOT_APPLICABLE',
        terminal_result: 'accepted',
        rejection_reason: null,
      },
    ]);
    const body = LocationIngestResponseSchema.parse(
      await (await handleIngest(post({ locations: [enter(9)] }), w.deps)).json(),
    );
    expect(body.results).toEqual([
      { event_uuid: uuid(9), status: 'rejected', reason: 'EVENT_UUID_CONFLICT' },
    ]);
    expect(w.quarantine).toEqual([expect.objectContaining({ reason: 'EVENT_UUID_CONFLICT' })]);
    expect(w.backend.receiptDevice(uuid(9))).toBe(DEVICE_OTHER);
  });

  it('logs ids truncated and counts only — never the payload, coordinates or the secret', async () => {
    const { deps, logs } = await world();
    await handleIngest(post({ locations: [enter(1), fix(3, 29.9, -95.9)] }), deps);
    const text = JSON.stringify(logs);
    expect(text).not.toContain(SECRET);
    expect(text).not.toMatch(/29\.9|-95\.9|latitude|sm_project_a/);
    expect(logs[0]).toMatchObject({ device: DEVICE_A.slice(0, 8), status: 200 });
  });
});
