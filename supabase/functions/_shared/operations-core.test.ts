import { describe, expect, it } from 'vitest';

import { MemoryBackend } from '../../../tests/location-replay/harness/memory-backend.ts';
import { buildBadgePayload } from '../../../packages/shared/src/api/badge.ts';
import { IngestOperationsResponseSchema } from '../../../packages/shared/src/api/operations.ts';
import { configFromSettings, deriveUuid } from '../../../packages/shared/src/attendance/config.ts';
import type { AttendanceStore } from '../../../packages/shared/src/attendance/reconcile.ts';
import type {
  AttendanceEventRow,
  EngineOutput,
} from '../../../packages/shared/src/attendance/types.ts';
import { developmentBadgeKey, encryptBadgeSecret } from './badge-crypto.ts';
import {
  badgeDeviceFromJson,
  contextFromJson,
  handleOperations,
  kioskFromJson,
  type OperationContext,
  type OperationsDeps,
  type ReceiptRow,
  printedBadgeFromJson,
  receiptsFromJson,
  type StoredReceipt,
  workerFactsFromJson,
} from './operations-core.ts';

const PROJECT_A = '0a000000-0000-4000-8000-0000000000a1';
const PROJECT_B = '0b000000-0000-4000-8000-0000000000b1';
const COMPANY_A = '0c000000-0000-4000-8000-0000000000a1';
const COMPANY_B = '0c000000-0000-4000-8000-0000000000b1';
const ATTENDANT = 'a0000000-0000-4000-8000-0000000000a1';
const FOREMAN = 'f0000000-0000-4000-8000-0000000000a1';
const SUPER = '50000000-0000-4000-8000-0000000000a1';
const KIOSK = 'ab000000-0000-4000-8000-0000000000a1';
const HOST = SUPER;
const T0 = Date.parse('2026-11-04T13:00:00Z');
const KEY = developmentBadgeKey();

