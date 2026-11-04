import type { Config } from 'react-native-background-geolocation';

import type { ControllerFence } from './controller';
import type {
  DriverHandlers,
  PermissionSnapshot,
  StoredAuthorization,
  TrackerDriver,
} from './driver';
import type { QueuedRecord } from './gate';

/**
 * WEB RENDER ONLY (tools/ui-preview): there is no background-location SDK on the web, so the
 * preview uses this inert stand-in to show the screens. A preview flag shows the
 * permission-required state (set `window.__previewPermission = 'whenInUse'`). The native app
 * always uses src/tracking/native-driver.ts.
 */
export class NativeTrackerDriver implements TrackerDriver {
  readonly kind = 'native' as const;
  private token: string | null = null;

  async ready(config: Config): Promise<void> {
    this.token = config.authorization?.accessToken ?? null;
  }
  async setConfig(config: Partial<Config>): Promise<void> {
    if (config.authorization) this.token = config.authorization.accessToken;
  }
  async startGeofences(): Promise<void> {}
  async startTracking(): Promise<void> {}
  async stop(): Promise<void> {}
  async replaceFences(_fences: readonly ControllerFence[]): Promise<void> {}
  async currentPosition(): Promise<QueuedRecord | null> {
    return null;
  }
  async queued(): Promise<QueuedRecord[]> {
    return [];
  }
  async destroy(): Promise<void> {}
  async clear(): Promise<void> {}
  async sync(): Promise<void> {}
  async count(): Promise<number> {
    return 0;
  }
  async storedAuthorization(): Promise<StoredAuthorization | null> {
    return this.token ? { token: this.token, renewAfterEpoch: null } : null;
  }
  async permission(): Promise<PermissionSnapshot> {
    const limited =
      (globalThis as { __previewPermission?: string }).__previewPermission === 'whenInUse';
    return limited
      ? { location: 'WHEN_IN_USE', precise: false, servicesEnabled: true }
      : { location: 'ALWAYS', precise: true, servicesEnabled: true };
  }
  requestPermission(): Promise<PermissionSnapshot> {
    return this.permission();
  }
  subscribe(_handlers: DriverHandlers): () => void {
    return () => undefined;
  }
}
