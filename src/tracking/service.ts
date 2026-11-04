import { distanceMeters } from '@sitemuster/shared';

import type { SiteMusterApi } from '../api/types';
import type { StoredDevice } from '../device/device-store';
import { type ControllerStore, TrackingAgent } from './agent';
import type { ControllerFence, TrackingMode } from './controller';
import {
  credentialState,
  type CredentialState,
  expiryFromRenewAfter,
  renewAfterEpochSeconds,
  renewalDue,
  type RenewOutcome,
  tokenFingerprint,
} from './credential';
import type { PermissionSnapshot, StoredAuthorization, TrackerDriver } from './driver';
import { gateFences, regionBudget, selectMonitoredProjects, type TrackingPlan } from './plan';
import { authorizationConfig, buildSdkConfig, type PermissionRationaleText } from './sdk-config';

/**
 * Turns the server plan, the device secret and the OS permissions into an armed (or disarmed)
 * tracker, and exposes one status for the UI (docs/spec/03; decisions #44, #89–#93). React-free.
 */
export type TrackingPhase =
  | 'STARTING'
  | 'NO_DEVICE'
  | 'NOT_ENROLLED'
  | 'DEVICE_REVOKED'
  | 'PERMISSION_REQUIRED'
  | 'CREDENTIAL_EXPIRED'
  | 'TRACKING_LIMITED'
  | 'ACTIVE'
  | 'UNAVAILABLE';

export interface TrackingStatus {
  phase: TrackingPhase;
  mode: TrackingMode;
  permission: PermissionSnapshot | null;
  credential: CredentialState;
  credentialExpiresAt: string | null;
  coordinatesAllowed: boolean;
  monitored: { id: string; name: string }[];
  notMonitored: { id: string; name: string; reason: string }[];
  /** Records waiting in the native location queue (location/geofence only, decision #23). */
  queued: number;
  lastHttpStatus: number | null;
  /** The plan comes from the last successful download (offline). */
  planStale: boolean;
}

/** Which device and secret the SDK was last known to hold (decision #97). */
export interface SdkCredentialRecord {
  deviceId: string;
  /** SHA-256 (hex) of the secret the app last gave the SDK or adopted from it. */
  tokenSha256: string;
}

export interface TrackingStore extends ControllerStore {
  loadPlan(): Promise<TrackingPlan | null>;
  savePlan(plan: TrackingPlan): Promise<void>;
  loadSdkCredential(): Promise<SdkCredentialRecord | null>;
  saveSdkCredential(record: SdkCredentialRecord): Promise<void>;
  clear(): Promise<void>;
}

interface HeldCredential {
  token: string;
  expiresAt: string;
}

interface UsableCredential extends HeldCredential {
  /** A new secret the server just issued: the SDK gets it first, then the app keeps it. */
  renewed: boolean;
  state: CredentialState;
}

/** A start begun or queued before stop(): it must not save, renew or arm anything afterwards. */
class StartCancelled extends Error {}

const DAY = 86_400_000;

export interface TrackingServiceDeps {
  api: Pick<SiteMusterApi, 'getTrackingPlan' | 'renewDeviceWithSession'>;
  driver: TrackerDriver;
  store: TrackingStore;
  devices: {
    load(userId: string): Promise<StoredDevice | null>;
    updateToken(userId: string, token: string, expiresAt: string): Promise<unknown>;
  };
  urls: { ingest: string; renew: string };
  platform: 'ios' | 'android';
  appVersion: string;
  now(): number;
  /** Localized Android foreground-service notification, read when the SDK starts. */
  notification(): { title: string; text: string; channelName: string };
  /** Localized Android 11+ "Allow all the time" explanation, read when the SDK starts. */
  permissionRationale?(): PermissionRationaleText;
  renewWithSecret(token: string): Promise<RenewOutcome>;
  /**
   * Sends one coordinate-free record straight to ingest-location-batch with the device secret
   * (decision #95): used only for permission/provider changes, which the native queue never holds.
   */
  postRecord(record: Record<string, unknown>, token: string): Promise<boolean>;
  newUuid(): string;
  /** Non-fatal problems (warn-level, ids and codes only). */
  report(entry: Record<string, unknown>): void;
}

