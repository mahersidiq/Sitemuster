import { describe, expect, it } from 'vitest';

import { containsCoordinateKeys, distanceMeters } from '@sitemuster/shared';

import { MemoryControllerStore, TrackingAgent } from './agent';
import { type ControllerFence, DISARMED, disarm, onHeartbeat, onResync } from './controller';
import { type CommandFailure, EGRESS_GATE_FAILED, executeCommands } from './driver';
import { egressDecision, recordsToDestroy } from './gate';
import { buildSdkConfig, modeConfig, PERSIST_MODE_ALL, PERSIST_MODE_GEOFENCE } from './sdk-config';
import { type CapturedRequest, SimulatedSdk, type Transport } from './simulated-driver';
import { GEOFENCE_TEMPLATE, LOCATION_TEMPLATE, renderTemplate, templateTags } from './templates';

const CENTER = { lat: 29.7604, lng: -95.3698 };
const FENCE: ControllerFence = {
  projectId: '0a000000-0000-4000-8000-0000000000a1',
  identifier: 'sm_alpha',
  center: CENTER,
  radiusM: 150,
  nativeRadiusM: 200,
  dwellSeconds: 600,
  maxAccuracyM: 75,
};
const OTHER: ControllerFence = {
  ...FENCE,
  projectId: '0b000000-0000-4000-8000-0000000000b1',
  identifier: 'sm_bravo',
  center: { lat: CENTER.lat, lng: CENTER.lng + 0.003 }, // ~290 m east: native fences overlap
};
const INGEST = 'https://example.test/functions/v1/ingest-location-batch';
const RENEW = 'https://example.test/functions/v1/device-renew';

/** A point `north` metres north and `east` metres east of the site center. */
const at = (north: number, east = 0) => ({
  lat: CENTER.lat + north / 111_320,
  lng: CENTER.lng + east / (111_320 * Math.cos((CENTER.lat * Math.PI) / 180)),
});

function input(token = 'A'.repeat(43)) {
  return {
    ingestUrl: INGEST,
    renewUrl: RENEW,
    token,
    renewAfterEpochSeconds: Math.floor(Date.parse('2026-11-27T00:00:00Z') / 1000),
    notification: { title: 'SiteMuster', text: 'On site', channelName: 'Attendance' },
  };
}

interface Rig {
  sdk: SimulatedSdk;
  agent: TrackingAgent;
  requests: CapturedRequest[];
  tokens: string[];
  failures: CommandFailure[];
  readonly refusals: number;
}

async function rig(
  options: {
    coordinatesAllowed?: boolean;
    fences?: ControllerFence[];
    ingest?: Transport;
    renewAfter?: string;
  } = {},
): Promise<Rig> {
  const tokens: string[] = [];
  const failures: CommandFailure[] = [];
  const counters = { refusals: 0 };
  const accept: Transport = async (url, init) => {
    if (url === RENEW)
      return {
        status: 200,
        json: { access_token: 'B'.repeat(43), refresh_token: 'B'.repeat(43), expires: 1 },
      };
    const body = JSON.parse(init.body) as { locations: { uuid: string }[] };
    return {
      status: 200,
      json: {
        results: body.locations.map((r) => ({
          event_uuid: r.uuid,
          status: 'accepted',
          reason: null,
        })),
      },
    };
  };
  const sdk = new SimulatedSdk(options.ingest ?? accept, '2026-11-04T05:00:00Z');
  const agent = new TrackingAgent(sdk, new MemoryControllerStore(), {
    authorization: (event) => {
      if (event.token) tokens.push(event.token);
      if (!event.success) counters.refusals += 1;
    },
    failure: (failure) => failures.push(failure),
  });
  agent.attach();
  const config = input();
  if (options.renewAfter)
    config.renewAfterEpochSeconds = Math.floor(Date.parse(options.renewAfter) / 1000);
  await sdk.ready(buildSdkConfig(config, 'OFFSITE'));
  await sdk.moveTo('2026-11-04T05:00:00Z', { ...at(5000), accuracy: 15 }); // at home, 5 km away
  await agent.arm(options.fences ?? [FENCE], options.coordinatesAllowed ?? true);
  await agent.idle();
  return {
    sdk,
    agent,
    requests: sdk.wire,
    tokens,
    failures,
    get refusals() {
      return counters.refusals;
    },
  };
}

