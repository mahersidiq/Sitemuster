import {
  DEMO_ARRIVAL_SPAN_SECONDS,
  type DemoAction,
  DemoSimulateRequestSchema,
} from '../../../packages/shared/src/api/demo.ts';
import type { ApiErrorCode } from '../../../packages/shared/src/api/common.ts';
import { deriveUuid } from '../../../packages/shared/src/attendance/config.ts';
import type { DeviceFence } from '../../../packages/shared/src/attendance/normalize.ts';
import { iso } from '../../../packages/shared/src/attendance/time.ts';
import type { ItemResult } from '../../../packages/shared/src/attendance/types.ts';
import { apiError, json, newRequestId, readJsonBody } from './http.ts';
import { deviceAuthFromJson, type IngestDeps, processLocationBatch } from './ingest-core.ts';

/**
 * `demo-simulate` (Milestone 13; spec 09 "Reviewer/demo mode"; decisions #38, #140–#143).
 *
 * 1. `begin_demo_simulation` runs WITH THE CALLER'S OWN JWT. The database refuses unless the caller
 *    may correct attendance on the project (MFA), the project belongs to an active allowlisted demo
 *    organization, and the person is one of its synthetic workers.
 * 2. The server builds the records for that person's synthetic phone record (never the client) and
 *    runs them through the production ingest pipeline (`processLocationBatch`): normalization,
 *    receipts, the attendance engine and its commit. Nothing reaches a real person or project.
 */
export class DemoAuthError extends Error {}

export class DemoRpcError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
  ) {
    super(`RPC_FAILED:${status}:${code ?? ''}`);
  }
}

export interface DemoContext {
  deviceId: string;
  workerId: string;
  projectId: string;
  /** Observed time of the newest record this synthetic phone ever sent, or null. */
  lastEvidenceAt: string | null;
}