const INITIAL: TrackingStatus = {
  phase: 'STARTING',
  mode: 'DISARMED',
  permission: null,
  credential: 'NONE',
  credentialExpiresAt: null,
  coordinatesAllowed: false,
  monitored: [],
  notMonitored: [],
  queued: 0,
  lastHttpStatus: null,
  planStale: false,
};

export const permissionUsable = (permission: PermissionSnapshot): boolean =>
  permission.location === 'ALWAYS' && permission.precise && permission.servicesEnabled;

export class TrackingService {
  private readonly agent: TrackingAgent;
  private readonly listeners = new Set<(status: TrackingStatus) => void>();
  private detach: (() => void) | null = null;
  private restored = false;
  private ready = false;
  private userId: string | null = null;
  private status: TrackingStatus = INITIAL;
  /** Last permission usability the server was told about (null = not reported yet). */
  private reportedUsable: boolean | null = null;
  private pending: Promise<void> = Promise.resolve();
  /** Bumped by stop(); a start checks it after every await (decision #97 / sign-out race). */
  private epoch = 0;

  constructor(private readonly deps: TrackingServiceDeps) {
    this.agent = new TrackingAgent(deps.driver, deps.store, {
      state: (state) => this.patch({ mode: state.mode }),
      provider: (permission) => {
        this.patch({ permission, phase: this.phaseFor(permission) });
        void this.reportMonitoring(permission);
      },
      http: (status) => this.patch({ lastHttpStatus: status }),
      authorization: (event) => void this.onNativeRefresh(event),
      failure: (failure) =>
        deps.report({
          area: 'tracking',
          command: failure.command,
          error: failure.error instanceof Error ? failure.error.message : 'unknown',
        }),
    });
  }

  get current(): TrackingStatus {
    return this.status;
  }

