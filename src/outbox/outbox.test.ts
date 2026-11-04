import { describe, expect, it } from 'vitest';

import type { IngestOperationsRequest, IngestOperationsResponse } from '@sitemuster/shared';

import { handleOperations } from '../../supabase/functions/_shared/operations-core';
import {
  ATTENDANT,
  COMPANY_A,
  FOREMAN,
  kiosk,
  operationsWorld,
  type OperationsWorld,
  PROJECT_A,
  T0,
  workerId,
} from '../../tests/support/operations-world';
import {
  effectiveOutcome,
  MemoryOutboxTable,
  type OperationDraft,
  OperationalOutbox,
  type OutboxCipher,
  type OutboxDeps,
  SETTLED_RETENTION_MS,
  type SendResult,
} from './outbox';

/** Sealing that is reversible but keeps plaintext off the table (the phone uses AES-256-GCM). */
const cipher: OutboxCipher = {
  seal: async (id, plain) => `sealed:${id}:${Buffer.from(plain).toString('base64')}`,
  open: async (id, envelope) =>
    envelope.startsWith(`sealed:${id}:`)
      ? Buffer.from(envelope.slice(`sealed:${id}:`.length), 'base64').toString()
      : null,
};

interface Network {
  online: boolean;
  /** The server applies the request but the phone never sees the answer. */
  loseNextResponse: boolean;
  requests: IngestOperationsRequest[];
}

function outboxFor(
  w: OperationsWorld,
  actor: string,
  table: MemoryOutboxTable,
  network: Network,
  clock: { now: number },
) {
  let counter = 0;
  // The full HTTP handler, read back the way the app's API client reads it.
  const send = async (request: IngestOperationsRequest): Promise<SendResult> => {
    network.requests.push(request);
    if (!network.online) return { ok: false, code: 'NETWORK' };
    w.as(actor);
    const response = await handleOperations(
      new Request('https://x.test/functions/v1/ingest-operations', {
        method: 'POST',
        headers: { authorization: 'Bearer user-jwt', 'content-type': 'application/json' },
        body: JSON.stringify(request),
      }),
      w.deps,
    );
    const body = (await response.json()) as {
      results?: IngestOperationsResponse['results'];
      error?: { code: string };
    };
    if (response.status !== 200) return { ok: false, code: body.error?.code ?? 'UNKNOWN' };
    if (network.loseNextResponse) {
      network.loseNextResponse = false;
      return { ok: false, code: 'NETWORK' };
    }
    return {
      ok: true,
      response: { schema_version: 1, request_id: crypto.randomUUID(), results: body.results ?? [] },
    };
  };
  const deps: OutboxDeps = {
    table,
    cipher,
    send,
    now: () => clock.now,
    newUuid: () => {
      counter += 1;
      const tag = actor === ATTENDANT ? 'a' : 'f';
      return `0${tag}000000-0000-4000-8000-${counter.toString(16).padStart(12, '0')}`;
    },
    report: () => undefined,
  };
  return new OperationalOutbox(deps, actor);
}

const draftOf = (event: Record<string, unknown>): OperationDraft => {
  const { event_uuid: _dropped, ...draft } = event;
  return draft as unknown as OperationDraft;
};

const crewEvent = (worker: string): OperationDraft => ({
  project_id: PROJECT_A,
  operation_type: 'FOREMAN_BULK_ENTRY',
  observed_at: new Date(T0).toISOString(),
  payload: {
    subcontractor_id: COMPANY_A,
    worker_ids: [worker],
    direction: 'ENTRY',
    verification_method: 'PHYSICAL_CONFIRMATION',
  },
});

async function setup() {
  const w = await operationsWorld();
  const table = new MemoryOutboxTable();
  const network: Network = { online: false, loseNextResponse: false, requests: [] };
  const clock = { now: w.deps.now() };
  return {
    w,
    table,
    network,
    clock,
    kioskOutbox: outboxFor(w, ATTENDANT, table, network, clock),
    foremanOutbox: outboxFor(w, FOREMAN, table, network, clock),
  };
}

