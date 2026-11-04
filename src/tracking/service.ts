import { distanceMeters } from '@sitemuster/shared';

import type { SiteMusterApi } from '../api/types';
import type { StoredDevice } from '../device/device-store';
import { type ControllerStore, TrackingAgent } from './agent';
import type { ControllerFence, TrackingMode } from './controller';
import {
  credentialState,
  type CredentialState,
  renewAfterEpochSeconds,
  renewalDue,
  type RenewOutcome,
} from './credential';
import type { PermissionSnapshot, TrackerDriver } from './driver';
import { gateFences, regionBudget, selectMonitoredProjects, type TrackingPlan } from './plan';
import { authorizationConfig, buildSdkConfig } from './sdk-config';

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

export interface TrackingStore extends ControllerStore {
  loadPlan(): Promise<TrackingPlan | null>;
  savePlan(plan: TrackingPlan): Promise<void>;
  clear(): Promise<void>;
}

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
    const run = this.pending.then(() => this.startNow(userId));
    this.pending = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Stop listening without touching the SDK or its queue (the service is being replaced). */
  release(): void {
    this.detach?.();
    this.detach = null;
    this.listeners.clear();
  }

  private async startNow(userId: string): Promise<TrackingStatus> {
    this.userId = userId;
    if (!this.restored) {
      await this.agent.restore();
      this.restored = true;
    }
    this.detach ??= this.agent.attach();
    const device = await this.deps.devices.load(userId);
    if (!device) return this.stopWith('NO_DEVICE');

    let plan: TrackingPlan | null = null;
    let planStale = false;
    try {
      plan = await this.deps.api.getTrackingPlan(this.deps.appVersion);
      await this.deps.store.savePlan(plan);
    } catch (error) {
      this.deps.report({ area: 'tracking', step: 'plan', error: errorText(error) });
      plan = await this.deps.store.loadPlan();
      planStale = true;
    }
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

    const token = await this.currentToken(device, plan);
    const credential = await this.renewIfDue(device, token, plan, planStale);

    const permission = await this.deps.driver.permission();
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
      credential: credentialState(credential.expiresAt, this.deps.now()),
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
    if (!permissionUsable(permission)) {
      return this.patch({ phase: 'PERMISSION_REQUIRED', queued: await this.safeCount() });
    }
    const sdkInput = {
      ingestUrl: this.deps.urls.ingest,
      renewUrl: this.deps.urls.renew,
      token: credential.token,
      renewAfterEpochSeconds: renewAfterEpochSeconds(credential.expiresAt),
      notification: this.deps.notification(),
    };
    if (!this.ready) {
      const onsite =
        this.agent.current.mode === 'ENTRY_PENDING' ||
        this.agent.current.mode === 'ONSITE_ESTIMATED';
      await this.deps.driver.ready(buildSdkConfig(sdkInput, onsite ? 'ONSITE' : 'OFFSITE'));
      this.ready = true;
    } else {
      await this.deps.driver.setConfig({ authorization: authorizationConfig(sdkInput) });
    }
    await this.agent.arm(fences, plan.coordinates_allowed);
    const expired = credentialState(credential.expiresAt, this.deps.now()) === 'EXPIRED';
    return this.patch({
      phase: expired
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

  /** Signed out / consent withdrawn: stop, drop the queue and the cached plan. */
  async stop(): Promise<void> {
    await this.agent.disarm();
    this.detach?.();
    this.detach = null;
    await this.deps.store.clear();
    this.userId = null;
    this.patch({ ...INITIAL, phase: 'NO_DEVICE' });
  }

  // ------------------------------------------------------------------------------------------

  private async stopWith(
    phase: TrackingPhase,
    extra: Partial<TrackingStatus> = {},
  ): Promise<TrackingStatus> {
    if (this.agent.current.mode !== 'DISARMED') await this.agent.disarm();
    return this.patch({ ...INITIAL, phase, mode: 'DISARMED', ...extra });
  }

  /** The SDK may have refreshed its secret natively while the app was closed: adopt it. */
  private async currentToken(device: StoredDevice, plan: TrackingPlan): Promise<string> {
    if (!this.ready) return device.uploadToken;
    const native = await this.deps.driver.accessToken();
    if (native && native !== device.uploadToken && this.userId) {
      await this.deps.devices.updateToken(
        this.userId,
        native,
        plan.credential.expires_at ?? device.uploadExpiresAt,
      );
      return native;
    }
    return device.uploadToken;
  }

  private async renewIfDue(
    device: StoredDevice,
    token: string,
    plan: TrackingPlan,
    planStale: boolean,
  ): Promise<{ token: string; expiresAt: string }> {
    const expiresAt = plan.credential.expires_at ?? device.uploadExpiresAt;
    if (planStale || !renewalDue(expiresAt, this.deps.now()) || !this.userId) {
      return { token, expiresAt };
    }
    let outcome: RenewOutcome =
      credentialState(expiresAt, this.deps.now()) === 'EXPIRED'
        ? { ok: false, code: 'CREDENTIAL_EXPIRED' }
        : await this.deps.renewWithSecret(token);
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
        return { token, expiresAt };
      }
    }
    // The SDK must send the new secret before its next sync, then the app keeps it.
    if (this.ready) {
      await this.deps.driver.setConfig({
        authorization: authorizationConfig({
          token: outcome.token,
          renewUrl: this.deps.urls.renew,
          renewAfterEpochSeconds: renewAfterEpochSeconds(outcome.expiresAt),
        }),
      });
    }
    await this.deps.devices.updateToken(this.userId, outcome.token, outcome.expiresAt);
    return { token: outcome.token, expiresAt: outcome.expiresAt };
  }

  private async onNativeRefresh(event: {
    success: boolean;
    token: string | null;
    expiresAt: string | null;
  }): Promise<void> {
    if (!event.success || !event.token || !this.userId) {
      this.patch({ lastHttpStatus: 401 });
      return;
    }
    const expiresAt = event.expiresAt ?? this.status.credentialExpiresAt;
    if (expiresAt) await this.deps.devices.updateToken(this.userId, event.token, expiresAt);
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
