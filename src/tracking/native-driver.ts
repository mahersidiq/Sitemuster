import BackgroundGeolocation, {
  type Config,
  type Location,
  type ProviderChangeEvent,
  type Subscription,
} from 'react-native-background-geolocation';

import type { ControllerFence } from './controller';
import type {
  DriverHandlers,
  PermissionSnapshot,
  StoredAuthorization,
  TrackerDriver,
} from './driver';
import type { QueuedRecord } from './gate';

/**
 * Transistorsoft react-native-background-geolocation v5 adapter (decision #12). The only module
 * that talks to the native SDK. Native behaviour (background delivery, OS relaunch, headless
 * tasks, the rendered HTTP wire) is verified only on physical devices (HUMAN_CHECKLIST §12).
 */
const STATUS: Record<number, PermissionSnapshot['location']> = {
  0: 'NOT_DETERMINED',
  1: 'RESTRICTED',
  2: 'DENIED',
  3: 'ALWAYS',
  4: 'WHEN_IN_USE',
  5: 'DENIED',
};

export function permissionFromProvider(event: ProviderChangeEvent): PermissionSnapshot {
  return {
    location: STATUS[event.status] ?? 'NOT_DETERMINED',
    precise: event.accuracyAuthorization !== 1, // AccuracyAuthorization.Reduced = 1
    servicesEnabled: event.enabled,
  };
}

function toRecord(value: unknown): QueuedRecord | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.uuid !== 'string') return null;
  const coords = raw.coords as Record<string, unknown> | undefined;
  const geofence = raw.geofence as Record<string, unknown> | undefined;
  return {
    uuid: raw.uuid,
    timestamp: typeof raw.timestamp === 'string' ? raw.timestamp : undefined,
    event: typeof raw.event === 'string' ? raw.event : undefined,
    mock: raw.mock === true,
    coords:
      coords && typeof coords.latitude === 'number' && typeof coords.longitude === 'number'
        ? {
            latitude: coords.latitude,
            longitude: coords.longitude,
            accuracy: typeof coords.accuracy === 'number' ? coords.accuracy : Infinity,
          }
        : undefined,
    geofence:
      geofence && typeof geofence.identifier === 'string'
        ? { identifier: geofence.identifier, action: String(geofence.action) }
        : undefined,
  };
}

export class NativeTrackerDriver implements TrackerDriver {
  readonly kind = 'native' as const;

  async ready(config: Config): Promise<void> {
    await BackgroundGeolocation.ready(config);
  }

  async setConfig(config: Partial<Config>): Promise<void> {
    await BackgroundGeolocation.setConfig(config);
  }

  async startGeofences(): Promise<void> {
    await BackgroundGeolocation.startGeofences();
  }

  async startTracking(): Promise<void> {
    await BackgroundGeolocation.start();
  }

  async stop(): Promise<void> {
    await BackgroundGeolocation.stop();
  }

  async replaceFences(fences: readonly ControllerFence[]): Promise<void> {
    const wanted = new Map(fences.map((fence) => [fence.identifier, fence]));
    const existing = await BackgroundGeolocation.getGeofences();
    const stale = existing
      .map((geofence) => geofence.identifier)
      .filter((identifier) => {
        const target = wanted.get(identifier);
        const current = existing.find((geofence) => geofence.identifier === identifier);
        return (
          !target ||
          !current ||
          current.radius !== target.nativeRadiusM ||
          current.latitude !== target.center.lat ||
          current.longitude !== target.center.lng
        );
      });
    if (stale.length > 0) await BackgroundGeolocation.removeGeofences(stale);
    const present = new Set(
      existing.map((geofence) => geofence.identifier).filter((id) => !stale.includes(id)),
    );
    const missing = fences.filter((fence) => !present.has(fence.identifier));
    if (missing.length > 0) {
      await BackgroundGeolocation.addGeofences(
        missing.map((fence) => ({
          identifier: fence.identifier,
          latitude: fence.center.lat,
          longitude: fence.center.lng,
          radius: fence.nativeRadiusM,
          notifyOnEntry: true,
          notifyOnExit: true,
          notifyOnDwell: false,
        })),
      );
    }
  }

  async currentPosition(persist: boolean): Promise<QueuedRecord | null> {
    const location: Location = await BackgroundGeolocation.getCurrentPosition({
      persist,
      samples: 1,
      timeout: 30,
      maximumAge: 0,
      desiredAccuracy: -1,
    });
    return toRecord(location);
  }

  async queued(): Promise<QueuedRecord[]> {
    const rows = await BackgroundGeolocation.getLocations();
    return rows.map(toRecord).filter((record): record is QueuedRecord => record !== null);
  }

  async destroy(uuid: string): Promise<void> {
    await BackgroundGeolocation.destroyLocation(uuid);
  }

  async clear(): Promise<void> {
    await BackgroundGeolocation.destroyLocations();
  }

  async sync(): Promise<void> {
    await BackgroundGeolocation.sync();
  }

  count(): Promise<number> {
    return BackgroundGeolocation.getCount();
  }

  /** `getState()` reads the persisted configuration; it needs no location access (decision #97). */
  async storedAuthorization(): Promise<StoredAuthorization | null> {
    const state = (await BackgroundGeolocation.getState()) as unknown as Config;
    const token = state.authorization?.accessToken;
    if (typeof token !== 'string' || token.length === 0) return null;
    const expires = state.authorization?.expires;
    return {
      token,
      renewAfterEpoch: typeof expires === 'number' && expires > 0 ? expires : null,
    };
  }

  async permission(): Promise<PermissionSnapshot> {
    return permissionFromProvider(await BackgroundGeolocation.getProviderState());
  }

  async requestPermission(): Promise<PermissionSnapshot> {
    await BackgroundGeolocation.requestPermission();
    return this.permission();
  }

  subscribe(handlers: DriverHandlers): () => void {
    const subscriptions: Subscription[] = [
      BackgroundGeolocation.onGeofence((event) =>
        handlers.geofence({
          identifier: event.identifier,
          action: event.action === 'EXIT' ? 'EXIT' : 'ENTER',
          timestamp: event.timestamp,
        }),
      ),
      BackgroundGeolocation.onLocation((location) => {
        const record = toRecord(location);
        if (record) handlers.location(record);
      }),
      BackgroundGeolocation.onHeartbeat(() => handlers.heartbeat()),
      BackgroundGeolocation.onProviderChange((event) =>
        handlers.provider(permissionFromProvider(event)),
      ),
      BackgroundGeolocation.onHttp((event) => handlers.http({ status: event.status })),
      BackgroundGeolocation.onAuthorization((event) => {
        const response = (event.response ?? {}) as Record<string, unknown>;
        handlers.authorization({
          success: event.success,
          token: typeof response.access_token === 'string' ? response.access_token : null,
          renewAfterEpoch: typeof response.expires === 'number' ? response.expires : null,
          expiresAt:
            typeof response.upload_expires_at === 'string' ? response.upload_expires_at : null,
        });
      }),
      BackgroundGeolocation.onConnectivityChange((event) => handlers.connectivity(event.connected)),
    ];
    return () => {
      for (const subscription of subscriptions) subscription.remove();
    };
  }
}
