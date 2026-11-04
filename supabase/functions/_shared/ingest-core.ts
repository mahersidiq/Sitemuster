import { sha256 } from '@noble/hashes/sha2.js';

import { SdkBatchEnvelopeSchema } from '../../../packages/shared/src/api/location-ingest.ts';
import {
  combineResults,
  type DeviceContext,
  type DeviceFence,
  type NormalizedRecord,
  normalizeSdkRecord,
} from '../../../packages/shared/src/attendance/normalize.ts';
import {
  type AttendanceStore,
  reconcile,
} from '../../../packages/shared/src/attendance/reconcile.ts';
import type { ItemResult, ReceiptRow } from '../../../packages/shared/src/attendance/types.ts';
import { TRACKING_DEFAULTS } from '../../../packages/shared/src/config/tracking-defaults.ts';
import { base64UrlDecode } from '../../../packages/shared/src/crypto/encoding.ts';
import { apiError, json, newRequestId } from './http.ts';

/**
 * POST /functions/v1/ingest-location-batch (docs/spec/11; decisions #24, #39, #85, #90, #91).
 *
 * The native SDK deletes its WHOLE queued batch on any 2xx, so HTTP 200 is returned only when every
 * named record reached a durable terminal outcome (accepted / duplicate / rejected); anything else
 * is 503 and the SDK resends the batch (already-applied records then answer `duplicate`).
 * Identity, worker and projects come only from the device credential; payload ids are ignored.
 * Raw payloads, coordinates and secrets are never logged.
 */
export interface DeviceAuth {
  deviceId: string;
  workerId: string;
  coordinatesAllowed: boolean;
  fences: DeviceFence[];
}

export type DeviceAuthResult =
  { status: 'OK'; device: DeviceAuth } | { status: 'INVALID' | 'REVOKED' | 'EXPIRED' };

export interface QuarantineRow {
  event_uuid: string | null;
  device_id: string;
  reason: string;
  sanitized_payload: Record<string, unknown>;
}

export interface IngestDeps {
  /** Server receive time, canonical ISO-8601 UTC. */
  now(): string;
  requestId?(): string;
  /** Throws on a temporary failure (→ 503). */
  authenticate(tokenSha256: Uint8Array): Promise<DeviceAuthResult>;
  /** false = over 60 requests/minute or 600 events/hour (→ 429). */
  rateLimit(deviceId: string, events: number): Promise<boolean>;
  /** Existing durable outcomes for these uuids: true when it is this device's own record. */
  receipts(deviceId: string, uuids: readonly string[]): Promise<Map<string, boolean>>;
  /** Durable rejected / proof-of-life outcomes and their sanitized quarantine copies (atomic). */
  recordTerminals(
    requestId: string,
    receipts: readonly ReceiptRow[],
    quarantine: readonly QuarantineRow[],
  ): Promise<void>;
  store: AttendanceStore;
  /** Safe structured log line (ids truncated, counts and codes only). */
  log?(entry: Record<string, unknown>): void;
}

const BEARER = /^Bearer ([A-Za-z0-9_-]{43})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BYTES = TRACKING_DEFAULTS.location_ingest_max_payload_bytes;

interface FenceJson {
  projectId: string;
  configVersionId: string;
  identifier: string;
  center: { lat: number; lng: number };
  nativeRadiusM: number | string;
}

/** `edge_device_authenticate` result → typed outcome (unknown shapes fail closed as INVALID). */
export function deviceAuthFromJson(value: unknown): DeviceAuthResult {
  const data = (value ?? {}) as Record<string, unknown>;
  if (data.status === 'REVOKED' || data.status === 'EXPIRED') return { status: data.status };
  if (
    data.status !== 'OK' ||
    typeof data.device_id !== 'string' ||
    typeof data.worker_id !== 'string' ||
    !Array.isArray(data.fences)
  ) {
    return { status: 'INVALID' };
  }
  return {
    status: 'OK',
    device: {
      deviceId: data.device_id,
      workerId: data.worker_id,
      coordinatesAllowed: data.coordinates_allowed === true,
      fences: (data.fences as FenceJson[]).map((fence) => ({
        projectId: fence.projectId,
        configVersionId: fence.configVersionId,
        identifier: fence.identifier,
        center: { lat: Number(fence.center.lat), lng: Number(fence.center.lng) },
        nativeRadiusM: Number(fence.nativeRadiusM),
      })),
    },
  };
}

