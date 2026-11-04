import type { Config } from 'react-native-background-geolocation';

import { distanceMeters, iso, ms } from '@sitemuster/shared';

import type { ControllerFence } from './controller';
import type {
  DriverHandlers,
  PermissionSnapshot,
  StoredAuthorization,
  TrackerDriver,
} from './driver';
import type { QueuedRecord } from './gate';
import { PERSIST_MODE_ALL, PERSIST_MODE_GEOFENCE } from './sdk-config';
import { GEOFENCE_TEMPLATE, LOCATION_TEMPLATE, renderTemplate } from './templates';

/**
 * Simulated Transistorsoft SDK — the "mock trace driver" for CI and development builds
 * (docs/tasks/milestone-07.md; decision #18). It models what matters for privacy and data
 * integrity: persistMode, autoSync, the native queue (records persisted BEFORE JavaScript sees
 * them), coordinate-free templates, whole-batch 2xx acknowledgement, 401 + native token refresh,
 * geofence transitions with initial-entry triggering, and the captured HTTP wire.
 * It is NOT proof of device behaviour; real devices are tested separately (HUMAN_CHECKLIST §9).
 * Never compiled into release bundles: only loaded behind `__DEV__` or from tests.
 */
export const SIMULATED_SDK_MARKER = 'SITEMUSTER-SIMULATED-SDK';

export interface Transport {
  (
    url: string,
    init: { headers: Record<string, string>; body: string; form?: boolean },
  ): Promise<{ status: number; json: unknown }>;
}

interface StoredRecord {
  uuid: string;
  timestamp: string;
  event: string;
  latitude: number;
  longitude: number;
  accuracy: number;
  is_moving: boolean;
  mock: boolean;
  geofence?: { identifier: string; action: 'ENTER' | 'EXIT' };
}

export interface CapturedRequest {
  url: string;
  authorization: string;
  body: string;
  status: number;
}

export class SimulatedSdk implements TrackerDriver {
  readonly kind = 'simulated' as const;
  readonly marker = SIMULATED_SDK_MARKER;
  /** Every HTTP request the SDK sent (the "captured wire"). */
  readonly wire: CapturedRequest[] = [];
  private config: Config = {};
  private mode: 'stopped' | 'geofences' | 'location' = 'stopped';
  private fences = new Map<string, ControllerFence>();
  private insideFences = new Set<string>();
  private queue: StoredRecord[] = [];
  private handlers: DriverHandlers | null = null;
  private position: { lat: number; lng: number; accuracy: number; mock: boolean } | null = null;
  private lastRecorded: { lat: number; lng: number } | null = null;
  private online = true;
  private readonly faults = { queued: 0, destroy: 0 };
  private now: number;
  private counter = 0;
  /** Pending JS callbacks (the SDK delivers events asynchronously). */
  private pending: Promise<unknown> = Promise.resolve();
  permissionState: PermissionSnapshot = {
    location: 'ALWAYS',
    precise: true,
    servicesEnabled: true,
  };

  constructor(
    private readonly transport: Transport,
    start: string,
    private readonly uuid: () => string = () => {
      this.counter += 1;
      return `00000000-0000-4000-8000-${this.counter.toString(16).padStart(12, '0')}`;
    },
  ) {
    this.now = ms(start);
  }

  // ------------------------------------------------------------------ simulation controls

  /** Lets every event delivered so far run its JavaScript handler to completion. */
  async settle(): Promise<void> {
    let before: Promise<unknown>;
    do {
      before = this.pending;
      await before;
    } while (before !== this.pending);
  }

  setNetwork(online: boolean): void {
    this.online = online;
  }

  /** The next `times` calls of a native queue operation fail (an SQLite or bridge error). */
  failNext(operation: 'queued' | 'destroy', times = 1): void {
    this.faults[operation] += times;
  }

  /** A native refresh while the app is closed: no JavaScript listener sees its result. */
  async syncWhileClosed(): Promise<void> {
    const handlers = this.handlers;
    this.handlers = null;
    try {
      await this.upload();
      await this.settle();
    } finally {
      this.handlers = handlers;
    }
  }

  setTime(at: string): void {
    this.now = ms(at);
  }

  /** The phone is now at `point` at time `at`. */
  async moveTo(
    at: string,
    point: { lat: number; lng: number; accuracy: number; mock?: boolean },
  ): Promise<void> {
    this.now = ms(at);
    this.position = { ...point, mock: point.mock ?? false };
    // The native SDK records the location that triggers a transition before JS reacts to it.
    if (this.mode === 'location') {
      const moved =
        !this.lastRecorded ||
        distanceMeters(this.lastRecorded, point) >= (this.config.geolocation?.distanceFilter ?? 25);
      if (moved) this.recordLocation('');
    }
    if (this.mode !== 'stopped') this.evaluateFences();
    await this.autoSync();
    await this.settle();
  }

