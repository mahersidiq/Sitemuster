import {
  type IngestOperationsRequest,
  type IngestOperationsResponse,
  type OperationEvent,
  OperationEventSchema,
  type OperationResult,
  TRACKING_DEFAULTS,
} from '@sitemuster/shared';

/**
 * Operational offline outbox (docs/spec/11 "Operational offline outbox contract"; decisions #23,
 * #84, #98–#104). It owns ONLY kiosk, foreman, manual and visitor operations; the native location
 * SDK owns location records, so no event is ever in both queues.
 *
 * - An operation is validated and stored (encrypted) BEFORE anything is sent, with one random
 *   event_uuid chosen once: resending it can never count twice.
 * - Operations are sent oldest first, at most 100 per request and well under 256 KiB.
 * - Only a terminal answer (accepted / duplicate / rejected) settles an operation. A network
 *   failure, 401, 429 or 5xx keeps everything queued; nothing is ever dropped silently.
 * - Each operation belongs to the signed-in person who recorded it and is sent only with their
 *   session (the server derives the actor from it); sign-out with unsent operations needs an
 *   explicit discard.
 * React-free: the provider (src/state/outbox.tsx) supplies storage, transport and timers.
 */
export type OutboxStatus = 'PENDING' | 'ACCEPTED' | 'DUPLICATE' | 'REJECTED';

/** An operation as the screens build it; the outbox adds the event_uuid. */
export type OperationDraft = OperationEvent extends infer E
  ? E extends OperationEvent
    ? Omit<E, 'event_uuid'>
    : never
  : never;

/** What the screen shows next to the entry (names stay on the phone, encrypted). */
export interface OutboxLabel {
  title: string;
  /** Kiosk scans: the badge kind, so a printed badge stays visibly flagged. */
  badge?: 'DYNAMIC_APP' | 'PRINTED';
}

export interface OutboxEntry {
  event: OperationEvent;
  actorUserId: string;
  createdAt: number;
  status: OutboxStatus;
  result: OperationResult | null;
  attempts: number;
  label: OutboxLabel;
}

export interface OutboxRow {
  eventUuid: string;
  actorUserId: string;
  createdAt: number;
  status: OutboxStatus;
  envelope: string;
}

/** Durable rows (expo-sqlite on the phone, memory in tests). */
export interface OutboxTable {
  insert(row: OutboxRow): Promise<void>;
  update(eventUuid: string, status: OutboxStatus, envelope: string): Promise<void>;
  list(actorUserId: string): Promise<OutboxRow[]>;
  remove(eventUuids: readonly string[]): Promise<void>;
}

/** AES-256-GCM sealing bound to the row (the event_uuid is the associated data). */
export interface OutboxCipher {
  seal(eventUuid: string, plain: string): Promise<string>;
  /** null when the envelope can no longer be opened (key lost after a reinstall). */
  open(eventUuid: string, envelope: string): Promise<string | null>;
}

export type SendResult =
  { ok: true; response: IngestOperationsResponse } | { ok: false; code: string };

export interface OutboxDeps {
  table: OutboxTable;
  cipher: OutboxCipher;
  send(request: IngestOperationsRequest): Promise<SendResult>;
  now(): number;
  newUuid(): string;
  report(entry: Record<string, unknown>): void;
}

export interface OutboxStatusSummary {
  pending: number;
  accepted: number;
  rejected: number;
  lastSyncAt: number | null;
  /** The last reason a sync did not finish (NETWORK, UNAUTHENTICATED, RATE_LIMITED, …). */
  lastError: string | null;
  syncing: boolean;
}

const MAX_EVENTS = TRACKING_DEFAULTS.operations_ingest_max_events;
/** Below the server's 256 KiB limit with room for the envelope. */
const MAX_BATCH_BYTES = 200 * 1024;
/** Settled entries stay visible for the shift, then leave the phone. */
export const SETTLED_RETENTION_MS = 24 * 60 * 60 * 1000;

const statusOf = (result: OperationResult): OutboxStatus =>
  result.status === 'accepted'
    ? 'ACCEPTED'
    : result.status === 'duplicate'
      ? 'DUPLICATE'
      : 'REJECTED';