function uuidOf(raw: unknown): string | null {
  const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).uuid : null;
  return typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null;
}

function eventOf(raw: unknown): string | null {
  const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).event : null;
  return typeof value === 'string' ? value.slice(0, 32) : null;
}

interface Slot {
  uuid: string | null;
  result?: ItemResult;
  normalized?: NormalizedRecord;
}

/** Applies one authenticated batch; throws when any record cannot be made durable. */
export async function processLocationBatch(
  records: readonly unknown[],
  device: DeviceAuth,
  receivedAt: string,
  requestId: string,
  deps: Pick<IngestDeps, 'receipts' | 'recordTerminals' | 'store'>,
): Promise<ItemResult[]> {
  const context: DeviceContext = {
    deviceId: device.deviceId,
    workerId: device.workerId,
    fences: device.fences,
    coordinatesAllowed: device.coordinatesAllowed,
  };
  const named = [...new Set(records.map(uuidOf).filter((uuid): uuid is string => uuid !== null))];
  const existing = named.length > 0 ? await deps.receipts(device.deviceId, named) : new Map();
  const seen = new Set<string>();
  const slots: Slot[] = [];
  const receipts: ReceiptRow[] = [];
  const quarantine: QuarantineRow[] = [];

  for (const raw of records) {
    const uuid = uuidOf(raw);
    if (uuid && (seen.has(uuid) || existing.get(uuid) === true)) {
      slots.push({
        uuid,
        result: { eventUuid: uuid, status: 'duplicate', reason: null, review: false },
      });
      continue;
    }
    if (uuid && existing.get(uuid) === false) {
      // Another device already owns this uuid: refuse it without touching that record.
      seen.add(uuid);
      quarantine.push({
        event_uuid: uuid,
        device_id: device.deviceId,
        reason: 'EVENT_UUID_CONFLICT',
        sanitized_payload: { event: eventOf(raw) },
      });
      slots.push({
        uuid,
        result: {
          eventUuid: uuid,
          status: 'rejected',
          reason: 'EVENT_UUID_CONFLICT',
          review: false,
        },
      });
      continue;
    }
    if (uuid) seen.add(uuid);
    const normalized = normalizeSdkRecord(context, raw, receivedAt);
    if (normalized.kind === 'terminal') {
      if (normalized.receipt) receipts.push(normalized.receipt);
      if (normalized.quarantine) {
        quarantine.push({
          event_uuid: normalized.sourceUuid,
          device_id: device.deviceId,
          reason: normalized.result?.reason ?? 'INVALID_RECORD',
          sanitized_payload: normalized.quarantine,
        });
      }
    }
    slots.push({ uuid, normalized });
  }

  if (receipts.length > 0 || quarantine.length > 0) {
    await deps.recordTerminals(requestId, receipts, quarantine);
  }
  const evidence = slots.flatMap((slot) =>
    slot.normalized?.kind === 'evidence' ? slot.normalized.evidence : [],
  );
  const outcome =
    evidence.length > 0 ? await reconcile(deps.store, evidence, receivedAt) : new Map();

  const results: ItemResult[] = [];
  for (const slot of slots) {
    // A record without a valid uuid cannot be acknowledged on its own: it was quarantined.
    if (!slot.uuid) continue;
    if (slot.result) {
      results.push(slot.result);
      continue;
    }
    const normalized = slot.normalized as NormalizedRecord;
    if (normalized.kind === 'terminal') {
      if (!normalized.result) throw new Error('TERMINAL_RESULT_MISSING');
      results.push(normalized.result);
      continue;
    }
    const parts = normalized.evidence.map((item) => outcome.get(item.eventUuid));
    if (parts.some((part) => part === undefined)) throw new Error('RECONCILE_INCOMPLETE');
    results.push(combineResults(normalized.sourceUuid, parts as ItemResult[]));
  }
  return results;
}