  async fireHeartbeat(at: string): Promise<void> {
    this.now = ms(at);
    this.deliver(() => this.handlers?.heartbeat());
    await this.settle();
  }

  queueSize(): number {
    return this.queue.length;
  }

  // ------------------------------------------------------------------ TrackerDriver

  async ready(config: Config): Promise<void> {
    this.config = structuredClone(config);
  }

  async setConfig(config: Partial<Config>): Promise<void> {
    const next = structuredClone(this.config) as Record<string, unknown>;
    for (const [section, value] of Object.entries(config)) {
      next[section] =
        value && typeof value === 'object' && !Array.isArray(value)
          ? { ...((next[section] as object | undefined) ?? {}), ...value }
          : value;
    }
    this.config = next as Config;
  }

  async startGeofences(): Promise<void> {
    this.mode = 'geofences';
    this.evaluateFences();
  }

  async startTracking(): Promise<void> {
    this.mode = 'location';
    this.evaluateFences();
  }

  async stop(): Promise<void> {
    this.mode = 'stopped';
  }

  async replaceFences(fences: readonly ControllerFence[]): Promise<void> {
    this.fences = new Map(fences.map((fence) => [fence.identifier, fence]));
    for (const identifier of [...this.insideFences]) {
      if (!this.fences.has(identifier)) this.insideFences.delete(identifier);
    }
    // geofenceInitialTriggerEntry: a fence registered while inside fires ENTER.
    if (this.mode !== 'stopped') this.evaluateFences();
  }

  async currentPosition(persist: boolean): Promise<QueuedRecord | null> {
    if (!this.position) return null;
    const record = this.makeRecord('');
    if (persist && this.persistsLocations()) {
      this.queue.push(record);
      this.lastRecorded = { lat: record.latitude, lng: record.longitude };
      const view = this.view(record);
      this.deliver(() => this.handlers?.location(view));
    }
    return this.view(record);
  }

  async queued(): Promise<QueuedRecord[]> {
    this.fault('queued');
    return this.queue.map((record) => this.view(record));
  }

  async destroy(uuid: string): Promise<void> {
    this.fault('destroy');
    this.queue = this.queue.filter((record) => record.uuid !== uuid);
  }

  async clear(): Promise<void> {
    this.queue = [];
  }

  async sync(): Promise<void> {
    await this.upload();
  }

  async count(): Promise<number> {
    return this.queue.length;
  }

  /** The configuration survives an app restart (the native side keeps it), as on a phone. */
  async storedAuthorization(): Promise<StoredAuthorization | null> {
    const auth = this.config.authorization;
    if (!auth?.accessToken) return null;
    return {
      token: auth.accessToken,
      renewAfterEpoch: typeof auth.expires === 'number' && auth.expires > 0 ? auth.expires : null,
    };
  }

  async permission(): Promise<PermissionSnapshot> {
    return this.permissionState;
  }

  async requestPermission(): Promise<PermissionSnapshot> {
    return this.permissionState;
  }

  subscribe(handlers: DriverHandlers): () => void {
    this.handlers = handlers;
    return () => {
      this.handlers = null;
    };
  }

  // ------------------------------------------------------------------ internals

  private fault(operation: 'queued' | 'destroy'): void {
    if (this.faults[operation] === 0) return;
    this.faults[operation] -= 1;
    throw new Error(`SIMULATED_${operation.toUpperCase()}_FAILURE`);
  }

  private deliver(callback: () => unknown): void {
    this.pending = this.pending.then(() => callback());
  }

  private persistsLocations(): boolean {
    return this.config.persistence?.persistMode === PERSIST_MODE_ALL;
  }

  private persistsGeofences(): boolean {
    const mode = this.config.persistence?.persistMode;
    return mode === PERSIST_MODE_ALL || mode === PERSIST_MODE_GEOFENCE;
  }

  private makeRecord(event: string): StoredRecord {
    const position = this.position as NonNullable<SimulatedSdk['position']>;
    return {
      uuid: this.uuid(),
      timestamp: iso(this.now),
      event,
      latitude: position.lat,
      longitude: position.lng,
      accuracy: position.accuracy,
      is_moving: true,
      mock: position.mock,
    };
  }

  private view(record: StoredRecord): QueuedRecord {
    return {
      uuid: record.uuid,
      timestamp: record.timestamp,
      event: record.event === '' ? 'location' : record.event,
      mock: record.mock,
      coords: { latitude: record.latitude, longitude: record.longitude, accuracy: record.accuracy },
      ...(record.geofence ? { geofence: record.geofence } : {}),
    };
  }

