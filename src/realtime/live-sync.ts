import type { BroadcastMessage } from '@sitemuster/shared';

import type { ChannelStatus, ProjectChannelListener } from '../api/types';

/**
 * Keeps one project's screens in step with the database through the private Broadcast channel
 * (docs/spec/11; decision #19, #106). A message only says "something changed": the screens
 * refetch authorized rows, so the database stays the source of truth. No React or React Native
 * here — the backend tests drive this same class against a real Realtime server.
 *
 * - LIVE: joined; every message (newest version only) refetches what it names.
 * - PAUSED: the channel dropped. Screens say so, refetch every minute, and the channel is joined
 *   again with back-off; joining again refetches everything (messages may have been missed).
 * - DENIED: the database refused the join (access removed): stop, and refetch so the screens get
 *   FORBIDDEN and hide what they showed.
 */
export type LiveState = 'CONNECTING' | 'LIVE' | 'PAUSED' | 'DENIED';
export type RefreshScope = 'ALL' | BroadcastMessage['type'];

export interface LiveSyncDeps {
  subscribe(projectId: string, listener: ProjectChannelListener): () => void;
  /** Refetch the rows behind these scopes. */
  refresh(scopes: ReadonlySet<RefreshScope>): void;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

/** A busy site sends many messages: refetch at once, then at most once per window. */
export const REFRESH_WINDOW_MS = 2_000;
/** A dropped channel is joined again after these delays (realtime-js also retries the socket). */
export const RESUBSCRIBE_DELAYS_MS = [5_000, 15_000, 30_000, 60_000] as const;

export class ProjectLiveSync {
  private state: LiveState = 'CONNECTING';
  private unsubscribe: (() => void) | null = null;
  private lastVersion = -1;
  private pending = new Set<RefreshScope>();
  private flushTimer: unknown = null;
  private lastFlushAt = Number.NEGATIVE_INFINITY;
  private retryTimer: unknown = null;
  private retries = 0;
  private stopped = false;
  private readonly listeners = new Set<(state: LiveState) => void>();

  constructor(
    private readonly projectId: string,
    private readonly deps: LiveSyncDeps,
  ) {}

  get status(): LiveState {
    return this.state;
  }

  onState(listener: (state: LiveState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.flushTimer !== null) this.deps.clearTimer(this.flushTimer);
    if (this.retryTimer !== null) this.deps.clearTimer(this.retryTimer);
    this.flushTimer = null;
    this.retryTimer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.listeners.clear();
  }

  /** Foreground, pull-to-refresh, or the fallback minute while paused: refetch everything. */
  resync(): void {
    if (!this.stopped) this.request('ALL');
  }

  private connect(): void {
    this.unsubscribe?.();
    this.unsubscribe = this.deps.subscribe(this.projectId, {
      onMessage: (message) => this.onMessage(message),
      onStatus: (status) => this.onStatus(status),
    });
  }

  private onMessage(message: BroadcastMessage): void {
    if (this.stopped || this.state === 'DENIED' || message.project_id !== this.projectId) return;
    // Duplicate or out of order: a newer message already asked for a refetch.
    if (message.aggregate_version <= this.lastVersion) return;
    this.lastVersion = message.aggregate_version;
    this.request(message.type);
  }

  private onStatus(status: ChannelStatus): void {
    if (this.stopped || this.state === 'DENIED') return;
    if (status === 'SUBSCRIBED') {
      this.retries = 0;
      if (this.retryTimer !== null) this.deps.clearTimer(this.retryTimer);
      this.retryTimer = null;
      this.setState('LIVE');
      // Joined (again): anything sent while away was missed, so refetch everything.
      this.request('ALL');
      return;
    }
    if (status === 'DENIED') {
      this.setState('DENIED');
      if (this.retryTimer !== null) this.deps.clearTimer(this.retryTimer);
      this.retryTimer = null;
      this.unsubscribe?.();
      this.unsubscribe = null;
      this.request('ALL');
      return;
    }
    this.setState('PAUSED');
    this.scheduleResubscribe();
  }

  private scheduleResubscribe(): void {
    if (this.retryTimer !== null) return;
    const delay =
      RESUBSCRIBE_DELAYS_MS[Math.min(this.retries, RESUBSCRIBE_DELAYS_MS.length - 1)] ?? 60_000;
    this.retries += 1;
    this.retryTimer = this.deps.setTimer(() => {
      this.retryTimer = null;
      if (!this.stopped && this.state === 'PAUSED') this.connect();
    }, delay);
  }

  private request(scope: RefreshScope): void {
    this.pending.add(scope);
    if (this.flushTimer !== null) return;
    const wait = this.lastFlushAt + REFRESH_WINDOW_MS - this.deps.now();
    if (wait <= 0) {
      this.flush();
      return;
    }
    this.flushTimer = this.deps.setTimer(() => {
      this.flushTimer = null;
      this.flush();
    }, wait);
  }

  private flush(): void {
    if (this.stopped || this.pending.size === 0) return;
    const scopes = this.pending;
    this.pending = new Set();
    this.lastFlushAt = this.deps.now();
    this.deps.refresh(scopes);
  }

  private setState(next: LiveState): void {
    if (next === this.state) return;
    this.state = next;
    for (const listener of this.listeners) listener(next);
  }
}