export async function handleIngest(req: Request, deps: IngestDeps): Promise<Response> {
  const requestId = deps.requestId?.() ?? newRequestId();
  let deviceTag: string | null = null;
  const finish = (
    response: Response,
    outcome: string,
    extra: Record<string, unknown> = {},
  ): Response => {
    deps.log?.({
      fn: 'ingest-location-batch',
      request_id: requestId,
      device: deviceTag,
      status: response.status,
      outcome,
      ...extra,
    });
    return response;
  };

  if (req.method !== 'POST') {
    return finish(
      apiError(405, 'METHOD_NOT_ALLOWED', requestId, 'Use POST.', { allow: 'POST' }),
      'method',
    );
  }
  const bearer = BEARER.exec(req.headers.get('authorization') ?? '');
  if (!bearer?.[1]) {
    return finish(
      apiError(401, 'UNAUTHENTICATED', requestId, 'A device credential is required.'),
      'no_credential',
    );
  }
  if (!(req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
    return finish(
      apiError(415, 'UNSUPPORTED_MEDIA_TYPE', requestId, 'Send application/json.'),
      'media_type',
    );
  }
  if (Number(req.headers.get('content-length') ?? '0') > MAX_BYTES) {
    return finish(apiError(413, 'PAYLOAD_TOO_LARGE', requestId, 'Batch too large.'), 'too_large');
  }
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.length > MAX_BYTES) {
    return finish(apiError(413, 'PAYLOAD_TOO_LARGE', requestId, 'Batch too large.'), 'too_large');
  }

  let auth: DeviceAuthResult;
  try {
    auth = await deps.authenticate(sha256(base64UrlDecode(bearer[1])));
  } catch {
    return finish(
      apiError(503, 'TEMPORARILY_UNAVAILABLE', requestId, 'Try again shortly.'),
      'auth_unavailable',
    );
  }
  if (auth.status !== 'OK') {
    return finish(
      apiError(401, 'UNAUTHENTICATED', requestId, 'The device credential is not valid.'),
      `credential_${auth.status.toLowerCase()}`,
    );
  }
  deviceTag = auth.device.deviceId.slice(0, 8);

  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return finish(
      apiError(422, 'INVALID_REQUEST', requestId, 'Body is not valid JSON.'),
      'invalid_json',
    );
  }
  const envelope = SdkBatchEnvelopeSchema.safeParse(body);
  if (!envelope.success) {
    return finish(
      apiError(422, 'INVALID_REQUEST', requestId, 'Invalid batch envelope.'),
      'invalid_envelope',
    );
  }
  const records = envelope.data.locations;
  if (!records.some((record) => uuidOf(record) !== null)) {
    return finish(
      apiError(422, 'INVALID_REQUEST', requestId, 'No record carries an event uuid.'),
      'no_uuid',
    );
  }

  let allowed: boolean;
  try {
    allowed = await deps.rateLimit(auth.device.deviceId, records.length);
  } catch {
    return finish(
      apiError(503, 'TEMPORARILY_UNAVAILABLE', requestId, 'Try again shortly.'),
      'rate_limit_unavailable',
    );
  }
  if (!allowed) {
    return finish(
      apiError(429, 'RATE_LIMITED', requestId, 'Too many uploads; retry later.', {
        'retry-after': '60',
      }),
      'rate_limited',
    );
  }

  let results: ItemResult[];
  try {
    results = await processLocationBatch(records, auth.device, deps.now(), requestId, deps);
  } catch {
    return finish(
      apiError(
        503,
        'TEMPORARILY_UNAVAILABLE',
        requestId,
        'Not every record could be stored; retry.',
      ),
      'not_durable',
      { records: records.length },
    );
  }
  const tally: Record<string, number> = {};
  for (const result of results) {
    const key = result.reason ? `${result.status}:${result.reason}` : result.status;
    tally[key] = (tally[key] ?? 0) + 1;
  }
  return finish(
    json(200, {
      schema_version: 1,
      request_id: requestId,
      results: results.map((result) => ({
        event_uuid: result.eventUuid,
        status: result.status,
        reason: result.reason,
      })),
    }),
    'ok',
    { records: records.length, results: tally },
  );
}
