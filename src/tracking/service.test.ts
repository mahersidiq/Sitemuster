import { describe, expect, it } from 'vitest';

import type { DeviceRenewResponse } from '@sitemuster/shared';

import type { StoredDevice } from '../device/device-store';
import type { ControllerState } from './controller';
import type { TrackingPlan } from './plan';
import { TrackingService, type TrackingServiceDeps, type TrackingStore } from './service';
import { SimulatedSdk } from './simulated-driver';

const USER = 'c1000000-0000-4000-8000-000000000001';
const DEVICE = '5d000000-0000-4000-8000-0000000000a1';
const NOW = Date.parse('2026-11-04T12:00:00Z');
const DAY = 86_400_000;

function project(i: number) {
  return {
    project_id: `0a000000-0000-4000-8000-${i.toString().padStart(12, '0')}`,
    project_name: `Site ${i}`,
    iana_timezone: 'America/Chicago',
    config_version_id: `2a000000-0000-4000-8000-${i.toString().padStart(12, '0')}`,
    version_number: 1,
    effective_at: '2026-01-01T00:00:00Z',
    settings: { operates_24_7: true, entry_dwell_seconds: 600, max_horizontal_accuracy_m: 75 },
    identifier: `sm_${i}`,
    center: { lat: 29.76 + i * 0.01, lng: -95.37 },
    radius_m: 150,
    native_radius_m: 200,
  };
}

function plan(overrides: Partial<TrackingPlan> = {}): TrackingPlan {
  return {
    device_id: DEVICE,
    platform: 'IOS',
    credential: { status: 'OK', expires_at: new Date(NOW + 20 * DAY).toISOString() },
    coordinates_allowed: true,
    projects: [project(1)],
    not_monitored: [],
    ...overrides,
  };
}

class MemoryTrackingStore implements TrackingStore {
  state: ControllerState | null = null;
  plan: TrackingPlan | null = null;
  async load() {
    return this.state;
  }
  async save(state: ControllerState) {
    this.state = structuredClone(state);
  }
  async loadPlan() {
    return this.plan;
  }
  async savePlan(value: TrackingPlan) {
    this.plan = value;
  }
  async clear() {
    this.state = null;
    this.plan = null;
  }
}

function setup(
  options: {
    plan?: TrackingPlan | Error;
    device?: StoredDevice | null;
    permission?: SimulatedSdk['permissionState'];
    renew?: TrackingServiceDeps['renewWithSecret'];
    session?: () => Promise<DeviceRenewResponse>;
  } = {},
) {
  const sdk = new SimulatedSdk(async () => ({ status: 200, json: {} }), '2026-11-04T12:00:00Z');
  if (options.permission) sdk.permissionState = options.permission;
  const store = new MemoryTrackingStore();
  const log: string[] = [];
  const posted: Record<string, unknown>[] = [];
  const device: StoredDevice | null =
    options.device === undefined
      ? {
          userId: USER,
          deviceId: DEVICE,
          badgeSecret: 'b'.repeat(43),
          uploadToken: 'A'.repeat(43),
          uploadExpiresAt: new Date(NOW + 20 * DAY).toISOString(),
        }
      : options.device;
  const originalSetConfig = sdk.setConfig.bind(sdk);
  sdk.setConfig = async (config) => {
    if (config.authorization) log.push(`sdk:${config.authorization.accessToken}`);
    await originalSetConfig(config);
  };
  let readyCalls = 0;
  const originalReady = sdk.ready.bind(sdk);
  sdk.ready = async (config) => {
    readyCalls += 1;
    await originalReady(config);
  };
  const deps: TrackingServiceDeps = {
    api: {
      getTrackingPlan: async () => {
        if (options.plan instanceof Error) throw options.plan;
        return options.plan ?? plan();
      },
      renewDeviceWithSession:
        options.session ??
        (async () => {
          throw new Error('no session renewal expected');
        }),
    },
    driver: sdk,
    store,
    devices: {
      load: async () => device,
      updateToken: async (_user, token) => {
        log.push(`store:${token}`);
      },
    },
    urls: {
      ingest: 'https://x.test/functions/v1/ingest-location-batch',
      renew: 'https://x.test/functions/v1/device-renew',
    },
    platform: 'ios',
    appVersion: '0.3.0',
    now: () => NOW,
    notification: { title: 't', text: 'x', channelName: 'c' },
    renewWithSecret:
      options.renew ??
      (async () => {
        throw new Error('no renewal expected');
      }),
    postRecord: async (record) => {
      posted.push(record);
      return true;
    },
    newUuid: () => `00000000-0000-4000-8000-${(posted.length + 1).toString().padStart(12, '0')}`,
    report: () => undefined,
  };
  return {
    service: new TrackingService(deps),
    sdk,
    store,
    log,
    posted,
    readyCalls: () => readyCalls,
  };
}