/** The outcome a person sees: a resent operation shows the outcome it got the first time. */
export function effectiveOutcome(entry: OutboxEntry): 'PENDING' | 'ACCEPTED' | 'REJECTED' {
  if (entry.status === 'PENDING') return 'PENDING';
  if (entry.status === 'DUPLICATE') {
    return entry.result?.original_status === 'rejected' ? 'REJECTED' : 'ACCEPTED';
  }
  return entry.status;
}

export class OperationalOutbox {
  private readonly listeners = new Set<(summary: OutboxStatusSummary) => void>();
  private running: Promise<OutboxStatusSummary> | null = null;
  private summary: OutboxStatusSummary = {
    pending: 0,
    accepted: 0,
    rejected: 0,
    lastSyncAt: null,
    lastError: null,
    syncing: false,
  };

  constructor(
    private readonly deps: OutboxDeps,
    private readonly actorUserId: string,
  ) {}

  get status(): OutboxStatusSummary {
    return this.summary;
  }

  subscribe(listener: (summary: OutboxStatusSummary) => void): () => void {
    this.listeners.add(listener);
    listener(this.summary);
    return () => this.listeners.delete(listener);
  }

  /** Validates and stores an operation; nothing is sent until it is safely on the phone. */
  async enqueue(draft: OperationDraft, label: OutboxLabel): Promise<OutboxEntry> {
    const event = OperationEventSchema.parse({ ...draft, event_uuid: this.deps.newUuid() });
    const entry: OutboxEntry = {
      event,
      actorUserId: this.actorUserId,
      createdAt: this.deps.now(),
      status: 'PENDING',
      result: null,
      attempts: 0,
      label,
    };
    await this.deps.table.insert({
      eventUuid: event.event_uuid,
      actorUserId: this.actorUserId,
      createdAt: entry.createdAt,
      status: 'PENDING',
      envelope: await this.deps.cipher.seal(event.event_uuid, JSON.stringify(entry)),
    });
    await this.refresh();
    return entry;
  }