describe('operational outbox (phone) against the production ingest-operations handler', () => {
  it('acceptance: 20 kiosk scans + 20 crew events offline → airplane mode off → exactly 40 accepted, no duplicates', async () => {
    const { w, network, kioskOutbox, foremanOutbox } = await setup();
    for (let i = 1; i <= 20; i += 1) {
      await kioskOutbox.enqueue(draftOf(kiosk(i, i, T0 + i * 1000)), {
        title: `Scan ${i}`,
        badge: 'DYNAMIC_APP',
      });
      await foremanOutbox.enqueue(crewEvent(workerId('f', i)), { title: `Crew ${i}` });
    }
    // Offline: everything stays queued and visible as waiting.
    await kioskOutbox.flush();
    await foremanOutbox.flush();
    expect(kioskOutbox.status).toMatchObject({ pending: 20, lastError: 'NETWORK' });
    expect(foremanOutbox.status.pending).toBe(20);

    // Back online, but the first answer is lost on the way back: the outbox must resend.
    network.online = true;
    network.loseNextResponse = true;
    await kioskOutbox.flush();
    expect(kioskOutbox.status.pending).toBe(20);
    await kioskOutbox.flush();
    await foremanOutbox.flush();

    const all = [...(await kioskOutbox.entries()), ...(await foremanOutbox.entries())];
    expect(all.filter((entry) => effectiveOutcome(entry) === 'ACCEPTED')).toHaveLength(40);
    expect(all.filter((entry) => entry.status === 'DUPLICATE')).toHaveLength(20); // the resend
    expect(kioskOutbox.status).toMatchObject({ pending: 0, accepted: 20, lastError: null });
    const sessions = (await w.backend.snapshot(PROJECT_A)).sessions;
    expect(sessions.filter((s) => s.status === 'OPEN')).toHaveLength(40);
    expect(new Set(w.events.map((e) => e.event_uuid)).size).toBe(40);
  });

  it('per-person outcomes: a replayed badge is shown rejected, the worker of an accepted scan is known', async () => {
    const { network, kioskOutbox } = await setup();
    const scan = kiosk(1, 1);
    await kioskOutbox.enqueue(draftOf(scan), { title: 'Scan', badge: 'DYNAMIC_APP' });
    await kioskOutbox.enqueue(draftOf(scan), { title: 'Same badge again', badge: 'DYNAMIC_APP' });
    network.online = true;
    await kioskOutbox.flush();
    const [first, second] = await kioskOutbox.entries();
    expect(first?.result).toMatchObject({ status: 'accepted', worker_id: workerId('k', 1) });
    expect(second?.result).toMatchObject({ status: 'rejected', reason: 'BADGE_REPLAY' });
    expect(effectiveOutcome(second ?? first!)).toBe('REJECTED');
  });

  it('never stores an invalid operation, and stores before sending', async () => {
    const { table, network, kioskOutbox } = await setup();
    await expect(
      kioskOutbox.enqueue(
        { ...draftOf(kiosk(1, 1)), observed_at: 'not-a-time' } as OperationDraft,
        { title: 'x' },
      ),
    ).rejects.toThrow();
    expect(table.rows.size).toBe(0);
    await kioskOutbox.enqueue(draftOf(kiosk(2, 2)), { title: 'Scan' });
    expect(table.rows.size).toBe(1);
    expect(network.requests).toHaveLength(0); // nothing sent by enqueue itself
    expect([...table.rows.values()][0]?.envelope).not.toContain(PROJECT_A); // sealed at rest
  });

  it('a refused session or a busy server keeps everything queued (no silent loss)', async () => {
    // The real handler answers 503 for the whole request when its store fails.
    const { w, network, kioskOutbox } = await setup();
    network.online = true;
    w.failStore.on = true;
    await kioskOutbox.enqueue(draftOf(kiosk(1, 1)), { title: 'Scan' });
    expect(await kioskOutbox.flush()).toMatchObject({
      pending: 1,
      lastError: 'TEMPORARILY_UNAVAILABLE',
    });
    w.failStore.on = false;
    expect((await kioskOutbox.flush()).pending).toBe(0);
    const busy = new OperationalOutbox(
      {
        table: new MemoryOutboxTable(),
        cipher,
        send: async () => ({ ok: false, code: 'TEMPORARILY_UNAVAILABLE' }),
        now: () => T0,
        newUuid: () => crypto.randomUUID(),
        report: () => undefined,
      },
      ATTENDANT,
    );
    await busy.enqueue(draftOf(kiosk(3, 3)), { title: 'Scan' });
    expect((await busy.flush()).pending).toBe(1);
    const unauthenticated = new OperationalOutbox(
      {
        table: new MemoryOutboxTable(),
        cipher,
        send: async () => ({ ok: false, code: 'UNAUTHENTICATED' }),
        now: () => T0,
        newUuid: () => crypto.randomUUID(),
        report: () => undefined,
      },
      ATTENDANT,
    );
    await unauthenticated.enqueue(draftOf(kiosk(4, 4)), { title: 'Scan' });
    expect(await unauthenticated.flush()).toMatchObject({
      pending: 1,
      lastError: 'UNAUTHENTICATED',
    });
  });

  it('an answer that leaves an operation out keeps that operation queued', async () => {
    const outbox = new OperationalOutbox(
      {
        table: new MemoryOutboxTable(),
        cipher,
        send: async (request) => ({
          ok: true,
          response: {
            schema_version: 1,
            request_id: crypto.randomUUID(),
            results: [
              { event_uuid: request.events[0]?.event_uuid ?? '', status: 'accepted', reason: null },
            ],
          },
        }),
        now: () => T0,
        newUuid: () => crypto.randomUUID(),
        report: () => undefined,
      },
      ATTENDANT,
    );
    await outbox.enqueue(draftOf(kiosk(1, 1)), { title: 'a' });
    await outbox.enqueue(draftOf(kiosk(2, 2)), { title: 'b' });
    expect((await outbox.flush()).pending).toBe(1);
  });

  it('sends at most 100 operations per request, oldest first', async () => {
    const requests: IngestOperationsRequest[] = [];
    const outbox = new OperationalOutbox(
      {
        table: new MemoryOutboxTable(),
        cipher,
        send: async (request) => {
          requests.push(request);
          return {
            ok: true,
            response: {
              schema_version: 1,
              request_id: crypto.randomUUID(),
              results: request.events.map((e) => ({
                event_uuid: e.event_uuid,
                status: 'accepted' as const,
                reason: null,
              })),
            },
          };
        },
        now: () => T0,
        newUuid: () => crypto.randomUUID(),
        report: () => undefined,
      },
      FOREMAN,
    );
    for (let i = 0; i < 150; i += 1)
      await outbox.enqueue(crewEvent(workerId('f', (i % 20) + 1)), { title: String(i) });
    await outbox.flush();
    expect(requests.map((r) => r.events.length)).toEqual([100, 50]);
    expect(requests.every((r) => typeof r.client_sent_at === 'string')).toBe(true);
  });

  it("each person's operations stay theirs; sign-out discards only after an explicit choice", async () => {
    const { table, kioskOutbox, foremanOutbox } = await setup();
    await kioskOutbox.enqueue(draftOf(kiosk(1, 1)), { title: 'Scan' });
    await foremanOutbox.enqueue(crewEvent(workerId('f', 1)), { title: 'Crew' });
    expect(await kioskOutbox.entries()).toHaveLength(1);
    expect(await kioskOutbox.discardAll()).toBe(1);
    expect(await kioskOutbox.entries()).toHaveLength(0);
    expect(await foremanOutbox.entries()).toHaveLength(1);
    expect(table.rows.size).toBe(1);
  });

  it('settled entries leave the phone after 24 hours; unreadable ones are removed and reported', async () => {
    const { network, clock, kioskOutbox, table } = await setup();
    network.online = true;
    await kioskOutbox.enqueue(draftOf(kiosk(1, 1)), { title: 'Scan' });
    await kioskOutbox.flush();
    expect(await kioskOutbox.entries()).toHaveLength(1);
    clock.now += SETTLED_RETENTION_MS + 1;
    await kioskOutbox.flush();
    expect(await kioskOutbox.entries()).toHaveLength(0);
    await table.insert({
      eventUuid: 'x',
      actorUserId: ATTENDANT,
      createdAt: clock.now,
      status: 'PENDING',
      envelope: 'garbage',
    });
    expect(await kioskOutbox.entries()).toHaveLength(0);
    expect(table.rows.has('x')).toBe(false);
  });
});
