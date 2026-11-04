import {
  arm,
  type ControllerFence,
  type ControllerState,
  disarm,
  DISARMED,
  onGeofence,
  onHeartbeat,
  onLocation,
  type Transition,
} from './controller';
import {
  type CommandFailure,
  type DriverHandlers,
  executeCommands,
  type PermissionSnapshot,
  type TrackerDriver,
} from './driver';

/**
 * Runs the pure controller against a driver: one event at a time (serialized), state persisted
 * before the commands run so a killed app resumes in the right mode. Used by the foreground app
 * and by the Android headless task.
 */
export interface ControllerStore {
  load(): Promise<ControllerState | null>;
  save(state: ControllerState): Promise<void>;
}

export interface AgentListener {
  state?(state: ControllerState): void;
  provider?(permission: PermissionSnapshot): void;
  http?(status: number): void;
  authorization?(event: {
    success: boolean;
    token: string | null;
    renewAfterEpoch: number | null;
    expiresAt: string | null;
  }): void;
  failure?(failure: CommandFailure): void;
}

export class TrackingAgent {
  private state: ControllerState = DISARMED;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly driver: TrackerDriver,
    private readonly store: ControllerStore,
    private readonly listener: AgentListener = {},
  ) {}

  get current(): ControllerState {
    return this.state;
  }

  async restore(): Promise<ControllerState> {
    this.state = (await this.store.load()) ?? DISARMED;
    return this.state;
  }

  /** Wires SDK events to the controller; returns the unsubscribe function. */
  attach(): () => void {
    const handlers: DriverHandlers = {
      geofence: (event) => void this.step((s) => onGeofence(s, event)),
      location: (record) => void this.step((s) => onLocation(s, record)),
      heartbeat: () => void this.step(onHeartbeat),
      provider: (permission) => this.listener.provider?.(permission),
      http: (event) => this.listener.http?.(event.status),
      authorization: (event) => this.listener.authorization?.(event),
      connectivity: (online) => {
        if (online) void this.step((s) => this.resync(s));
      },
    };
    return this.driver.subscribe(handlers);
  }

  arm(fences: ControllerFence[], coordinatesAllowed: boolean): Promise<void> {
    return this.step((s) => arm(s, { fences, coordinatesAllowed }));
  }

  disarm(): Promise<void> {
    return this.step(() => disarm());
  }

  /** Back online / foreground: gate (onsite) and sync what the SDK holds. */
  sync(): Promise<void> {
    return this.step((s) => this.resync(s));
  }

  /** Resolves when every event delivered so far has been handled. */
  idle(): Promise<void> {
    return this.chain;
  }

  private resync(state: ControllerState): Transition {
    if (state.mode === 'DISARMED') return { state, commands: [] };
    return { state, commands: [{ type: 'PRUNE' }, { type: 'SYNC' }] };
  }

  private step(next: (state: ControllerState) => Transition): Promise<void> {
    this.chain = this.chain.then(async () => {
      const transition = next(this.state);
      this.state = transition.state;
      await this.store.save(transition.state);
      await executeCommands(this.driver, transition.state, transition.commands, (failure) =>
        this.listener.failure?.(failure),
      );
      this.listener.state?.(transition.state);
    });
    return this.chain;
  }
}

/** In-memory store (tests, simulated driver). */
export class MemoryControllerStore implements ControllerStore {
  private value: ControllerState | null = null;
  async load(): Promise<ControllerState | null> {
    return this.value ? structuredClone(this.value) : null;
  }
  async save(state: ControllerState): Promise<void> {
    this.value = structuredClone(state);
  }
}
