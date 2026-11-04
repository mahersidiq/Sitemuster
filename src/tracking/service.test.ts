import type { Config } from 'react-native-background-geolocation';
import { describe, expect, it } from 'vitest';

import { type DeviceRenewResponse, iso } from '@sitemuster/shared';

import type { StoredDevice } from '../device/device-store';
import type { ControllerState } from './controller';
import { renewAfterEpochSeconds } from './credential';
import type { TrackingPlan } from './plan';
import {
  type SdkCredentialRecord,
  TrackingService,
  type TrackingServiceDeps,
  type TrackingStore,
} from './service';
import { SimulatedSdk, type Transport } from './simulated-driver';

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
  sdkCredential: SdkCredentialRecord | null = null;
  async loadSdkCredential() {
    return this.sdkCredential;
  }
  async saveSdkCredential(record: SdkCredentialRecord) {
    this.sdkCredential = { ...record };
  }
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
    this.sdkCredential = null;
  }
}

function setup(
  options: {
    plan?: TrackingPlan | Error | (() => Promise<TrackingPlan>);
    device?: StoredDevice | null;
    permission?: SimulatedSdk['permissionState'];
    renew?: TrackingServiceDeps['renewWithSecret'];
    session?: () => Promise<DeviceRenewResponse>;
    transport?: Transport;
    /** Expiry of the secret the app holds (default: the plan's, 20 days ahead). */
    heldExpiresAt?: number;
  } = {},
) {
  const sdk = new SimulatedSdk(
    options.transport ?? (async () => ({ status: 200, json: {} })),
    '2026-11-04T12:00:00Z',
  );
  if (options.permission) sdk.permissionState = options.permission;
  const store = new MemoryTrackingStore();
  const log: string[] = [];
  const posted: Record<string, unknown>[] = [];
  const phone: { device: StoredDevice | null } = {
    device:
      options.device === undefined
        ? {
            userId: USER,
            deviceId: DEVICE,
            badgeSecret: 'b'.repeat(43),
            uploadToken: 'A'.repeat(43),
            uploadExpiresAt: new Date(options.heldExpiresAt ?? NOW + 20 * DAY).toISOString(),
          }
        : options.device,
  };
  const originalSetConfig = sdk.setConfig.bind(sdk);
  sdk.setConfig = async (config) => {
    if (config.authorization) log.push(`sdk:${config.authorization.accessToken}`);
    await originalSetConfig(config);
  };
  let readyCalls = 0;
  const originalReady = sdk.ready.bind(sdk);
  sdk.ready = async (config) => {
    readyCalls += 1;
    log.push(`ready:${config.authorization?.accessToken}`);
    await originalReady(config);
  };
  const deps: TrackingServiceDeps = {
    api: {
      getTrackingPlan: async () => {
        if (options.plan instanceof Error) throw options.plan;
        if (typeof options.plan === 'function') return options.plan();
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
      load: async () => (phone.device ? { ...phone.device } : null),
      // Like the device store: a wiped (signed-out) phone is never written back.
      updateToken: async (_user, token, expiresAt) => {
        log.push(`store:${token}`);
        if (phone.device)
          phone.device = { ...phone.device, uploadToken: token, uploadExpiresAt: expiresAt };
      },
    },
    urls: {
      ingest: 'https://x.test/functions/v1/ingest-location-batch',
      renew: 'https://x.test/functions/v1/device-renew',
    },
    platform: 'ios',
    appVersion: '0.3.0',
    now: () => NOW,
    notification: () => ({ title: 't', text: 'x', channelName: 'c' }),
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
    /** The same phone after the app was closed and opened again (the SDK keeps its state). */
    coldStart: (changes: Partial<TrackingServiceDeps> = {}) =>
      new TrackingService({ ...deps, ...changes }),
    deps,
    sdk,
    store,
    phone,
    log,
    posted,
    readyCalls: () => readyCalls,
  };
}

const sessionRenewal = (token: string, expiresAt: number): DeviceRenewResponse => ({
  schema_version: 1,
  request_id: '11111111-1111-4111-8111-111111111111',
  device_id: DEVICE,
  upload_token: token,
  upload_expires_at: new Date(expiresAt).toISOString(),
  renew_after: new Date(expiresAt - 7 * DAY).toISOString(),
  access_token: token,
  refresh_token: token,
  expires: Math.floor((expiresAt - 7 * DAY) / 1000),
});

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

  describe('asking for permission after the disclosure (decision #153)', () => {
    const ALWAYS = { location: 'ALWAYS', precise: true, servicesEnabled: true } as const;
    const UNSET = { location: 'NOT_DETERMINED', precise: true, servicesEnabled: true } as const;
    const RATIONALE = {
      title: 'Allow location all the time?',
      message: 'Needed to count you on site while the app is closed.',
      positiveAction: 'Change to "Allow all the time"',
      negativeAction: 'Not now',
    };

    /** The SDK as it is when it asks: configured or not, armed or not. */
    function watchRequests(
      rig: ReturnType<typeof setup>,
      service: TrackingService,
      grant: boolean,
    ) {
      const order: string[] = [];
      let configured: Config | null = null;
      const ready = rig.sdk.ready.bind(rig.sdk);
      rig.sdk.ready = async (config) => {
        configured = structuredClone(config);
        order.push('ready');
        await ready(config);
      };
      rig.sdk.requestPermission = async () => {
        order.push(`request:${service.current.mode}`);
        if (grant) rig.sdk.permissionState = { ...ALWAYS };
        else rig.sdk.permissionState = { ...UNSET, location: 'WHEN_IN_USE' };
        return rig.sdk.permissionState;
      };
      return { order, configured: () => configured as Config | null };
    }

    it('configures the SDK first, so it asks with "Always" and the Android 11+ rationale', async () => {
      const rig = setup({ permission: { ...UNSET } });
      const service = rig.coldStart({ permissionRationale: () => RATIONALE });
      expect((await service.start(USER)).phase).toBe('PERMISSION_REQUIRED');
      expect(rig.readyCalls()).toBe(0);
      const watch = watchRequests(rig, service, true);

      const status = await service.requestPermission();
      // Configured before the request, and nothing armed while it asked.
      expect(watch.order).toEqual(['ready', 'request:DISARMED']);
      expect(watch.configured()?.app?.backgroundPermissionRationale).toEqual(RATIONALE);
      expect(watch.configured()?.geolocation).toMatchObject({
        locationAuthorizationRequest: 'Always',
        disableLocationAuthorizationAlert: true,
      });
      expect(watch.configured()?.http?.autoSync).toBe(false);
      // Granted: armed with the configuration it already has (configured once).
      expect(status).toMatchObject({ phase: 'ACTIVE', mode: 'ARMED_OFFSITE' });
      expect(rig.readyCalls()).toBe(1);
    });

    it('a refused or partial permission leaves the SDK configured but not armed; asking again does not configure twice', async () => {
      const rig = setup({ permission: { ...UNSET } });
      expect((await rig.service.start(USER)).phase).toBe('PERMISSION_REQUIRED');
      const watch = watchRequests(rig, rig.service, false);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        expect(await rig.service.requestPermission()).toMatchObject({
          phase: 'PERMISSION_REQUIRED',
          mode: 'DISARMED',
        });
      }
      expect(watch.order).toEqual(['ready', 'request:DISARMED', 'request:DISARMED']);
      expect(rig.readyCalls()).toBe(1);
      expect(rig.sdk.wire).toEqual([]);
    });

    it('never asks when the SDK cannot be configured: no phone set up, or not started', async () => {
      const none = setup({ device: null, permission: { ...UNSET } });
      expect((await none.service.start(USER)).phase).toBe('NO_DEVICE');
      const noneWatch = watchRequests(none, none.service, true);
      expect((await none.service.requestPermission()).phase).toBe('NO_DEVICE');
      expect(noneWatch.order).toEqual([]);

      const fresh = setup({ permission: { ...UNSET } });
      const freshWatch = watchRequests(fresh, fresh.service, true);
      await fresh.service.requestPermission();
      expect(freshWatch.order).toEqual([]);
    });

    it('never asks after a sign-out that happens while the SDK is being configured', async () => {
      const rig = setup({ permission: { ...UNSET } });
      expect((await rig.service.start(USER)).phase).toBe('PERMISSION_REQUIRED');
      const watch = watchRequests(rig, rig.service, true);
      const ready = rig.sdk.ready.bind(rig.sdk);
      let signedOut: Promise<void> = Promise.resolve();
      rig.sdk.ready = async (config) => {
        signedOut = rig.service.stop();
        await ready(config);
      };
      await rig.service.requestPermission();
      await signedOut;
      expect(watch.order).toEqual(['ready']);
      expect(rig.service.current).toMatchObject({ phase: 'NO_DEVICE', mode: 'DISARMED' });
    });
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
    const { service, log, phone } = setup({
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
    const soon = new Date(NOW + 5 * DAY).toISOString();
    current.credential = { status: 'OK', expires_at: soon };
    if (phone.device) phone.device.uploadExpiresAt = soon;
    const status = await service.refresh();
    expect(log.slice(0, 2)).toEqual([`sdk:${'N'.repeat(43)}`, `store:${'N'.repeat(43)}`]);
    expect(status.credential).toBe('OK');
  });

  it('after expiry renews with the signed-in session (the secret alone can no longer renew)', async () => {
    let secretCalls = 0;
    const { service } = setup({
      heldExpiresAt: NOW - DAY,
      plan: plan({
        credential: { status: 'EXPIRED', expires_at: new Date(NOW - DAY).toISOString() },
      }),
      renew: async () => {
        secretCalls += 1;
        return { ok: false, code: 'CREDENTIAL_EXPIRED' };
      },
      session: async () => sessionRenewal('S'.repeat(43), NOW + 30 * DAY),
    });
    const status = await service.start(USER);
    expect(secretCalls).toBe(0);
    expect(status).toMatchObject({ phase: 'ACTIVE', credential: 'OK' });
  });

  it('when renewal fails after expiry it says so (CREDENTIAL_EXPIRED) instead of pretending', async () => {
    const { service } = setup({
      heldExpiresAt: NOW - DAY,
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

  it('serializes overlapping starts: the SDK is initialized once', async () => {
    const { service, readyCalls } = setup();
    await Promise.all([service.start(USER), service.start(USER), service.refresh()]);
    expect(readyCalls()).toBe(1);
  });

  it('release (service replaced, e.g. new backend client) keeps the SDK and its queue', async () => {
    const { service, sdk } = setup();
    await service.start(USER);
    await sdk.moveTo('2026-11-04T12:01:00Z', { lat: 29.77, lng: -95.37, accuracy: 10 });
    const before = await sdk.count();
    service.release();
    expect(await sdk.count()).toBe(before);
  });

  it('stop (sign-out) disarms, drops the queue and forgets the cached plan', async () => {
    const { service, store, sdk } = setup();
    await service.start(USER);
    await service.stop();
    expect(service.current).toMatchObject({ phase: 'NO_DEVICE', mode: 'DISARMED' });
    expect(store.plan).toBeNull();
    expect(await sdk.count()).toBe(0);
  });

  describe('the secret the SDK holds (decision #97)', () => {
    const C = 'C'.repeat(43);
    const cExpiry = NOW + 34 * DAY;
    /** The SDK's own refresh answer (device-renew) during a native upload. */
    const renewing: Transport = async (url) =>
      url.endsWith('/device-renew')
        ? {
            status: 200,
            json: {
              access_token: C,
              refresh_token: C,
              expires: renewAfterEpochSeconds(new Date(cExpiry).toISOString()),
              upload_expires_at: new Date(cExpiry).toISOString(),
            },
          }
        : { status: 200, json: {} };

    it('a cold start keeps the secret the SDK renewed natively while the app was closed', async () => {
      const server = plan();
      const rig = setup({ plan: server, transport: renewing });
      await rig.service.start(USER);
      rig.service.release(); // the app is closed: no JavaScript sees what the SDK does now
      rig.sdk.setTime(iso(NOW + 14 * DAY)); // past `expires` (20-day expiry − 7 days)
      await rig.sdk.moveTo(iso(NOW + 14 * DAY), { ...project(1).center, accuracy: 10 });
      expect((await rig.sdk.storedAuthorization())?.token).toBe(C);
      expect(rig.phone.device?.uploadToken).toBe('A'.repeat(43)); // the app never saw it
      server.credential = { status: 'OK', expires_at: new Date(cExpiry).toISOString() };

      const reopened = rig.coldStart();
      const status = await reopened.start(USER);
      expect(rig.log.filter((entry) => entry.startsWith('ready:')).at(-1)).toBe(`ready:${C}`);
      expect((await rig.sdk.storedAuthorization())?.token).toBe(C);
      expect(rig.phone.device?.uploadToken).toBe(C);
      expect(status).toMatchObject({ phase: 'ACTIVE', credential: 'OK' });
    });

    it("after sign-out and a new activation the old phone's secret in the SDK is never adopted", async () => {
      const rig = setup();
      await rig.service.start(USER);
      await rig.service.stop(); // sign-out: the record of what the SDK holds is dropped
      expect(rig.store.sdkCredential).toBeNull();
      const replacement = '5d000000-0000-4000-8000-0000000000a2';
      rig.phone.device = {
        userId: USER,
        deviceId: replacement,
        badgeSecret: 'c'.repeat(43),
        uploadToken: 'Y'.repeat(43),
        uploadExpiresAt: new Date(NOW + 30 * DAY).toISOString(),
      };
      const fresh = plan({
        device_id: replacement,
        credential: { status: 'OK', expires_at: new Date(NOW + 30 * DAY).toISOString() },
      });
      // Even if the sign-out cleanup never ran, a record for another device is ignored.
      rig.store.sdkCredential = { deviceId: DEVICE, tokenSha256: 'stale' };
      const next = rig.coldStart({
        api: { ...rig.deps.api, getTrackingPlan: async () => fresh },
      });
      expect((await next.start(USER)).phase).toBe('ACTIVE');
      expect((await rig.sdk.storedAuthorization())?.token).toBe('Y'.repeat(43));
      expect(rig.phone.device?.uploadToken).toBe('Y'.repeat(43));
    });

    it('a secret renewed while the SDK was not running is not replaced by the older one it holds', async () => {
      const server = plan();
      const rig = setup({ plan: server });
      await rig.service.start(USER); // the SDK holds A
      const soon = new Date(NOW + 5 * DAY).toISOString();
      server.credential = { status: 'OK', expires_at: soon };
      if (rig.phone.device) rig.phone.device.uploadExpiresAt = soon;
      rig.sdk.permissionState = { location: 'WHEN_IN_USE', precise: true, servicesEnabled: true };
      const n = 'N'.repeat(43);
      const nExpiry = new Date(NOW + 30 * DAY).toISOString();
      const reopened = rig.coldStart({
        renewWithSecret: async () => ({
          ok: true,
          token: n,
          expiresAt: nExpiry,
          renewAfter: new Date(NOW + 23 * DAY).toISOString(),
        }),
      });
      expect((await reopened.start(USER)).phase).toBe('PERMISSION_REQUIRED');
      expect(rig.phone.device?.uploadToken).toBe(n);
      expect((await rig.sdk.storedAuthorization())?.token).toBe('A'.repeat(43)); // not started
      server.credential = { status: 'OK', expires_at: nExpiry };
      rig.sdk.permissionState = { location: 'ALWAYS', precise: true, servicesEnabled: true };
      expect((await rig.coldStart().start(USER)).phase).toBe('ACTIVE');
      expect((await rig.sdk.storedAuthorization())?.token).toBe(n);
      expect(rig.phone.device?.uploadToken).toBe(n);
    });

    it('renews when the server names another active secret than the one held (lost renewal response)', async () => {
      let secretCalls = 0;
      const rig = setup({
        plan: plan({
          credential: { status: 'OK', expires_at: new Date(NOW + 29 * DAY).toISOString() },
        }),
        renew: async (token) => {
          secretCalls += 1;
          expect(token).toBe('A'.repeat(43));
          return {
            ok: true,
            token: 'R'.repeat(43),
            expiresAt: new Date(NOW + 30 * DAY).toISOString(),
            renewAfter: new Date(NOW + 23 * DAY).toISOString(),
          };
        },
      });
      const status = await rig.service.start(USER);
      expect(secretCalls).toBe(1);
      expect(status).toMatchObject({ phase: 'ACTIVE', credential: 'OK' });
      expect((await rig.sdk.storedAuthorization())?.token).toBe('R'.repeat(43));
      expect(rig.phone.device?.uploadToken).toBe('R'.repeat(43));
    });

    it('if that renewal fails, the held secret is shown as expiring within a day, never as valid', async () => {
      const rig = setup({
        plan: plan({
          credential: { status: 'OK', expires_at: new Date(NOW + 29 * DAY).toISOString() },
        }),
        renew: async () => ({ ok: false, code: 'CREDENTIAL_SUPERSEDED' }),
        session: async () => {
          throw new Error('session expired');
        },
      });
      const status = await rig.service.start(USER);
      expect(status.credential).toBe('EXPIRING');
      expect(Date.parse(status.credentialExpiresAt ?? '')).toBeLessThanOrEqual(NOW + DAY);
    });

    it('an unreadable SDK configuration falls back to the app copy (reported, never guessed)', async () => {
      const rig = setup();
      await rig.service.start(USER);
      rig.sdk.storedAuthorization = async () => {
        throw new Error('bridge unavailable');
      };
      expect((await rig.coldStart().start(USER)).phase).toBe('ACTIVE');
      expect(rig.log.at(-1)).toBe(`ready:${'A'.repeat(43)}`);
    });
  });

  describe('sign-out while a start is still running', () => {
    it('cancels it: nothing is saved, renewed, configured or armed after stop()', async () => {
      let answer: (value: TrackingPlan) => void = () => undefined;
      const rig = setup({
        heldExpiresAt: NOW + 2 * DAY, // a renewal would be due
        plan: () =>
          new Promise<TrackingPlan>((resolve) => {
            answer = resolve;
          }),
        renew: async () => {
          throw new Error('must not renew after sign-out');
        },
      });
      const first = rig.service.start(USER);
      const second = rig.service.start(USER); // e.g. the foreground refresh, queued behind it
      await Promise.resolve();
      const stopped = rig.service.stop();
      answer(
        plan({ credential: { status: 'OK', expires_at: new Date(NOW + 2 * DAY).toISOString() } }),
      );
      await Promise.all([first, second, stopped]);
      expect(rig.readyCalls()).toBe(0);
      expect(rig.log).toEqual([]);
      expect(rig.store.plan).toBeNull();
      expect(rig.store.sdkCredential).toBeNull();
      expect(rig.service.current).toMatchObject({ phase: 'NO_DEVICE', mode: 'DISARMED' });
      expect(await rig.sdk.count()).toBe(0);
      expect(await rig.service.refresh()).toMatchObject({ phase: 'NO_DEVICE' }); // no user left
      expect(rig.readyCalls()).toBe(0);
    });

    it('a start that already armed is disarmed by the stop that follows it', async () => {
      const rig = setup();
      const started = rig.service.start(USER);
      const stopped = rig.service.stop();
      await Promise.all([started, stopped]);
      expect(rig.service.current).toMatchObject({ phase: 'NO_DEVICE', mode: 'DISARMED' });
      expect(rig.store.state).toBeNull();
    });
  });
});