  /** This person's entries, oldest first (settled ones for the last 24 hours). */
  async entries(): Promise<OutboxEntry[]> {
    const rows = await this.deps.table.list(this.actorUserId);
    const entries: OutboxEntry[] = [];
    const unreadable: string[] = [];
    for (const row of rows) {
      const plain = await this.deps.cipher.open(row.eventUuid, row.envelope);
      if (plain === null) {
        unreadable.push(row.eventUuid);
        continue;
      }
      entries.push(JSON.parse(plain) as OutboxEntry);
    }
    if (unreadable.length > 0) {
      // Ciphertext without its key can never be sent: reported, then removed (fail closed).
      this.deps.report({ area: 'outbox', step: 'unreadable', count: unreadable.length });
      await this.deps.table.remove(unreadable);
    }
    return entries.sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Sends what is pending. Overlapping calls share one run. */
  flush(): Promise<OutboxStatusSummary> {
    this.running ??= this.flushNow().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** Explicit, confirmed discard (sign-out with unsent operations): everything of this person. */
  async discardAll(): Promise<number> {
    const rows = await this.deps.table.list(this.actorUserId);
    await this.deps.table.remove(rows.map((row) => row.eventUuid));
    this.deps.report({ area: 'outbox', step: 'discarded', count: rows.length });
    await this.refresh();
    return rows.filter((row) => row.status === 'PENDING').length;
  }

  async refresh(): Promise<OutboxStatusSummary> {
    const rows = await this.deps.table.list(this.actorUserId);
    return this.patch({
      pending: rows.filter((row) => row.status === 'PENDING').length,
      accepted: rows.filter((row) => row.status === 'ACCEPTED' || row.status === 'DUPLICATE')
        .length,
      rejected: rows.filter((row) => row.status === 'REJECTED').length,
    });
  }

  // ------------------------------------------------------------------------------------------

  private async flushNow(): Promise<OutboxStatusSummary> {
    this.patch({ syncing: true });
    try {
      await this.purgeSettled();
      const pending = (await this.entries()).filter((entry) => entry.status === 'PENDING');
      for (const batch of batches(pending)) {
        const sentAt = this.deps.now();
        const outcome = await this.deps.send({
          schema_version: 1,
          client_sent_at: new Date(sentAt).toISOString(),
          events: batch.map((entry) => entry.event),
        });
        if (!outcome.ok) {
          for (const entry of batch) await this.save({ ...entry, attempts: entry.attempts + 1 });
          // Stop: the next attempt (timer, foreground, Sync now) resends the same operations.
          return await this.finish(outcome.code);
        }
        const byUuid = new Map(outcome.response.results.map((r) => [r.event_uuid, r]));
        for (const entry of batch) {
          const result = byUuid.get(entry.event.event_uuid);
          if (!result) {
            // Never assume success: an operation without its own answer stays queued.
            await this.save({ ...entry, attempts: entry.attempts + 1 });
            this.deps.report({ area: 'outbox', step: 'missing-result' });
            continue;
          }
          await this.save({
            ...entry,
            status: statusOf(result),
            result,
            attempts: entry.attempts + 1,
          });
        }
      }
      return await this.finish(null, this.deps.now());
    } catch (error) {
      this.deps.report({
        area: 'outbox',
        step: 'flush',
        error: error instanceof Error ? error.message : 'unknown',
      });
      return await this.finish('UNKNOWN');
    }
  }

  private async finish(
    lastError: string | null,
    lastSyncAt?: number,
  ): Promise<OutboxStatusSummary> {
    await this.refresh();
    return this.patch({
      syncing: false,
      lastError,
      ...(lastSyncAt === undefined ? {} : { lastSyncAt }),
    });
  }

  private async save(entry: OutboxEntry): Promise<void> {
    await this.deps.table.update(
      entry.event.event_uuid,
      entry.status,
      await this.deps.cipher.seal(entry.event.event_uuid, JSON.stringify(entry)),
    );
  }

  private async purgeSettled(): Promise<void> {
    const cutoff = this.deps.now() - SETTLED_RETENTION_MS;
    const rows = await this.deps.table.list(this.actorUserId);
    const old = rows.filter((row) => row.status !== 'PENDING' && row.createdAt < cutoff);
    if (old.length > 0) await this.deps.table.remove(old.map((row) => row.eventUuid));
  }

  private patch(next: Partial<OutboxStatusSummary>): OutboxStatusSummary {
    this.summary = { ...this.summary, ...next };
    for (const listener of this.listeners) listener(this.summary);
    return this.summary;
  }
}

/** Oldest first, ≤ 100 operations and ≤ ~200 KiB per request. */
function batches(entries: readonly OutboxEntry[]): OutboxEntry[][] {
  const out: OutboxEntry[][] = [];
  let current: OutboxEntry[] = [];
  let bytes = 0;
  for (const entry of entries) {
    const size = JSON.stringify(entry.event).length + 2;
    if (current.length > 0 && (current.length >= MAX_EVENTS || bytes + size > MAX_BATCH_BYTES)) {
      out.push(current);
      current = [];
      bytes = 0;
    }
    current.push(entry);
    bytes += size;
  }
  if (current.length > 0) out.push(current);
  return out;
}

/** In-memory rows (tests and the web preview). */
export class MemoryOutboxTable implements OutboxTable {
  readonly rows = new Map<string, OutboxRow>();
  async insert(row: OutboxRow): Promise<void> {
    if (this.rows.has(row.eventUuid)) throw new Error('duplicate outbox row');
    this.rows.set(row.eventUuid, { ...row });
  }
  async update(eventUuid: string, status: OutboxStatus, envelope: string): Promise<void> {
    const row = this.rows.get(eventUuid);
    if (row) this.rows.set(eventUuid, { ...row, status, envelope });
  }
  async list(actorUserId: string): Promise<OutboxRow[]> {
    return [...this.rows.values()]
      .filter((row) => row.actorUserId === actorUserId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }
  async remove(eventUuids: readonly string[]): Promise<void> {
    for (const id of eventUuids) this.rows.delete(id);
  }
}