async function walk(r: Rig, time: string, point: { lat: number; lng: number }, accuracy = 10) {
  await r.sdk.moveTo(time, { ...point, accuracy });
  await r.agent.idle();
  await r.sdk.settle();
  await r.agent.idle();
}

type WireRecord = Record<string, unknown> & {
  event: string;
  coords?: { latitude: number; longitude: number };
};

const records = (requests: readonly CapturedRequest[]) =>
  requests
    .filter((request) => request.url === INGEST)
    .flatMap((request) => (JSON.parse(request.body) as { locations: WireRecord[] }).locations);

/** The privacy assertion: no coordinate outside one bound native fence ever left the phone. */
function offsiteCoordinates(
  requests: readonly CapturedRequest[],
  fences: readonly ControllerFence[],
) {
  return records(requests).filter((record) => {
    if (record.event === 'geofence') return containsCoordinateKeys(record);
    if (!record.coords) return false;
    const point = { lat: record.coords.latitude, lng: record.coords.longitude };
    return (
      fences.filter((fence) => distanceMeters(point, fence.center) <= fence.nativeRadiusM)
        .length !== 1
    );
  });
}

describe('native templates and configuration', () => {
  it('the geofence template never reads a coordinate and renders valid, coordinate-free JSON', () => {
    expect(templateTags(GEOFENCE_TEMPLATE).sort()).toEqual([
      'accuracy',
      'geofence.action',
      'geofence.identifier',
      'timestamp',
      'uuid',
    ]);
    const rendered = JSON.parse(
      renderTemplate(GEOFENCE_TEMPLATE, {
        uuid: 'u',
        timestamp: '2026-11-04T05:00:00.000Z',
        'geofence.identifier': 'sm_alpha',
        'geofence.action': 'EXIT',
        accuracy: 12,
        latitude: 29.76,
        longitude: -95.36,
      }),
    ) as Record<string, unknown>;
    expect(containsCoordinateKeys(rendered)).toBe(false);
    expect(rendered).toEqual({
      uuid: 'u',
      timestamp: '2026-11-04T05:00:00.000Z',
      event: 'geofence',
      geofence: { identifier: 'sm_alpha', action: 'EXIT' },
      accuracy: 12,
    });
  });

  it('the location template stays valid JSON when a platform leaves a boolean empty', () => {
    const rendered = JSON.parse(
      renderTemplate(LOCATION_TEMPLATE, {
        uuid: 'u',
        timestamp: 't',
        event: '',
        latitude: 1,
        longitude: 2,
        accuracy: 3,
      }),
    ) as Record<string, unknown>;
    expect(rendered).toEqual({
      uuid: 'u',
      timestamp: 't',
      event: '',
      coords: { latitude: 1, longitude: 2, accuracy: 3 },
      is_moving: '',
      mock: '',
    });
  });

  it('offsite = geofence-only persistence with SDK autoSync; onsite = all records, JS-driven sync', () => {
    const offsite = buildSdkConfig(input(), 'OFFSITE');
    expect(offsite.persistence?.persistMode).toBe(PERSIST_MODE_GEOFENCE);
    // The SDK never starts uploading by itself: arming prunes first, then enables it (#96).
    expect(offsite.http?.autoSync).toBe(false);
    expect(buildSdkConfig(input(), 'ONSITE').http?.autoSync).toBe(false);
    expect(modeConfig('OFFSITE').http?.autoSync).toBe(true);
    expect(modeConfig('ONSITE')).toMatchObject({
      http: { autoSync: false },
      persistence: { persistMode: PERSIST_MODE_ALL },
      app: { preventSuspend: true, heartbeatInterval: 300 },
    });
    expect(offsite).toMatchObject({
      http: {
        url: INGEST,
        method: 'POST',
        rootProperty: 'locations',
        batchSync: true,
        maxBatchSize: 25,
        headers: {},
        params: {},
      },
      persistence: {
        disableProviderChangeRecord: true,
        timestampFormat: 'iso',
        maxDaysToPersist: 4,
      },
      logger: { debug: false, logLevel: 0 },
      app: { stopOnTerminate: false, startOnBoot: true, enableHeadless: true },
      geolocation: {
        desiredAccuracy: -1,
        distanceFilter: 25,
        activityType: 3,
        geofenceInitialTriggerEntry: true,
      },
      authorization: {
        accessToken: 'A'.repeat(43),
        refreshToken: 'A'.repeat(43),
        refreshUrl: RENEW,
        refreshPayload: { refresh_token: '{refreshToken}' },
      },
    });
  });
});