export interface DemoDeps extends Pick<IngestDeps, 'receipts' | 'recordTerminals' | 'store'> {
  now(): number;
  requestId?: string;
  begin(input: {
    projectId: string;
    workerId: string;
    action: DemoAction;
    idempotencyKey: string;
  }): Promise<DemoContext>;
  /** `edge_demo_device` (service role): the synthetic phone as the ingest pipeline sees it. */
  device(deviceId: string): Promise<unknown>;
  log?(entry: Record<string, unknown>): void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEMO_NAMESPACE = 'sitemuster-reviewer-demo';
/** Simulated fixes report this horizontal accuracy (well inside the 75 m limit). */
const DEMO_ACCURACY_M = 12;
/** Synthetic people stand at most this far from the site centre (the site radius is ≥ 150 m). */
const DEMO_SPREAD_M = 60;
const DEMO_LEAVE_TOLERANCE_MS = 60_000;

export function demoContextFromJson(value: unknown): DemoContext | null {
  const data = (value ?? {}) as Record<string, unknown>;
  const device = data.device_id;
  const worker = data.worker_id;
  const project = data.project_id;
  if (
    typeof device !== 'string' ||
    typeof worker !== 'string' ||
    typeof project !== 'string' ||
    !UUID.test(device) ||
    !UUID.test(worker) ||
    !UUID.test(project)
  ) {
    return null;
  }
  const last = data.last_evidence_at;
  return {
    deviceId: device,
    workerId: worker,
    projectId: project,
    lastEvidenceAt: typeof last === 'string' && !Number.isNaN(Date.parse(last)) ? last : null,
  };
}

export function demoRecordUuids(idempotencyKey: string, action: DemoAction): string[] {
  const count = action === 'ARRIVE' ? 3 : 1;
  return Array.from({ length: count }, (_, index) =>
    deriveUuid(DEMO_NAMESPACE, `${idempotencyKey.toLowerCase()}|${action}|${index}`),
  );
}

/** A stable spot for one synthetic person inside the site circle (so markers do not overlap). */
export function demoPosition(
  fence: Pick<DeviceFence, 'center'>,
  workerId: string,
): { latitude: number; longitude: number } {
  const hex = deriveUuid(DEMO_NAMESPACE, `position|${workerId.toLowerCase()}`).replace(/-/g, '');
  const angle = (parseInt(hex.slice(0, 4), 16) / 0xffff) * 2 * Math.PI;
  const distance = 10 + (parseInt(hex.slice(4, 8), 16) / 0xffff) * (DEMO_SPREAD_M - 10);
  const dLat = (distance * Math.cos(angle)) / 111_320;
  const dLng =
    (distance * Math.sin(angle)) / (111_320 * Math.cos((fence.center.lat * Math.PI) / 180));
  const round = (value: number) => Math.round(value * 1e6) / 1e6;
  return { latitude: round(fence.center.lat + dLat), longitude: round(fence.center.lng + dLng) };
}

/**
 * The fence a simulated record names, as the phone's own native region would: an arrival uses the
 * project's current boundary; a departure uses the boundary of the still-open visit when the site
 * was changed since (that older fence is listed only while such a visit is open).
 */
export function demoFence(raw: unknown, projectId: string, action: DemoAction): DeviceFence | null {
  const parsed = deviceAuthFromJson(raw);
  if (parsed.status !== 'OK') return null;
  const flags = new Map<string, boolean>();
  const fences = (raw as { fences?: unknown }).fences;
  for (const entry of Array.isArray(fences) ? fences : []) {
    const fence = entry as { identifier?: unknown; current?: unknown };
    if (typeof fence.identifier === 'string') flags.set(fence.identifier, fence.current === true);
  }
  const own = parsed.device.fences.filter((fence) => fence.projectId === projectId);
  const current = own.find((fence) => flags.get(fence.identifier) === true) ?? null;
  if (action === 'ARRIVE') return current;
  return own.find((fence) => flags.get(fence.identifier) === false) ?? current;
}

export type DemoPlan = { records: Record<string, unknown>[] } | { waitSeconds: number };

/**
 * The records of one simulation, in the native SDK's wire shape. An arrival is a synthetic
 * DEMO_ARRIVAL_SPAN_SECONDS trace ending now; it always starts after the phone's previous record,
 * so the engine never sees time run backwards. When that is not possible yet, the caller waits.
 */
export function buildDemoRecords(input: {
  action: DemoAction;
  fence: DeviceFence;
  workerId: string;
  idempotencyKey: string;
  nowMs: number;
  lastEvidenceAt: string | null;
}): DemoPlan {
  const uuids = demoRecordUuids(input.idempotencyKey, input.action);
  const earliest = input.lastEvidenceAt
    ? Date.parse(input.lastEvidenceAt) + 1000
    : Number.NEGATIVE_INFINITY;
  const geofence = (action: 'ENTER' | 'EXIT', at: number, uuid: string) => ({
    uuid,
    timestamp: iso(at),
    event: 'geofence',
    geofence: { identifier: input.fence.identifier, action },
    accuracy: DEMO_ACCURACY_M,
    is_moving: action === 'EXIT',
  });
  if (input.action === 'LEAVE') {
    // A departure right after the last record is stamped just after it (at most a minute ahead,
    // far inside the engine's 5-minute clock tolerance).
    const at = Math.max(input.nowMs, earliest);
    if (at - input.nowMs > DEMO_LEAVE_TOLERANCE_MS) {
      return { waitSeconds: Math.ceil((at - input.nowMs) / 1000) };
    }
    return { records: [geofence('EXIT', at, uuids[0] as string)] };
  }
  const span = (DEMO_ARRIVAL_SPAN_SECONDS + 1) * 1000;
  const start = Math.max(input.nowMs - span, earliest);
  if (start + span > input.nowMs) {
    return { waitSeconds: Math.ceil((start + span - input.nowMs) / 1000) };
  }
  const position = demoPosition(input.fence, input.workerId);
  const fix = (at: number, uuid: string) => ({
    uuid,
    timestamp: iso(at),
    event: 'location',
    coords: { ...position, accuracy: DEMO_ACCURACY_M },
    is_moving: false,
    mock: false,
  });
  return {
    records: [
      geofence('ENTER', start, uuids[0] as string),
      fix(start + 1000, uuids[1] as string),
      fix(start + span, uuids[2] as string),
    ],
  };
}

const REFUSALS: Record<string, [number, ApiErrorCode]> = {
  FORBIDDEN: [403, 'FORBIDDEN'],
  DEMO_NOT_ALLOWED: [403, 'DEMO_NOT_ALLOWED'],
  NOT_A_DEMO_WORKER: [403, 'NOT_A_DEMO_WORKER'],
  RATE_LIMITED: [429, 'RATE_LIMITED'],
  INVALID_ACTION: [422, 'INVALID_REQUEST'],
  IDEMPOTENCY_KEY_REQUIRED: [422, 'IDEMPOTENCY_KEY_REQUIRED'],
};

export async function handleDemoSimulate(req: Request, deps: DemoDeps): Promise<Response> {
  const requestId = deps.requestId ?? newRequestId();
  const log = (entry: Record<string, unknown>) =>
    deps.log?.({ fn: 'demo-simulate', request_id: requestId, ...entry });
  if (!/^Bearer\s+\S+$/i.test(req.headers.get('authorization') ?? '')) {
    return apiError(401, 'UNAUTHENTICATED', requestId, 'Sign in first.');
  }
  const read = await readJsonBody(req, requestId);
  if (!read.ok) return read.response;
  const parsed = DemoSimulateRequestSchema.safeParse(read.body);
  if (!parsed.success) {
    return apiError(422, 'INVALID_REQUEST', requestId, 'Invalid simulation request.');
  }
  const request = parsed.data;

  let context: DemoContext;
  try {
    context = await deps.begin({
      projectId: request.project_id,
      workerId: request.worker_id,
      action: request.action,
      idempotencyKey: request.idempotency_key,
    });
  } catch (error) {
    if (error instanceof DemoAuthError) {
      log({ outcome: 'refused', status: 401 });
      return apiError(401, 'UNAUTHENTICATED', requestId, 'Sign in again.');
    }
    if (error instanceof DemoRpcError && error.code && REFUSALS[error.code]) {
      const [status, code] = REFUSALS[error.code] as [number, ApiErrorCode];
      log({ outcome: 'refused', status, code });
      return apiError(
        status,
        code,
        requestId,
        code,
        status === 429 ? { 'retry-after': '600' } : {},
      );
    }
    log({ outcome: 'begin_fail', status: 503 });
    return apiError(503, 'TEMPORARILY_UNAVAILABLE', requestId, 'Nothing was recorded. Try again.');
  }

  let raw: unknown;
  try {
    raw = await deps.device(context.deviceId);
  } catch {
    log({ outcome: 'device_fail', status: 503 });
    return apiError(503, 'TEMPORARILY_UNAVAILABLE', requestId, 'Nothing was recorded. Try again.');
  }
  const device = deviceAuthFromJson(raw);
  const fence = demoFence(raw, context.projectId, request.action);
  if (device.status !== 'OK' || device.device.workerId !== context.workerId || !fence) {
    // Retired demo, or the synthetic person is not monitored on the project any more.
    log({ outcome: 'refused', status: 409, code: 'DEMO_NOT_ALLOWED' });
    return apiError(409, 'DEMO_NOT_ALLOWED', requestId, 'DEMO_NOT_ALLOWED');
  }

  // A retry of an applied simulation answers "duplicate" instead of waiting for the next one.
  const uuids = demoRecordUuids(request.idempotency_key, request.action);
  let known: Map<string, boolean>;
  try {
    known = await deps.receipts(context.deviceId, uuids);
  } catch {
    log({ outcome: 'receipts_fail', status: 503 });
    return apiError(503, 'TEMPORARILY_UNAVAILABLE', requestId, 'Nothing was recorded. Try again.');
  }
  const retry = uuids.every((uuid) => known.get(uuid) === true);
  const nowMs = deps.now();
  const plan = buildDemoRecords({
    action: request.action,
    fence,
    workerId: context.workerId,
    idempotencyKey: request.idempotency_key,
    nowMs,
    lastEvidenceAt: retry ? null : context.lastEvidenceAt,
  });
  if ('waitSeconds' in plan) {
    log({ outcome: 'wait', status: 409, code: 'DEMO_WAIT' });
    return apiError(409, 'DEMO_WAIT', requestId, 'DEMO_WAIT', {
      'retry-after': String(plan.waitSeconds),
    });
  }

  let results: ItemResult[];
  try {
    results = await processLocationBatch(plan.records, device.device, iso(nowMs), requestId, deps);
  } catch (error) {
    log({
      outcome: 'ingest_fail',
      status: 503,
      error: error instanceof Error ? error.message.slice(0, 120) : 'unknown',
    });
    return apiError(503, 'TEMPORARILY_UNAVAILABLE', requestId, 'Try again shortly.');
  }
  log({
    outcome: 'simulated',
    status: 200,
    action: request.action,
    accepted: results.filter((result) => result.status === 'accepted').length,
  });
  return json(200, {
    schema_version: 1,
    request_id: requestId,
    action: request.action,
    simulated: true,
    results: results.map((result) => ({
      event_uuid: result.eventUuid,
      status: result.status,
      reason: result.reason,
    })),
  });
}