  subscribe(listener: (status: TrackingStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }

  /**
   * Sign-in, app start, foreground: re-read everything and (re-)arm. Calls are serialized, so
   * overlapping triggers (start, foreground, phone set-up) never initialize the SDK twice.
   */
  start(userId: string): Promise<TrackingStatus> {
    const epoch = this.epoch;
    return this.serialized(async () => {
      try {
        return await this.startNow(userId, () => {
          if (epoch !== this.epoch) throw new StartCancelled();
        });
      } catch (error) {
        if (error instanceof StartCancelled) return this.status;
        throw error;
      }
    });
  }

  /** Stop listening without touching the SDK or its queue (the service is being replaced). */
  release(): void {
    this.detach?.();
    this.detach = null;
    this.listeners.clear();
  }

  private serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = this.pending.then(task);
    this.pending = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** `live()` throws once stop() was called: checked after every await, before any write. */
  private async startNow(userId: string, live: () => void): Promise<TrackingStatus> {
    live();
    this.userId = userId;
    if (!this.restored) {
      await this.agent.restore();
      this.restored = true;
    }
    live();
    this.detach ??= this.agent.attach();
    const device = await this.deps.devices.load(userId);
    live();
    if (!device) return this.stopWith('NO_DEVICE');

    let plan: TrackingPlan | null = null;
    let planStale = false;
    try {
      plan = await this.deps.api.getTrackingPlan(this.deps.appVersion);
      live();
      await this.deps.store.savePlan(plan);
    } catch (error) {
      if (error instanceof StartCancelled) throw error;
      this.deps.report({ area: 'tracking', step: 'plan', error: errorText(error) });
      plan = await this.deps.store.loadPlan();
      planStale = true;
    }
    live();
    if (!plan) return this.patch({ phase: 'UNAVAILABLE', planStale: true });
    if (plan.device_id !== device.deviceId) return this.stopWith('DEVICE_REVOKED');
    if (plan.projects.length === 0) {
      return this.stopWith('NOT_ENROLLED', {
        notMonitored: plan.not_monitored.map((p) => ({
          id: p.project_id,
          name: p.project_name,
          reason: p.reason,
        })),
      });
    }

    const held = await this.heldCredential(userId, device, live);
    const credential = await this.renewIfDue(held, plan, planStale, live);

    const permission = await this.deps.driver.permission();
    live();
    const budget = regionBudget(this.deps.platform);
    const selection = selectMonitoredProjects({
      plan,
      insideProjectIds: this.agent.current.inside,
      lastPosition: null,
      now: this.deps.now(),
      budget,
      distance: distanceMeters,
    });
    const settings = new Map(plan.projects.map((p) => [p.project_id, p.settings]));
    const fences: ControllerFence[] = gateFences(plan)
      .filter((fence) => selection.monitored.includes(fence.projectId))
      .map((fence) => ({
        ...fence,
        dwellSeconds: numberSetting(settings.get(fence.projectId), 'entry_dwell_seconds', 600),
        maxAccuracyM: numberSetting(settings.get(fence.projectId), 'max_horizontal_accuracy_m', 75),
      }));
    const names = new Map(plan.projects.map((p) => [p.project_id, p.project_name]));
    this.patch({
      permission,
      credential: credential.state,
      credentialExpiresAt: credential.expiresAt,
      coordinatesAllowed: plan.coordinates_allowed,
      monitored: selection.monitored.map((id) => ({ id, name: names.get(id) ?? id })),
      notMonitored: [
        ...plan.not_monitored.map((p) => ({
          id: p.project_id,
          name: p.project_name,
          reason: p.reason,
        })),
        ...selection.unmonitored.map((id) => ({
          id,
          name: names.get(id) ?? id,
          reason: 'REGION_BUDGET',
        })),
      ],
      planStale,
    });

    // No automatic OS prompt: the SDK starts only after SiteMuster's own permission screens.
    await this.reportMonitoring(permission);
    live();
    if (!permissionUsable(permission)) {
      // The SDK is not (re)started: a running SDK gets a renewed secret now, else at next start.
      if (credential.renewed) {
        if (this.ready) await this.giveSdkCredential(device.deviceId, credential);
        await this.deps.devices.updateToken(userId, credential.token, credential.expiresAt);
      }
      return this.patch({ phase: 'PERMISSION_REQUIRED', queued: await this.safeCount() });
    }
    if (!this.ready) {
      const onsite =
        this.agent.current.mode === 'ENTRY_PENDING' ||
        this.agent.current.mode === 'ONSITE_ESTIMATED';
      await this.deps.driver.ready(
        buildSdkConfig(
          {
            ingestUrl: this.deps.urls.ingest,
            renewUrl: this.deps.urls.renew,
            token: credential.token,
            renewAfterEpochSeconds: renewAfterEpochSeconds(credential.expiresAt),
            notification: this.deps.notification(),
            permissionRationale: this.deps.permissionRationale?.(),
          },
          onsite ? 'ONSITE' : 'OFFSITE',
        ),
      );
      this.ready = true;
      await this.rememberSdkCredential(device.deviceId, credential.token);
    } else {
      await this.giveSdkCredential(device.deviceId, credential);
    }
    // The SDK has the secret before the app keeps it (decision #44).
    if (credential.renewed) {
      await this.deps.devices.updateToken(userId, credential.token, credential.expiresAt);
    }
    live();
    await this.agent.arm(fences, plan.coordinates_allowed);
    return this.patch({
      phase:
        credential.state === 'EXPIRED'
          ? 'CREDENTIAL_EXPIRED'
          : plan.coordinates_allowed
            ? 'ACTIVE'
            : 'TRACKING_LIMITED',
      queued: await this.safeCount(),
    });
  }

  refresh(): Promise<TrackingStatus> {
    return this.userId ? this.start(this.userId) : Promise.resolve(this.status);
  }

  async requestPermission(): Promise<TrackingStatus> {
    const permission = await this.deps.driver.requestPermission();
    this.patch({ permission });
    return this.refresh();
  }

  async syncNow(): Promise<TrackingStatus> {
    await this.agent.sync();
    return this.patch({ queued: await this.safeCount() });
  }

  /**
   * Signed out / consent withdrawn: stop, drop the queue and the cached plan. A start that is
   * running or queued is cancelled first and finishes (at its next await) before the disarm.
   */
  async stop(): Promise<void> {
    this.epoch += 1;
    this.userId = null;
    await this.serialized(async () => {
      await this.agent.disarm();
      this.detach?.();
      this.detach = null;
      await this.deps.store.clear();
      this.reportedUsable = null;
      this.patch({ ...INITIAL, phase: 'NO_DEVICE' });
    });
  }

  // ------------------------------------------------------------------------------------------

  private async stopWith(
    phase: TrackingPhase,
    extra: Partial<TrackingStatus> = {},
  ): Promise<TrackingStatus> {
    if (this.agent.current.mode !== 'DISARMED') await this.agent.disarm();
    return this.patch({ ...INITIAL, phase, mode: 'DISARMED', ...extra });
  }

  private async giveSdkCredential(deviceId: string, credential: HeldCredential): Promise<void> {
    await this.deps.driver.setConfig({
      authorization: authorizationConfig({
        token: credential.token,
        renewUrl: this.deps.urls.renew,
        renewAfterEpochSeconds: renewAfterEpochSeconds(credential.expiresAt),
      }),
    });
    await this.rememberSdkCredential(deviceId, credential.token);
  }

  /** Which secret the SDK now holds, so a later native refresh can be told apart (#97). */
  private rememberSdkCredential(deviceId: string, token: string): Promise<void> {
    return this.deps.store.saveSdkCredential({ deviceId, tokenSha256: tokenFingerprint(token) });
  }

  /**
   * The secret this phone should use. The SDK may have refreshed it natively — also while the app
   * was closed — and the app must not overwrite that with its older copy. The SDK's persisted
   * secret is adopted only when it belongs to this same device and is not the one the app last
   * knew it held (decision #97): after a sign-out and a new activation the SDK still holds the old
   * phone's revoked secret, and after a renewal the SDK never received it holds the replaced one.
   */
  private async heldCredential(
    userId: string,
    device: StoredDevice,
    live: () => void,
  ): Promise<HeldCredential> {
    const own = { token: device.uploadToken, expiresAt: device.uploadExpiresAt };
    const known = await this.deps.store.loadSdkCredential();
    live();
    if (!known || known.deviceId !== device.deviceId) return own;
    let native: StoredAuthorization | null;
    try {
      native = await this.deps.driver.storedAuthorization();
    } catch (error) {
      this.deps.report({ area: 'tracking', step: 'sdk-credential', error: errorText(error) });
      return own;
    }
    live();
    if (!native || native.token === own.token) return own;
    const fingerprint = tokenFingerprint(native.token);
    if (fingerprint === known.tokenSha256) return own;
    const expiresAt =
      native.renewAfterEpoch === null
        ? own.expiresAt
        : expiryFromRenewAfter(native.renewAfterEpoch);
    await this.deps.devices.updateToken(userId, native.token, expiresAt);
    await this.rememberSdkCredential(device.deviceId, native.token);
    return { token: native.token, expiresAt };
  }

  /**
   * Renews inside the last 7 days, after expiry, and whenever the downloaded plan names another
   * active credential than the one this phone holds — e.g. a renewal response that never arrived:
   * the held secret then stops working when its 24-hour overlap ends (decision #97). Offline
   * (stale plan) nothing is renewed.
   */
  private async renewIfDue(
    held: HeldCredential,
    plan: TrackingPlan,
    planStale: boolean,
    live: () => void,
  ): Promise<UsableCredential> {
    const now = this.deps.now();
    const active = planStale ? null : plan.credential.expires_at;
    const replaced =
      active !== null && renewAfterEpochSeconds(active) !== renewAfterEpochSeconds(held.expiresAt);
    const keep: UsableCredential = {
      ...held,
      renewed: false,
      state: credentialState(held.expiresAt, now),
    };
    if (planStale || (!replaced && !renewalDue(held.expiresAt, now))) return keep;
    let outcome: RenewOutcome =
      keep.state === 'EXPIRED'
        ? { ok: false, code: 'CREDENTIAL_EXPIRED' }
        : await this.deps.renewWithSecret(held.token);
    live();
    if (!outcome.ok) {
      // The signed-in session proves who the worker is (also after expiry).
      try {
        const renewed = await this.deps.api.renewDeviceWithSession(this.deps.appVersion);
        outcome = {
          ok: true,
          token: renewed.upload_token,
          expiresAt: renewed.upload_expires_at,
          renewAfter: renewed.renew_after,
        };
      } catch (error) {
        this.deps.report({ area: 'tracking', step: 'renew', error: errorText(error) });
        live();
        if (!replaced) return keep;
        // A replaced secret ends with its overlap (24 hours at most): never shown as valid.
        const overlapEnd = new Date(Math.min(Date.parse(held.expiresAt), now + DAY)).toISOString();
        return { ...held, expiresAt: overlapEnd, renewed: false, state: 'EXPIRING' };
      }
      live();
    }
    return {
      token: outcome.token,
      expiresAt: outcome.expiresAt,
      renewed: true,
      state: credentialState(outcome.expiresAt, now),
    };
  }

  /** The SDK refreshed its secret natively while the app runs: keep it and remember it. */
  private async onNativeRefresh(event: {
    success: boolean;
    token: string | null;
    renewAfterEpoch: number | null;
    expiresAt: string | null;
  }): Promise<void> {
    const userId = this.userId;
    if (!event.success || !event.token || !userId) {
      this.patch({ lastHttpStatus: 401 });
      return;
    }
    const expiresAt =
      event.expiresAt ??
      (event.renewAfterEpoch === null
        ? this.status.credentialExpiresAt
        : expiryFromRenewAfter(event.renewAfterEpoch));
    const device = await this.deps.devices.load(userId);
    if (device && userId === this.userId) {
      await this.rememberSdkCredential(device.deviceId, event.token);
      if (expiresAt) await this.deps.devices.updateToken(userId, event.token, expiresAt);
    }
    this.patch({
      credential: credentialState(expiresAt, this.deps.now()),
      credentialExpiresAt: expiresAt,
    });
  }

  /**
   * Tells the server when automatic monitoring stops or resumes (spec 03: MONITORING_UNAVAILABLE),
   * with a coordinate-free provider-change record. Only changes are sent; a failed send is retried
   * at the next start. The server never infers a departure from it.
   */
  private async reportMonitoring(permission: PermissionSnapshot): Promise<void> {
    const usable = permissionUsable(permission);
    if (this.reportedUsable === usable || !this.userId) return;
    // Nothing to stop yet if the phone was never armed and permission was never usable.
    if (this.reportedUsable === null && usable) {
      this.reportedUsable = true;
      return;
    }
    const device = await this.deps.devices.load(this.userId);
    if (!device) return;
    const sent = await this.deps.postRecord(
      {
        uuid: this.deps.newUuid(),
        timestamp: new Date(this.deps.now()).toISOString(),
        event: 'providerchange',
        provider: {
          enabled: permission.servicesEnabled,
          status:
            permission.location === 'ALWAYS' ? 3 : permission.location === 'WHEN_IN_USE' ? 4 : 2,
          gps: permission.precise,
          network: true,
          accuracyAuthorization: permission.precise ? 0 : 1,
        },
      },
      device.uploadToken,
    );
    if (sent) this.reportedUsable = usable;
    else this.deps.report({ area: 'tracking', step: 'monitoring-report', usable });
  }

  private phaseFor(permission: PermissionSnapshot): TrackingPhase {
    if (!permissionUsable(permission)) return 'PERMISSION_REQUIRED';
    if (this.status.phase !== 'PERMISSION_REQUIRED') return this.status.phase;
    return this.status.coordinatesAllowed ? 'ACTIVE' : 'TRACKING_LIMITED';
  }

  private async safeCount(): Promise<number> {
    try {
      return await this.deps.driver.count();
    } catch (error) {
      this.deps.report({ area: 'tracking', step: 'count', error: errorText(error) });
      return this.status.queued;
    }
  }

  private patch(next: Partial<TrackingStatus>): TrackingStatus {
    this.status = { ...this.status, ...next };
    for (const listener of this.listeners) listener(this.status);
    return this.status;
  }
}

function numberSetting(
  settings: Record<string, unknown> | undefined,
  key: string,
  fallback: number,
): number {
  const value = settings?.[key];
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : fallback;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown';
}