describe('on-device egress gate', () => {
  const fix = (point: { lat: number; lng: number }) => ({
    uuid: 'u',
    event: 'location',
    coords: { latitude: point.lat, longitude: point.lng, accuracy: 10 },
  });

  it('keeps a position only inside exactly one bound native fence', () => {
    expect(egressDecision(fix(at(100)), [FENCE], true)).toBe('KEEP');
    expect(egressDecision(fix(at(190)), [FENCE], true)).toBe('KEEP'); // hysteresis band
    expect(egressDecision(fix(at(260)), [FENCE], true)).toBe('DESTROY'); // offsite
    expect(egressDecision(fix(at(0, 150)), [FENCE, OTHER], true)).toBe('DESTROY'); // ambiguous
    expect(egressDecision(fix(at(10)), [FENCE], false)).toBe('DESTROY'); // not released
  });

  it('keeps geofence records (stored with their trigger position, uploaded through the coordinate-free template)', () => {
    const enter = {
      uuid: 'g',
      event: 'geofence',
      geofence: { identifier: 'sm_alpha', action: 'ENTER' },
    };
    expect(egressDecision(enter, [], false)).toBe('KEEP');
    const stored = { ...enter, coords: { latitude: 1, longitude: 2, accuracy: 3 } };
    expect(egressDecision(stored, [FENCE], true)).toBe('KEEP');
    expect(recordsToDestroy([enter, fix(at(5000)), fix(at(10))], [FENCE], true)).toEqual(['u']);
  });
});

describe('the egress gate fails closed (decision #96)', () => {
  const armed = {
    ...DISARMED,
    mode: 'ARMED_OFFSITE' as const,
    fences: [FENCE],
    coordinatesAllowed: true,
  };

  it('after a failed PRUNE nothing in the batch uploads: SYNC skipped, autoSync kept off', async () => {
    const sdk = new SimulatedSdk(async () => ({ status: 200, json: {} }), '2026-11-04T05:00:00Z');
    await sdk.ready(buildSdkConfig(input(), 'OFFSITE'));
    const calls: string[] = [];
    const setConfig = sdk.setConfig.bind(sdk);
    sdk.setConfig = async (config) => {
      calls.push(`setConfig:${JSON.stringify(config.http ?? {})}`);
      await setConfig(config);
    };
    sdk.sync = async () => {
      calls.push('sync');
    };
    sdk.failNext('queued');
    const failures: CommandFailure[] = [];
    const result = await executeCommands(sdk, armed, onResync(armed).commands, (failure) =>
      failures.push(failure),
    );
    expect(result).toEqual({ egressBlocked: true });
    expect(calls).toEqual(['setConfig:{"autoSync":false}']);
    expect(failures.map((f) => f.command)).toEqual(['PRUNE', 'SYNC']);
    expect((failures[1]?.error as Error).message).toBe(EGRESS_GATE_FAILED);

    // The next resync prunes successfully and lets uploads resume.
    calls.length = 0;
    expect(await executeCommands(sdk, armed, onResync(armed).commands, () => undefined)).toEqual({
      egressBlocked: false,
    });
    expect(calls).toEqual(['setConfig:{"autoSync":true}', 'sync']);
  });

  it('every offsite sync is preceded by a prune; disarming switches uploads off', () => {
    expect(onHeartbeat(armed).commands.map((c) => c.type)).toEqual(['PRUNE', 'SET_CONFIG', 'SYNC']);
    expect(onResync({ ...armed, mode: 'ENTRY_PENDING' }).commands.map((c) => c.type)).toEqual([
      'PRUNE',
      'SYNC',
    ]);
    expect(disarm().commands[0]).toMatchObject({
      type: 'SET_CONFIG',
      config: { http: { autoSync: false } },
    });
  });

  it('captured wire: a failing native queue at the exit never sends the crossing position', async () => {
    const r = await rig();
    await walk(r, '2026-11-04T06:00:00Z', at(190));
    await walk(r, '2026-11-04T06:01:00Z', at(60));
    await walk(r, '2026-11-04T06:12:00Z', at(20));
    expect(r.agent.current.mode).toBe('ONSITE_ESTIMATED');
    // Leaving: the SDK stores the crossing position, then both gate paths fail once.
    r.sdk.failNext('destroy');
    r.sdk.failNext('queued');
    await walk(r, '2026-11-04T14:00:00Z', at(420));
    expect(r.agent.current.mode).toBe('ARMED_OFFSITE');
    expect(r.failures.map((f) => f.command)).toEqual(['DESTROY', 'PRUNE', 'SYNC']);
    expect((await r.sdk.queued()).some((x) => x.coords && x.event !== 'geofence')).toBe(true);
    // Driving home: the SDK must not upload on its own while the queue is unpruned.
    await walk(r, '2026-11-04T14:10:00Z', at(2500));
    expect(offsiteCoordinates(r.requests, [FENCE])).toEqual([]);
    // The next heartbeat prunes, then uploads: only the coordinate-free EXIT leaves the phone.
    await r.sdk.fireHeartbeat('2026-11-04T14:15:00Z');
    await r.agent.idle();
    expect(offsiteCoordinates(r.requests, [FENCE])).toEqual([]);
    expect(JSON.stringify(r.requests)).not.toContain(at(420).lat.toFixed(6));
    expect(
      records(r.requests)
        .filter((x) => x.event === 'geofence')
        .map((x) => (x.geofence as { action: string }).action),
    ).toEqual(['ENTER', 'EXIT']);
    expect(await r.sdk.count()).toBe(0);
  });
});

