import type { Config } from 'react-native-background-geolocation';

import type { Command, ControllerFence, ControllerState } from './controller';
import { type QueuedRecord, recordsToDestroy } from './gate';

/**
 * The one boundary between SiteMuster and a location engine. Implementations:
 * - native-driver.ts: Transistorsoft react-native-background-geolocation v5 (production);
 * - simulated-driver.ts: an in-memory model of the same SDK for CI and development builds
 *   (never compiled into release bundles; decision #18).
 */
export type LocationPermission =
  'ALWAYS' | 'WHEN_IN_USE' | 'DENIED' | 'NOT_DETERMINED' | 'RESTRICTED';

export interface PermissionSnapshot {
  location: LocationPermission;
  /** iOS Precise / Android precise location. */
  precise: boolean;
  /** Device location services switched on. */
  servicesEnabled: boolean;
}

export interface DriverHandlers {
  geofence(event: { identifier: string; action: 'ENTER' | 'EXIT'; timestamp: string }): void;
  location(record: QueuedRecord): void;
  heartbeat(): void;
  provider(permission: PermissionSnapshot): void;
  http(event: { status: number }): void;
  /** The SDK refreshed (or failed to refresh) its device secret natively. */
  authorization(event: {
    success: boolean;
    token: string | null;
    renewAfterEpoch: number | null;
    expiresAt: string | null;
  }): void;
  connectivity(online: boolean): void;
}

export interface StoredAuthorization {
  token: string;
  /** The SDK's `expires`: epoch second of the next renewal (credential expiry − 7 days). */
  renewAfterEpoch: number | null;
}

export interface TrackerDriver {
  readonly kind: 'native' | 'simulated';
  ready(config: Config): Promise<void>;
  setConfig(config: Partial<Config>): Promise<void>;
  startGeofences(): Promise<void>;
  startTracking(): Promise<void>;
  stop(): Promise<void>;
  /** Replaces the monitored native fences (diff: removes stale, adds missing). */
  replaceFences(fences: readonly ControllerFence[]): Promise<void>;
  currentPosition(persist: boolean): Promise<QueuedRecord | null>;
  queued(): Promise<QueuedRecord[]>;
  destroy(uuid: string): Promise<void>;
  clear(): Promise<void>;
  sync(): Promise<void>;
  count(): Promise<number>;
  /**
   * The secret held in the SDK's persisted configuration — it may have refreshed it natively,
   * also while the app was closed. Read before `ready()` on a cold start (decision #97).
   */
  storedAuthorization(): Promise<StoredAuthorization | null>;
  permission(): Promise<PermissionSnapshot>;
  requestPermission(): Promise<PermissionSnapshot>;
  subscribe(handlers: DriverHandlers): () => void;
}

export type CommandFailure = { command: Command['type']; error: unknown };

/** Reported for a SYNC that was not run because the egress gate failed before it. */
export const EGRESS_GATE_FAILED = 'EGRESS_GATE_FAILED';

/**
 * Runs controller commands in order. A failed command is reported (never swallowed) and the rest
 * still run: a failed sync leaves records queued for the next attempt. The egress gate fails
 * closed (decision #96): once a PRUNE or DESTROY fails, nothing else in the batch may upload —
 * SYNC is skipped and a SET_CONFIG that would switch SDK autoSync on is applied with autoSync
 * off. Uploads resume after the next successful prune (resync, heartbeat or transition).
 */
export async function executeCommands(
  driver: TrackerDriver,
  state: ControllerState,
  commands: readonly Command[],
  report: (failure: CommandFailure) => void,
): Promise<{ egressBlocked: boolean }> {
  let gateFailed = false;
  for (const command of commands) {
    if (gateFailed && command.type === 'SYNC') {
      report({ command: 'SYNC', error: new Error(EGRESS_GATE_FAILED) });
      continue;
    }
    try {
      switch (command.type) {
        case 'SET_CONFIG':
          await driver.setConfig(gateFailed ? withoutAutoSync(command.config) : command.config);
          break;
        case 'REPLACE_FENCES':
          await driver.replaceFences(command.fences);
          break;
        case 'START_GEOFENCES':
          await driver.startGeofences();
          break;
        case 'START_TRACKING':
          await driver.startTracking();
          break;
        case 'STOP':
          await driver.stop();
          break;
        case 'CURRENT_POSITION':
          await driver.currentPosition(command.persist);
          break;
        case 'PRUNE':
          for (const uuid of recordsToDestroy(
            await driver.queued(),
            state.fences,
            state.coordinatesAllowed,
          )) {
            await driver.destroy(uuid);
          }
          break;
        case 'DESTROY':
          await driver.destroy(command.uuid);
          break;
        case 'CLEAR_QUEUE':
          await driver.clear();
          break;
        case 'SYNC':
          await driver.sync();
          break;
      }
    } catch (error) {
      if (command.type === 'PRUNE' || command.type === 'DESTROY') gateFailed = true;
      report({ command: command.type, error });
    }
  }
  return { egressBlocked: gateFailed };
}

function withoutAutoSync(config: Partial<Config>): Partial<Config> {
  return config.http?.autoSync ? { ...config, http: { ...config.http, autoSync: false } } : config;
}