const workerId = (group: 'k' | 'f' | 'x', i: number) =>
  `${group === 'k' ? '4a' : group === 'f' ? '4f' : '4e'}000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;
const deviceId = (i: number) => `5d000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;
const secretOf = (i: number) => new Uint8Array(32).fill(i + 1);
const uuid = (n: number) => `e0000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const config = (projectId: string) =>
  configFromSettings({
    configVersionId: `cv-${projectId}`,
    projectId,
    versionNumber: 1,
    effectiveAt: '2026-01-01T00:00:00Z',
    settings: { operates_24_7: true },
    center: { lat: 29.7604, lng: -95.3698 },
    radiusM: 150,
    exitHysteresisM: 50,
  });

const CONTEXTS: Record<string, Record<string, Partial<OperationContext>>> = {
  [ATTENDANT]: { [PROJECT_A]: { kiosk: 'ALL', visitors: true } },
  [FOREMAN]: { [PROJECT_A]: { kiosk: 'OWN_CREW', foremanCompanyIds: [COMPANY_A] } },
  [SUPER]: { [PROJECT_A]: { correct: true } },
};

interface World {
  deps: OperationsDeps;
  backend: MemoryBackend;
  events: AttendanceEventRow[];
  receipts: Map<string, StoredReceipt>;
  loads: string[];
  failStore: { on: boolean };
  as(actor: string): void;
}

async function world(): Promise<World> {
  const backend = new MemoryBackend();
  await backend.createProject(
    { id: PROJECT_A, status: 'ACTIVE', timezone: 'America/Chicago' },
    config(PROJECT_A),
  );
  await backend.createProject(
    { id: PROJECT_B, status: 'ACTIVE', timezone: 'America/New_York' },
    config(PROJECT_B),
  );
  const facts = new Map<string, { companyId: string | null; approved: boolean }>();
  for (let i = 1; i <= 20; i += 1) {
    await backend.enrollWorker(PROJECT_A, workerId('k', i), { eligible: true, reason: null });
    await backend.enrollWorker(PROJECT_A, workerId('f', i), { eligible: true, reason: null });
    facts.set(workerId('k', i), { companyId: i <= 10 ? COMPANY_A : COMPANY_B, approved: true });
    facts.set(workerId('f', i), { companyId: COMPANY_A, approved: true });
  }
  await backend.enrollWorker(PROJECT_B, workerId('x', 1), { eligible: true, reason: null });
  const devices = new Map<string, { active: boolean; workerId: string; ciphertext: Uint8Array }>();
  for (let i = 1; i <= 20; i += 1) {
    devices.set(deviceId(i), {
      active: true,
      workerId: workerId('k', i),
      ciphertext: await encryptBadgeSecret(KEY, secretOf(i), deviceId(i)),
    });
  }
  const printed = new Map<string, { workerId: string; active: boolean }>();
  const events: AttendanceEventRow[] = [];
  const receipts = new Map<string, StoredReceipt>();
  const redemptions = new Map<string, string>();
  const visitors = new Map<string, string>();
  const loads: string[] = [];
  const failStore = { on: false };
  let actor = ATTENDANT;
  const store: AttendanceStore = {
    load: async (projectId, worker, uuids, sessions) => {
      loads.push(projectId);
      if (failStore.on) throw new Error('database unavailable');
      return backend.load(projectId, worker, uuids, sessions);
    },
    commit: async (output: EngineOutput, revision: number) => {
      const status = await backend.commit(output, revision);
      if (status === 'ok') events.push(...output.events);
      return status;
    },
  };
  const deps: OperationsDeps = {
    now: () => T0 + 5 * 60_000,
    badgeKey: KEY,
    context: async (projectId) => ({
      userId: actor,
      projectId: projectId === PROJECT_A || projectId === PROJECT_B ? projectId : null,
      projectStatus: projectId === PROJECT_A || projectId === PROJECT_B ? 'ACTIVE' : null,
      kiosk: null,
      visitors: false,
      correct: false,
      foremanCompanyIds: [],
      ...(CONTEXTS[actor]?.[projectId] ?? {}),
    }),
    rateLimit: async () => true,
    receipts: async (uuids) =>
      uuids.flatMap((u) => (receipts.has(u) ? [receipts.get(u) as StoredReceipt] : [])),
    recordReceipts: async (_requestId, rows: ReceiptRow[]) => {
      for (const row of rows) {
        if (receipts.has(row.event_uuid)) continue;
        receipts.set(row.event_uuid, {
          eventUuid: row.event_uuid,
          actorId: row.actor_id,
          projectId: row.project_id,
          status: row.status,
          reason: row.reason,
          workerId: row.worker_id,
          children: row.children,
          review: row.review,
        });
      }
    },
    kiosk: async (id) => (id === KIOSK ? { id: KIOSK, projectId: PROJECT_A } : null),
    loadBadgeDevice: async (id) => devices.get(id) ?? null,
    redeemBadgeStep: async ({ projectId, deviceId: device, timeStep, eventUuid }) => {
      const key = `${projectId}|${device}|${timeStep}`;
      const owner = redemptions.get(key);
      if (!owner) {
        redemptions.set(key, eventUuid);
        return 'accepted';
      }
      return owner === eventUuid ? 'duplicate' : 'replay';
    },
    printedBadge: async (hash) => printed.get(hash) ?? null,
    workers: async (projectId, ids) =>
      ids.map((id) => {
        const fact = projectId === PROJECT_A ? facts.get(id) : undefined;
        return {
          workerId: id,
          enrolled: !!fact,
          approved: !!fact?.approved,
          eligible: !!fact?.approved,
          companyId: fact?.companyId ?? null,
        };
      }),
    registerVisitor: async ({ projectId, visitorId, name }) => {
      const owner = visitors.get(visitorId);
      if (owner) return owner === projectId ? 'ok' : 'VISITOR_ID_CONFLICT';
      if (!name) return 'VISITOR_DETAILS_REQUIRED';
      visitors.set(visitorId, projectId);
      return 'ok';
    },
    applyVisitor: (input) => backend.visitorEvent(input),
    store,
  };
  // Printed badges: the core sends the SHA-256 (hex) of the code.
  const { sha256 } = await import('@noble/hashes/sha2.js');
  const { bytesToHex } = await import('@noble/hashes/utils.js');
  const hash = (code: string) => bytesToHex(sha256(new TextEncoder().encode(code)));
  printed.set(hash('SMP1.printed-badge-code-k3-abcdefgh'), {
    workerId: workerId('k', 3),
    active: true,
  });
  printed.set(hash('SMP1.printed-badge-code-revoked-xxxx'), {
    workerId: workerId('k', 4),
    active: false,
  });
  return { deps, backend, events, receipts, loads, failStore, as: (a) => (actor = a) };
}

const kiosk = (n: number, i: number, at = T0, direction: 'ENTRY' | 'EXIT' = 'ENTRY') => ({
  event_uuid: uuid(n),
  project_id: PROJECT_A,
  operation_type: direction === 'ENTRY' ? 'KIOSK_ENTRY' : 'KIOSK_EXIT',
  observed_at: new Date(at).toISOString(),
  payload: {
    badge_payload: buildBadgePayload(secretOf(i), deviceId(i), PROJECT_A, Math.floor(at / 1000)),
    badge_kind: 'DYNAMIC_APP',
    kiosk_device_id: KIOSK,
    direction,
  },
});

const printedScan = (n: number, code: string) => ({
  event_uuid: uuid(n),
  project_id: PROJECT_A,
  operation_type: 'KIOSK_ENTRY',
  observed_at: new Date(T0).toISOString(),
  payload: {
    badge_payload: code,
    badge_kind: 'PRINTED',
    kiosk_device_id: KIOSK,
    direction: 'ENTRY',
  },
});

const crew = (n: number, workers: string[], company = COMPANY_A) => ({
  event_uuid: uuid(n),
  project_id: PROJECT_A,
  operation_type: 'FOREMAN_BULK_ENTRY',
  observed_at: new Date(T0).toISOString(),
  payload: {
    subcontractor_id: company,
    worker_ids: workers,
    direction: 'ENTRY',
    verification_method: 'PHYSICAL_CONFIRMATION',
  },
});

async function send(
  w: World,
  events: unknown[],
  options: { sentAt?: number; token?: string } = {},
) {
  const response = await handleOperations(
    new Request('https://x.test/functions/v1/ingest-operations', {
      method: 'POST',
      headers: {
        authorization: options.token ?? 'Bearer user-jwt',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        schema_version: 1,
        client_sent_at: new Date(options.sentAt ?? w.deps.now()).toISOString(),
        events,
      }),
    }),
    w.deps,
  );
  const body = (await response.json()) as Record<string, unknown>;
  return { status: response.status, body };
}

const results = (body: Record<string, unknown>) =>
  IngestOperationsResponseSchema.parse(body).results;

describe('ingest-operations', () => {
  it('acceptance: 20 offline kiosk scans + 20 crew events → exactly 40 accepted; the resend adds nothing', async () => {
    const w = await world();
    const scans = Array.from({ length: 20 }, (_, k) => kiosk(k + 1, k + 1, T0 + k * 1000));
    w.as(ATTENDANT);
    const first = await send(w, scans);
    expect(first.status).toBe(200);
    w.as(FOREMAN);
    const crews = [
      crew(
        101,
        Array.from({ length: 10 }, (_, k) => workerId('f', k + 1)),
      ),
      crew(
        102,
        Array.from({ length: 10 }, (_, k) => workerId('f', k + 11)),
      ),
    ];
    const second = await send(w, crews);
    const accepted =
      results(first.body).filter((r) => r.status === 'accepted').length +
      results(second.body)
        .flatMap((r) => r.children ?? [])
        .filter((c) => c.status === 'accepted').length;
    expect(accepted).toBe(40);
    const sessions = async () =>
      (await w.backend.snapshot(PROJECT_A)).sessions.filter((s) => s.status === 'OPEN').length;
    expect(await sessions()).toBe(40);

    // Airplane mode: the phones never saw the answers and resend everything.
    w.as(ATTENDANT);
    const again = results((await send(w, scans)).body);
    expect(again.every((r) => r.status === 'duplicate' && r.original_status === 'accepted')).toBe(
      true,
    );
    expect(again.every((r) => typeof r.worker_id === 'string')).toBe(true);
    w.as(FOREMAN);
    const crewAgain = results((await send(w, crews)).body);
    expect(crewAgain.every((r) => r.status === 'duplicate' && r.children?.length === 10)).toBe(
      true,
    );
    expect(await sessions()).toBe(40);
    expect(new Set(w.events.map((e) => e.event_uuid)).size).toBe(w.events.length);
  });

  it('a badge code is single-use: another scan of the same 30-second code is BADGE_REPLAY', async () => {
    const w = await world();
    const scan = kiosk(1, 1);
    const replay = { ...scan, event_uuid: uuid(2) };
    const out = results((await send(w, [scan, replay])).body);
    expect(out.map((r) => [r.status, r.reason])).toEqual([
      ['accepted', null],
      ['rejected', 'BADGE_REPLAY'],
    ]);
    expect(out[1]?.worker_id).toBeUndefined();
  });

  it('printed badges stay flagged KIOSK_PRINTED_BADGE; revoked and unknown codes are refused', async () => {
    const w = await world();
    const out = results(
      (
        await send(w, [
          printedScan(1, 'SMP1.printed-badge-code-k3-abcdefgh'),
          printedScan(2, 'SMP1.printed-badge-code-revoked-xxxx'),
          printedScan(3, 'SMP1.printed-badge-code-unknown-yyyy'),
        ])
      ).body,
    );
    expect(out.map((r) => r.reason)).toEqual([null, 'BADGE_REVOKED', 'BADGE_INVALID']);
    expect(w.events.find((e) => e.event_uuid === uuid(1))?.source).toBe('KIOSK_PRINTED_BADGE');
  });

  it('visitors are signed in and out separately and never become a workforce session', async () => {
    const w = await world();
    const visitor = 'b1000000-0000-4000-8000-000000000001';
    const entry = {
      event_uuid: uuid(1),
      project_id: PROJECT_A,
      operation_type: 'VISITOR_ENTRY',
      observed_at: new Date(T0).toISOString(),
      payload: {
        visitor_id: visitor,
        name: 'Ivy Inspector',
        host_user_id: HOST,
        purpose: 'Inspection',
        direction: 'ENTRY',
      },
    };
    const exit = {
      event_uuid: uuid(2),
      project_id: PROJECT_A,
      operation_type: 'VISITOR_EXIT',
      observed_at: new Date(T0 + 3_600_000).toISOString(),
      payload: {
        visitor_id: visitor,
        host_user_id: HOST,
        purpose: 'Inspection',
        direction: 'EXIT',
      },
    };
    const out = results((await send(w, [entry, exit])).body);
    expect(out.map((r) => r.status)).toEqual(['accepted', 'accepted']);
    const snapshot = await w.backend.snapshot(PROJECT_A);
    expect(snapshot.visits.map((v) => v.status)).toEqual(['CLOSED']);
    expect(snapshot.sessions).toHaveLength(0);
    expect(w.events).toHaveLength(0);
  });

  it('a crew batch answers per worker: other-company and unknown workers are refused, the rest count', async () => {
    const w = await world();
    w.as(FOREMAN);
    const named = [workerId('f', 1), workerId('k', 15), workerId('x', 1), workerId('f', 2)];
    const [result] = results((await send(w, [crew(1, named)])).body);
    expect(result).toMatchObject({ status: 'accepted', reason: 'SOME_WORKERS_REJECTED' });
    expect(result?.children?.map((c) => [c.worker_id, c.status, c.reason])).toEqual([
      [workerId('f', 1), 'accepted', null],
      [workerId('k', 15), 'rejected', 'WORKER_NOT_IN_COMPANY'],
      [workerId('x', 1), 'rejected', 'WORKER_NOT_ENROLLED'],
      [workerId('f', 2), 'accepted', null],
    ]);
    expect(result?.children?.[0]?.child_event_uuid).toBe(
      deriveUuid('foreman-member', `${uuid(1)}|${workerId('f', 1)}`),
    );
    expect((await w.backend.snapshot(PROJECT_A)).sessions).toHaveLength(2);
  });

  it('permissions come from the context: crews only for own companies, kiosk and corrections by role', async () => {
    const w = await world();
    w.as(FOREMAN);
    const [otherCompany] = results((await send(w, [crew(1, [workerId('k', 15)], COMPANY_B)])).body);
    expect(otherCompany).toMatchObject({ status: 'rejected', reason: 'COMPANY_NOT_AUTHORIZED' });
    w.as(SUPER);
    const [kioskBySuper] = results((await send(w, [kiosk(2, 1)])).body);
    expect(kioskBySuper).toMatchObject({ status: 'rejected', reason: 'FORBIDDEN' });
    w.as(ATTENDANT);
    const manual = {
      event_uuid: uuid(3),
      project_id: PROJECT_A,
      operation_type: 'MANUAL_ATTENDANCE_CORRECTION',
      observed_at: new Date(T0).toISOString(),
      payload: {
        worker_id: workerId('k', 1),
        corrected_start_at: new Date(T0 - 3_600_000).toISOString(),
        reason: 'Forgot to scan',
      },
    };
    const [manualByAttendant] = results((await send(w, [manual])).body);
    expect(manualByAttendant).toMatchObject({ status: 'rejected', reason: 'FORBIDDEN' });
    w.as(SUPER);
    const [manualBySuper] = results((await send(w, [{ ...manual, event_uuid: uuid(4) }])).body);
    expect(manualBySuper?.status).toBe('accepted');
  });

  it('a project the caller has no role on is refused without touching it (zero reads, nothing recorded against it)', async () => {
    const w = await world();
    w.as(ATTENDANT);
    const foreign = { ...kiosk(1, 1), project_id: PROJECT_B };
    const [result] = results((await send(w, [foreign])).body);
    expect(result).toMatchObject({ status: 'rejected', reason: 'PROJECT_NOT_AUTHORIZED' });
    expect(w.loads).not.toContain(PROJECT_B);
    expect(w.receipts.get(uuid(1))?.projectId).toBeNull();
  });

  it('a foreman kiosk scans only their own crew', async () => {
    const w = await world();
    w.as(FOREMAN);
    const out = results((await send(w, [kiosk(1, 2), kiosk(2, 15)])).body);
    expect(out.map((r) => [r.status, r.reason])).toEqual([
      ['accepted', null],
      ['rejected', 'NOT_OWN_CREW'],
    ]);
    // The other company's badge step was not consumed by the refused scan.
    w.as(ATTENDANT);
    expect(results((await send(w, [kiosk(3, 15)])).body)[0]?.status).toBe('accepted');
  });

  it('a wrong kiosk clock: a valid badge still verifies, but the scan is held for review (decision #84)', async () => {
    const w = await world();
    // The worker's phone shows the badge for the real time T0; the kiosk clock runs an hour fast,
    // so it records T0 + 1 h and sends its request at "now + 1 h".
    const scan = { ...kiosk(1, 1, T0), observed_at: new Date(T0 + 3_600_000).toISOString() };
    const [result] = results((await send(w, [scan], { sentAt: w.deps.now() + 3_600_000 })).body);
    expect(result).toMatchObject({ status: 'accepted', review: true });
    // Without the measured offset the same scan would fail the ±1 step check.
    const honest = { ...kiosk(2, 2, T0), observed_at: new Date(T0 + 3_600_000).toISOString() };
    const [refused] = results((await send(w, [honest])).body);
    expect(refused).toMatchObject({ status: 'rejected', reason: 'BADGE_EXPIRED' });
  });

  it('a store failure answers 503 and records nothing; the resend is applied exactly once', async () => {
    const w = await world();
    w.failStore.on = true;
    const failed = await send(w, [kiosk(1, 1)]);
    expect(failed.status).toBe(503);
    expect(w.receipts.size).toBe(0);
    w.failStore.on = false;
    const [result] = results((await send(w, [kiosk(1, 1)])).body);
    expect(result?.status).toBe('accepted');
    expect(w.events).toHaveLength(1);
  });

  it('a malformed operation is refused on its own; muster waits for Milestone 11', async () => {
    const w = await world();
    const broken = {
      event_uuid: uuid(1),
      project_id: PROJECT_A,
      operation_type: 'KIOSK_ENTRY',
      observed_at: 'yesterday',
      payload: {},
    };
    const muster = {
      event_uuid: uuid(2),
      project_id: PROJECT_A,
      operation_type: 'MUSTER_SELF_REPORT',
      observed_at: new Date(T0).toISOString(),
      payload: { muster_id: uuid(90), snapshot_member_id: uuid(91), action: 'SELF_REPORT' },
    };
    const out = results((await send(w, [broken, muster, kiosk(3, 1)])).body);
    expect(out.map((r) => r.reason)).toEqual([
      'INVALID_OPERATION',
      'OPERATION_NOT_SUPPORTED',
      null,
    ]);
    expect((await send(w, [{ operation_type: 'KIOSK_ENTRY' }])).status).toBe(422);
  });

  it("another person's operation id is never acknowledged as yours", async () => {
    const w = await world();
    w.as(ATTENDANT);
    await send(w, [kiosk(1, 1)]);
    w.as(FOREMAN);
    const [result] = results((await send(w, [kiosk(1, 2)])).body);
    expect(result).toMatchObject({ status: 'rejected', reason: 'EVENT_UUID_CONFLICT' });
  });

  it('HTTP guards: sign-in, configuration, method and rate limit fail closed', async () => {
    const w = await world();
    expect((await send(w, [kiosk(1, 1)], { token: '' })).status).toBe(401);
    const unconfigured = await handleOperations(
      new Request('https://x.test', {
        method: 'POST',
        headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
        body: '{}',
      }),
      { ...w.deps, badgeKey: null },
    );
    expect(unconfigured.status).toBe(503);
    const get = await handleOperations(
      new Request('https://x.test', { headers: { authorization: 'Bearer t' } }),
      w.deps,
    );
    expect(get.status).toBe(405);
    const limited = await handleOperations(
      new Request('https://x.test', {
        method: 'POST',
        headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
        body: JSON.stringify({
          schema_version: 1,
          client_sent_at: new Date(T0).toISOString(),
          events: [kiosk(1, 1)],
        }),
      }),
      { ...w.deps, rateLimit: async () => false },
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
  });
});

describe('database row mappers (the Edge Function wiring is a thin, untyped shell)', () => {
  it('maps every field the core relies on and reads anything missing as "no"', () => {
    expect(
      workerFactsFromJson([
        { worker_id: 'w1', enrolled: true, approved: true, eligible: true, company_id: 'c1' },
        { worker_id: 'w2', enrolled: true, approved: true },
      ]),
    ).toEqual([
      { workerId: 'w1', enrolled: true, approved: true, eligible: true, companyId: 'c1' },
      { workerId: 'w2', enrolled: true, approved: true, eligible: false, companyId: null },
    ]);
    expect(kioskFromJson({ id: 'k', project_id: 'p', status: 'ACTIVE' })).toEqual({
      id: 'k',
      projectId: 'p',
    });
    expect(kioskFromJson(null)).toBeNull();
    expect(printedBadgeFromJson({ worker_id: 'w', active: false })).toEqual({
      workerId: 'w',
      active: false,
    });
    expect(printedBadgeFromJson(null)).toBeNull();
    expect(
      badgeDeviceFromJson({ worker_id: 'w', active: true, secret_ciphertext: 'AAAA' })?.active,
    ).toBe(true);
    expect(badgeDeviceFromJson(null)).toBeNull();
    expect(
      contextFromJson({
        user_id: 'u',
        project_id: 'p',
        project_status: 'ACTIVE',
        kiosk: 'OWN_CREW',
        visitors: false,
        correct: true,
        foreman_company_ids: ['c', 3],
      }),
    ).toEqual({
      userId: 'u',
      projectId: 'p',
      projectStatus: 'ACTIVE',
      kiosk: 'OWN_CREW',
      visitors: false,
      correct: true,
      foremanCompanyIds: ['c'],
    });
    expect(() => contextFromJson({})).toThrow();
    expect(
      receiptsFromJson([
        {
          event_uuid: 'e',
          actor_id: 'a',
          project_id: null,
          status: 'accepted',
          reason: null,
          worker_id: 'w',
          children: [],
          review: true,
        },
      ]),
    ).toEqual([
      {
        eventUuid: 'e',
        actorId: 'a',
        projectId: null,
        status: 'accepted',
        reason: null,
        workerId: 'w',
        children: [],
        review: true,
      },
    ]);
  });
});