describe('captured wire (simulated SDK + production controller)', () => {
  it('a full day never sends an offsite coordinate: home, arrival, dwell, work, exit, drive home', async () => {
    const r = await rig();
    // Commute: offsite, geofence-only → nothing is recorded or sent.
    await walk(r, '2026-11-04T05:30:00Z', at(3000));
    await walk(r, '2026-11-04T05:50:00Z', at(800));
    expect(records(r.requests)).toHaveLength(0);
    // Crossing into the native fence (hysteresis band) → coordinate-free ENTER, gated tracking.
    await walk(r, '2026-11-04T06:00:00Z', at(190));
    expect(r.agent.current.mode).toBe('ENTRY_PENDING');
    await walk(r, '2026-11-04T06:01:00Z', at(60));
    await walk(r, '2026-11-04T06:12:00Z', at(20));
    expect(r.agent.current.mode).toBe('ONSITE_ESTIMATED'); // two qualified fixes ≥ 10 min apart
    await walk(r, '2026-11-04T09:00:00Z', at(-40));
    // Leaving: the SDK records the position that crossed the fence BEFORE JavaScript sees the EXIT.
    await walk(r, '2026-11-04T14:00:00Z', at(420));
    expect(r.agent.current.mode).toBe('ARMED_OFFSITE');
    await walk(r, '2026-11-04T14:10:00Z', at(2500));
    await walk(r, '2026-11-04T14:30:00Z', at(5000));

    const sent = records(r.requests);
    expect(
      sent
        .filter((x) => x.event === 'geofence')
        .map((x) => (x.geofence as { action: string }).action),
    ).toEqual(['ENTER', 'EXIT']);
    expect(sent.filter((x) => x.coords).length).toBeGreaterThanOrEqual(3);
    expect(offsiteCoordinates(r.requests, [FENCE])).toEqual([]);
    for (const leak of [at(420), at(2500), at(5000), at(3000), at(800)]) {
      expect(JSON.stringify(r.requests)).not.toContain(leak.lat.toFixed(6));
    }
    expect((await r.sdk.queued()).filter((x) => x.coords && x.event !== 'geofence')).toHaveLength(
      0,
    );
  });

  it('negative control: a build that kept SDK autoSync on while on site WOULD leak (the test is not vacuous)', async () => {
    const r = await rig();
    await walk(r, '2026-11-04T06:00:00Z', at(190));
    await walk(r, '2026-11-04T06:12:00Z', at(20));
    await r.sdk.setConfig({ http: { autoSync: true } }); // misconfiguration under test
    await walk(r, '2026-11-04T14:00:00Z', at(420));
    expect(offsiteCoordinates(r.requests, [FENCE]).length).toBeGreaterThan(0);
  });

  it('TRACKING_LIMITED (coordinates not released): only coordinate-free ENTER/EXIT ever leave the phone', async () => {
    const r = await rig({ coordinatesAllowed: false });
    await walk(r, '2026-11-04T06:00:00Z', at(100));
    await walk(r, '2026-11-04T06:20:00Z', at(10));
    expect(r.agent.current.mode).toBe('ARMED_OFFSITE');
    await walk(r, '2026-11-04T14:00:00Z', at(600));
    const sent = records(r.requests);
    expect(sent.map((x) => x.event)).toEqual(['geofence', 'geofence']);
    expect(sent.some((x) => containsCoordinateKeys(x))).toBe(false);
  });

  it('overlapping sites: positions inside both fences are never sent (ambiguous project)', async () => {
    const r = await rig({ fences: [FENCE, OTHER] });
    await walk(r, '2026-11-04T06:00:00Z', at(0, 150)); // inside both native fences
    await walk(r, '2026-11-04T06:15:00Z', at(0, 140));
    expect(offsiteCoordinates(r.requests, [FENCE, OTHER])).toEqual([]);
    expect(records(r.requests).filter((x) => x.coords)).toHaveLength(0);
  });

  it('offline on site: records wait in the native queue (gated) and upload once when back online', async () => {
    const r = await rig();
    r.sdk.setNetwork(false);
    await walk(r, '2026-11-04T06:00:00Z', at(150));
    await walk(r, '2026-11-04T06:11:00Z', at(30));
    await walk(r, '2026-11-04T06:30:00Z', at(10));
    expect(records(r.requests)).toHaveLength(0);
    const queued = await r.sdk.count();
    expect(queued).toBeGreaterThan(0);
    r.sdk.setNetwork(true);
    await r.agent.sync();
    const uuids = records(r.requests).map((x) => x.uuid);
    expect(new Set(uuids).size).toBe(uuids.length);
    expect(uuids).toHaveLength(queued);
    expect(await r.sdk.count()).toBe(0);
  });

  it('the SDK renews natively when the renewal is due, then uploads with the new secret: zero loss', async () => {
    const used: string[] = [];
    const accepted = new Map<string, number>();
    const transport: Transport = async (url, init) => {
      if (url === RENEW) {
        expect(init.body).toBe(`refresh_token=${'A'.repeat(43)}`);
        return {
          status: 200,
          json: {
            access_token: 'C'.repeat(43),
            refresh_token: 'C'.repeat(43),
            expires: 2_000_000_000,
          },
        };
      }
      used.push(init.headers.authorization ?? '');
      const body = JSON.parse(init.body) as { locations: { uuid: string }[] };
      for (const record of body.locations)
        accepted.set(record.uuid, (accepted.get(record.uuid) ?? 0) + 1);
      return { status: 200, json: {} };
    };
    const r = await rig({ ingest: transport, renewAfter: '2026-11-04T05:30:00Z' });
    await walk(r, '2026-11-04T06:00:00Z', at(100));
    await walk(r, '2026-11-04T06:12:00Z', at(10));
    expect(r.tokens).toEqual(['C'.repeat(43)]);
    expect((await r.sdk.storedAuthorization())?.token).toBe('C'.repeat(43));
    expect(used.length).toBeGreaterThan(0);
    expect(used.every((header) => header === `Bearer ${'C'.repeat(43)}`)).toBe(true);
    expect([...accepted.values()].every((n) => n === 1)).toBe(true);
    expect(await r.sdk.count()).toBe(0);
  });

  it('a refused secret (401, renewal refused) keeps every record queued — never deleted unsent', async () => {
    const transport: Transport = async (url) =>
      url === RENEW
        ? { status: 401, json: { error: { code: 'DEVICE_REVOKED' } } }
        : { status: 401, json: null };
    const r = await rig({ ingest: transport });
    await walk(r, '2026-11-04T06:00:00Z', at(100));
    expect(await r.sdk.count()).toBeGreaterThan(0);
    expect(r.refusals).toBeGreaterThan(0);
  });

  it('disarming (signed out, consent withdrawn) stops tracking and drops the queue', async () => {
    const r = await rig();
    r.sdk.setNetwork(false);
    await walk(r, '2026-11-04T06:00:00Z', at(100));
    expect(await r.sdk.count()).toBeGreaterThan(0);
    await r.agent.disarm();
    expect(r.agent.current.mode).toBe('DISARMED');
    expect(await r.sdk.count()).toBe(0);
    r.sdk.setNetwork(true);
    await walk(r, '2026-11-04T07:00:00Z', at(10));
    expect(records(r.requests)).toHaveLength(0);
  });
});