describe('tracking service', () => {
  it('arms the bound fences when everything is in place (ACTIVE)', async () => {
    const { service, readyCalls } = setup();
    const status = await service.start(USER);
    expect(status).toMatchObject({
      phase: 'ACTIVE',
      mode: 'ARMED_OFFSITE',
      credential: 'OK',
      coordinatesAllowed: true,
    });
    expect(status.monitored).toEqual([{ id: project(1).project_id, name: 'Site 1' }]);
    expect(readyCalls()).toBe(1);
  });

  it('shows TRACKING_LIMITED when continuous coordinates are not released for this build', async () => {
    const { service } = setup({ plan: plan({ coordinates_allowed: false }) });
    expect((await service.start(USER)).phase).toBe('TRACKING_LIMITED');
  });

  it("never starts the SDK before SiteMuster's own permission screens (no OS prompt)", async () => {
    const { service, readyCalls } = setup({
      permission: { location: 'WHEN_IN_USE', precise: true, servicesEnabled: true },
    });
    expect((await service.start(USER)).phase).toBe('PERMISSION_REQUIRED');
    expect(readyCalls()).toBe(0);
    const reduced = setup({
      permission: { location: 'ALWAYS', precise: false, servicesEnabled: true },
    });
    expect((await reduced.service.start(USER)).phase).toBe('PERMISSION_REQUIRED');
  });

  it('reports NO_DEVICE, DEVICE_REVOKED and NOT_ENROLLED (with reasons) and stays disarmed', async () => {
    expect((await setup({ device: null }).service.start(USER)).phase).toBe('NO_DEVICE');
    const replaced = setup({ plan: plan({ device_id: '5d000000-0000-4000-8000-0000000000ff' }) });
    expect(await replaced.service.start(USER)).toMatchObject({
      phase: 'DEVICE_REVOKED',
      mode: 'DISARMED',
    });
    const none = setup({
      plan: plan({
        projects: [],
        not_monitored: [
          { project_id: project(2).project_id, project_name: 'Site 2', reason: 'CONSENT_MISSING' },
        ],
      }),
    });
    expect(await none.service.start(USER)).toMatchObject({
      phase: 'NOT_ENROLLED',
      notMonitored: [{ id: project(2).project_id, name: 'Site 2', reason: 'CONSENT_MISSING' }],
    });
  });

  it('renews inside the last 7 days: the SDK gets the new secret BEFORE the app stores it', async () => {
    const current = plan();
    const { service, log } = setup({
      plan: current,
      renew: async () => ({
        ok: true,
        token: 'N'.repeat(43),
        expiresAt: new Date(NOW + 30 * DAY).toISOString(),
        renewAfter: new Date(NOW + 23 * DAY).toISOString(),
      }),
    });
    await service.start(USER); // SDK running with the original secret
    log.length = 0;
    current.credential = { status: 'OK', expires_at: new Date(NOW + 5 * DAY).toISOString() };
    const status = await service.refresh();
    expect(log.slice(0, 2)).toEqual([`sdk:${'N'.repeat(43)}`, `store:${'N'.repeat(43)}`]);
    expect(status.credential).toBe('OK');
  });

  it('after expiry renews with the signed-in session (the secret alone can no longer renew)', async () => {
    let secretCalls = 0;
    const { service } = setup({
      plan: plan({
        credential: { status: 'EXPIRED', expires_at: new Date(NOW - DAY).toISOString() },
      }),
      renew: async () => {
        secretCalls += 1;
        return { ok: false, code: 'CREDENTIAL_EXPIRED' };
      },
      session: async () => ({
        schema_version: 1,
        request_id: '11111111-1111-4111-8111-111111111111',
        device_id: DEVICE,
        upload_token: 'S'.repeat(43),
        upload_expires_at: new Date(NOW + 30 * DAY).toISOString(),
        renew_after: new Date(NOW + 23 * DAY).toISOString(),
        access_token: 'S'.repeat(43),
        refresh_token: 'S'.repeat(43),
        expires: Math.floor((NOW + 23 * DAY) / 1000),
      }),
    });
    const status = await service.start(USER);
    expect(secretCalls).toBe(0);
    expect(status).toMatchObject({ phase: 'ACTIVE', credential: 'OK' });
  });

  it('when renewal fails after expiry it says so (CREDENTIAL_EXPIRED) instead of pretending', async () => {
    const { service } = setup({
      plan: plan({
        credential: { status: 'EXPIRED', expires_at: new Date(NOW - DAY).toISOString() },
      }),
      session: async () => {
        throw new Error('offline');
      },
    });
    expect((await service.start(USER)).phase).toBe('CREDENTIAL_EXPIRED');
  });

  it('offline: keeps working from the last downloaded plan, marked stale, without renewing', async () => {
    const online = setup();
    await online.service.start(USER);
    const cached = online.store.plan;
    const offline = setup({ plan: new Error('network') });
    offline.store.plan = cached;
    const status = await offline.service.start(USER);
    expect(status).toMatchObject({ phase: 'ACTIVE', planStale: true });
  });

  it('beyond the iOS budget of 15 regions the rest are shown as not monitored (REGION_BUDGET)', async () => {
    const many = Array.from({ length: 16 }, (_, i) => project(i + 1));
    const { service } = setup({ plan: plan({ projects: many }) });
    const status = await service.start(USER);
    expect(status.monitored).toHaveLength(15);
    expect(status.notMonitored.filter((p) => p.reason === 'REGION_BUDGET')).toHaveLength(1);
  });

  it('tells the server once when monitoring stops (coordinate-free provider change), and when it resumes', async () => {
    const { service, sdk, posted } = setup({
      permission: { location: 'WHEN_IN_USE', precise: false, servicesEnabled: true },
    });
    await service.start(USER);
    await service.refresh();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      event: 'providerchange',
      provider: { status: 4, gps: false, accuracyAuthorization: 1, enabled: true },
    });
    expect(JSON.stringify(posted[0])).not.toMatch(/latitude|longitude|coords/);
    sdk.permissionState = { location: 'ALWAYS', precise: true, servicesEnabled: true };
    await service.refresh();
    expect(posted).toHaveLength(2);
    expect(posted[1]).toMatchObject({ provider: { status: 3, gps: true } });
  });

  it('stop (sign-out) disarms, drops the queue and forgets the cached plan', async () => {
    const { service, store, sdk } = setup();
    await service.start(USER);
    await service.stop();
    expect(service.current).toMatchObject({ phase: 'NO_DEVICE', mode: 'DISARMED' });
    expect(store.plan).toBeNull();
    expect(await sdk.count()).toBe(0);
  });
});