  private recordLocation(event: string): void {
    const record = this.makeRecord(event);
    this.lastRecorded = { lat: record.latitude, lng: record.longitude };
    if (!this.persistsLocations()) return;
    this.queue.push(record);
    const view = this.view(record);
    this.deliver(() => this.handlers?.location(view));
  }

  private evaluateFences(): void {
    if (!this.position) return;
    for (const fence of this.fences.values()) {
      const inside = distanceMeters(this.position, fence.center) <= fence.nativeRadiusM;
      const was = this.insideFences.has(fence.identifier);
      if (inside === was) continue;
      if (inside) this.insideFences.add(fence.identifier);
      else this.insideFences.delete(fence.identifier);
      const action = inside ? 'ENTER' : 'EXIT';
      const record = {
        ...this.makeRecord('geofence'),
        geofence: { identifier: fence.identifier, action },
      } as StoredRecord;
      if (this.persistsGeofences()) this.queue.push(record);
      const timestamp = record.timestamp;
      this.deliver(() =>
        this.handlers?.geofence({ identifier: fence.identifier, action, timestamp }),
      );
    }
  }

  private async autoSync(): Promise<void> {
    if (this.config.http?.autoSync) await this.upload();
  }

  private render(record: StoredRecord): unknown {
    const values = {
      uuid: record.uuid,
      timestamp: record.timestamp,
      event: record.event,
      latitude: record.latitude,
      longitude: record.longitude,
      accuracy: record.accuracy,
      is_moving: record.is_moving,
      mock: record.mock,
      'geofence.identifier': record.geofence?.identifier,
      'geofence.action': record.geofence?.action,
    };
    const template = record.geofence
      ? (this.config.persistence?.geofenceTemplate ?? GEOFENCE_TEMPLATE)
      : (this.config.persistence?.locationTemplate ?? LOCATION_TEMPLATE);
    return JSON.parse(renderTemplate(template, values));
  }

  private async upload(): Promise<void> {
    const http = this.config.http ?? {};
    if (!http.url || !this.online) return;
    let refreshed = false;
    // Proactive native refresh once `expires` (epoch seconds) has passed (decision #92).
    const expires = this.config.authorization?.expires;
    if (
      this.queue.length > 0 &&
      typeof expires === 'number' &&
      expires > 0 &&
      expires * 1000 <= this.now
    ) {
      refreshed = true;
      if (!(await this.refresh())) return;
    }
    while (this.queue.length > 0) {
      const size = http.batchSync ? (http.maxBatchSize ?? 25) : 1;
      const batch = this.queue.slice(0, size);
      const root = http.rootProperty ?? 'locations';
      const body = JSON.stringify({ [root]: batch.map((record) => this.render(record)) });
      const token = this.config.authorization?.accessToken ?? '';
      const response = await this.transport(http.url, {
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body,
      });
      this.wire.push({
        url: http.url,
        authorization: `Bearer ${token}`,
        body,
        status: response.status,
      });
      this.deliver(() => this.handlers?.http({ status: response.status }));
      if (response.status >= 200 && response.status < 300) {
        // 2xx acknowledges (and deletes) the WHOLE batch.
        const sent = new Set(batch.map((record) => record.uuid));
        this.queue = this.queue.filter((record) => !sent.has(record.uuid));
        continue;
      }
      if (response.status === 401 && !refreshed && (await this.refresh())) {
        refreshed = true;
        continue;
      }
      return; // 401 after refresh, 429, 5xx: keep the queue for a later attempt
    }
  }

  /** Native authorization refresh: FORM POST to refreshUrl with the refresh token. */
  private async refresh(): Promise<boolean> {
    const auth = this.config.authorization;
    if (!auth?.refreshUrl || !auth.refreshToken) return false;
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(auth.refreshPayload ?? {})) {
      form.set(key, value.replace('{refreshToken}', auth.refreshToken));
    }
    const response = await this.transport(auth.refreshUrl, {
      headers: {
        authorization: `Bearer ${auth.accessToken}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
      form: true,
    });
    const json = (response.json ?? {}) as Record<string, unknown>;
    const success = response.status === 200 && typeof json.access_token === 'string';
    if (success) {
      await this.setConfig({
        authorization: {
          ...auth,
          accessToken: json.access_token as string,
          refreshToken: (json.refresh_token as string | undefined) ?? (json.access_token as string),
          expires: typeof json.expires === 'number' ? json.expires : auth.expires,
        },
      });
    }
    this.deliver(() =>
      this.handlers?.authorization({
        success,
        token: success ? (json.access_token as string) : null,
        renewAfterEpoch: success && typeof json.expires === 'number' ? json.expires : null,
        expiresAt:
          success && typeof json.upload_expires_at === 'string' ? json.upload_expires_at : null,
      }),
    );
    return success;
  }
}
