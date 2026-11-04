import { buildBadgePayload } from '../../packages/shared/src/api/badge.ts';
import { configFromSettings } from '../../packages/shared/src/attendance/config.ts';
import type { AttendanceStore } from '../../packages/shared/src/attendance/reconcile.ts';
import type {
  AttendanceEventRow,
  CorrectionRow,
  EngineOutput,
} from '../../packages/shared/src/attendance/types.ts';
import {
  developmentBadgeKey,
  encryptBadgeSecret,
} from '../../supabase/functions/_shared/badge-crypto.ts';
import type {
  CorrectionRequestFact,
  OperationContext,
  OperationsDeps,
  ReceiptRow,
  StoredReceipt,
} from '../../supabase/functions/_shared/operations-core.ts';
import { MemoryBackend } from '../location-replay/harness/memory-backend.ts';

/**
 * An in-memory server world for ingest-operations (Milestone 08): two projects, 20 kiosk workers
 * with phone badges (two companies), 20 crew workers, printed badges, an attendant, a foreman
 * and a superintendent, over the replay MemoryBackend and the production reconciler. Shared by
 * the Edge core tests and the phone outbox tests (the outbox talks to the real handler).
 */
export const PROJECT_A = '0a000000-0000-4000-8000-0000000000a1';
export const PROJECT_B = '0b000000-0000-4000-8000-0000000000b1';
export const COMPANY_A = '0c000000-0000-4000-8000-0000000000a1';
export const COMPANY_B = '0c000000-0000-4000-8000-0000000000b1';
export const ATTENDANT = 'a0000000-0000-4000-8000-0000000000a1';
export const FOREMAN = 'f0000000-0000-4000-8000-0000000000a1';
export const SUPER = '50000000-0000-4000-8000-0000000000a1';
export const KIOSK = 'ab000000-0000-4000-8000-0000000000a1';
export const HOST = SUPER;
export const T0 = Date.parse('2026-11-04T13:00:00Z');
export const KEY = developmentBadgeKey();

export const workerId = (group: 'k' | 'f' | 'x', i: number) =>
  `${group === 'k' ? '4a' : group === 'f' ? '4f' : '4e'}000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;
export const deviceId = (i: number) =>
  `5d000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;
export const secretOf = (i: number) => new Uint8Array(32).fill(i + 1);
export const uuid = (n: number) => `e0000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

export const config = (projectId: string) =>
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

export const CONTEXTS: Record<string, Record<string, Partial<OperationContext>>> = {
  [ATTENDANT]: { [PROJECT_A]: { kiosk: 'ALL', visitors: true } },
  [FOREMAN]: { [PROJECT_A]: { kiosk: 'OWN_CREW', foremanCompanyIds: [COMPANY_A] } },
  [SUPER]: { [PROJECT_A]: { correct: true } },
};

export interface OperationsWorld {
  deps: OperationsDeps;
  backend: MemoryBackend;
  events: AttendanceEventRow[];
  receipts: Map<string, StoredReceipt>;
  loads: string[];
  failStore: { on: boolean };
  /** Receipt writes fail (the operation itself was already applied): the request answers 503. */
  failReceipts: { on: boolean };
  /** Worker/foreman correction requests a manual correction may name (Milestone 10). */
  requests: Map<string, CorrectionRequestFact>;
  /** Correction rows the reconciler committed. */
  corrections: CorrectionRow[];
  as(actor: string): void;
}

export async function operationsWorld(): Promise<OperationsWorld> {
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
  const failReceipts = { on: false };
  const requests = new Map<string, CorrectionRequestFact>();
  const corrections: CorrectionRow[] = [];
  let actor = ATTENDANT;
  const store: AttendanceStore = {
    load: async (projectId, worker, uuids, sessions) => {
      loads.push(projectId);
      if (failStore.on) throw new Error('database unavailable');
      return backend.load(projectId, worker, uuids, sessions);
    },
    commit: async (output: EngineOutput, revision: number) => {
      const status = await backend.commit(output, revision);
      if (status === 'ok') {
        events.push(...output.events);
        corrections.push(...output.corrections);
      }
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
      if (failReceipts.on) throw new Error('database unavailable');
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
    correctionRequest: async (id) => requests.get(id) ?? null,
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
  return {
    deps,
    backend,
    events,
    receipts,
    loads,
    failStore,
    failReceipts,
    requests,
    corrections,
    as: (a) => (actor = a),
  };
}

export const kiosk = (n: number, i: number, at = T0, direction: 'ENTRY' | 'EXIT' = 'ENTRY') => ({
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

export const printedScan = (n: number, code: string) => ({
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

export const crew = (n: number, workers: string[], company = COMPANY_A) => ({
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
