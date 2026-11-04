import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import {
  type OperationChildResult,
  type OperationEvent,
  OperationEventSchema,
  type OperationResult,
  sourceForOperation,
} from '../../../packages/shared/src/api/operations.ts';
import {
  type ApiErrorCode,
  SchemaVersionSchema,
  UtcIsoSchema,
  UuidSchema,
} from '../../../packages/shared/src/api/common.ts';
import { deriveUuid } from '../../../packages/shared/src/attendance/config.ts';
import {
  type AttendanceStore,
  reconcile,
} from '../../../packages/shared/src/attendance/reconcile.ts';
import type { Evidence, ItemResult } from '../../../packages/shared/src/attendance/types.ts';
import { TRACKING_DEFAULTS } from '../../../packages/shared/src/config/tracking-defaults.ts';
import { base64UrlDecode } from '../../../packages/shared/src/crypto/encoding.ts';
import { type BadgeDeps, verifyDynamicBadge } from './badge-core.ts';
import { apiError, json, newRequestId, readJsonBody } from './http.ts';

/**
 * POST /functions/v1/ingest-operations (docs/spec/11 "Operational offline outbox contract";
 * docs/spec/04 "Kiosk / foreman / manual state transitions"; decisions #84, #98–#103).
 *
 * The phone's expo-sqlite outbox sends kiosk scans, foreman crew sign-ins/outs, manual
 * corrections and visitor sign-ins/outs, possibly hours after they happened. Every operation gets
 * its own terminal result (accepted / duplicate / rejected) and a foreman batch gets one result
 * per named worker; nothing is silently partial. The caller's identity and permissions come from
 * the database through their own JWT (`operation_context`); payload ids are never authority.
 * A failure of the store answers 503 for the whole request: nothing was acknowledged, and the
 * outbox resends it (already-applied operations then answer `duplicate`).
 */
export interface OperationContext {
  userId: string;
  projectId: string | null;
  projectStatus: string | null;
  kiosk: 'ALL' | 'OWN_CREW' | null;
  visitors: boolean;
  correct: boolean;
  foremanCompanyIds: string[];
}

export interface StoredReceipt {
  eventUuid: string;
  actorId: string | null;
  projectId: string | null;
  status: 'accepted' | 'duplicate' | 'rejected';
  reason: string | null;
  workerId: string | null;
  children: OperationChildResult[];
  review: boolean;
}

export interface ReceiptRow {
  event_uuid: string;
  kiosk_device_id: string | null;
  actor_id: string;
  project_id: string | null;
  operation_type: string;
  status: 'accepted' | 'duplicate' | 'rejected';
  reason: string | null;
  worker_id: string | null;
  children: OperationChildResult[];
  review: boolean;
  observed_at: string | null;
}

export interface WorkerFact {
  workerId: string;
  enrolled: boolean;
  approved: boolean;
  /** Attendance eligibility (decision #56): approved, employer verified, notice acknowledged. */
  eligible: boolean;
  companyId: string | null;
}

export type VisitorRegistration =
  'ok' | 'VISITOR_ID_CONFLICT' | 'VISITOR_DETAILS_REQUIRED' | 'HOST_NOT_FOUND';

export interface OperationsDeps {
  now(): number;
  requestId?: string;
  /** Permissions of the signed-in caller on one project (database, caller's own JWT). */
  context(projectId: string): Promise<OperationContext>;
  rateLimit(actorId: string, operations: number): Promise<boolean>;
  receipts(eventUuids: string[]): Promise<StoredReceipt[]>;
  recordReceipts(requestId: string, rows: ReceiptRow[]): Promise<void>;
  /** An ACTIVE kiosk registration (null when unknown or revoked). */
  kiosk(kioskDeviceId: string): Promise<{ id: string; projectId: string } | null>;
  /** AES-256-GCM key for device badge secrets; null when not configured (fails closed: 503). */
  badgeKey: Uint8Array | null;
  loadBadgeDevice: BadgeDeps['loadDevice'];
  redeemBadgeStep(input: {
    projectId: string;
    deviceId: string;
    timeStep: number;
    eventUuid: string;
    actorId: string;
    kioskDeviceId: string;
  }): Promise<'accepted' | 'duplicate' | 'replay'>;
  printedBadge(codeSha256Hex: string): Promise<{ workerId: string; active: boolean } | null>;
  workers(projectId: string, workerIds: string[]): Promise<WorkerFact[]>;
  registerVisitor(input: {
    projectId: string;
    visitorId: string;
    name: string | null;
    organization: string | null;
    hostUserId: string | null;
    purpose: string | null;
    actorId: string;
  }): Promise<VisitorRegistration>;
  applyVisitor(input: {
    eventUuid: string;
    projectId: string;
    visitorKey: string;
    direction: 'ENTRY' | 'EXIT';
    observedAt: string;
    actorId: string;
    kioskDeviceId: string | null;
  }): Promise<ItemResult>;
  store: AttendanceStore;
  log?(entry: Record<string, unknown>): void;
}

/** The caller's JWT was refused by the database (anon key, deleted user): 401, nothing recorded. */
export class OperationsAuthError extends Error {}

export function contextFromJson(value: unknown): OperationContext {
  const row = (value ?? {}) as Record<string, unknown>;
  if (typeof row.user_id !== 'string') throw new OperationsAuthError('no user');
  return {
    userId: row.user_id,
    projectId: typeof row.project_id === 'string' ? row.project_id : null,
    projectStatus: typeof row.project_status === 'string' ? row.project_status : null,
    kiosk: row.kiosk === 'ALL' || row.kiosk === 'OWN_CREW' ? row.kiosk : null,
    visitors: row.visitors === true,
    correct: row.correct === true,
    foremanCompanyIds: Array.isArray(row.foreman_company_ids)
      ? row.foreman_company_ids.filter((id): id is string => typeof id === 'string')
      : [],
  };
}

export function receiptsFromJson(value: unknown): StoredReceipt[] {
  return ((value as Record<string, unknown>[] | null) ?? []).map((row) => ({
    eventUuid: String(row.event_uuid),
    actorId: typeof row.actor_id === 'string' ? row.actor_id : null,
    projectId: typeof row.project_id === 'string' ? row.project_id : null,
    status: row.status as StoredReceipt['status'],
    reason: typeof row.reason === 'string' ? row.reason : null,
    workerId: typeof row.worker_id === 'string' ? row.worker_id : null,
    children: (row.children as OperationChildResult[] | null) ?? [],
    review: row.review === true,
  }));
}

/** `edge_operation_workers` rows → facts (missing or malformed fields read as false). */
export function workerFactsFromJson(value: unknown): WorkerFact[] {
  return ((value as Record<string, unknown>[] | null) ?? []).map((row) => ({
    workerId: String(row.worker_id),
    enrolled: row.enrolled === true,
    approved: row.approved === true,
    eligible: row.eligible === true,
    companyId: typeof row.company_id === 'string' ? row.company_id : null,
  }));
}

/** `edge_kiosk_device` row (ACTIVE kiosks only) → id and project. */
export function kioskFromJson(value: unknown): { id: string; projectId: string } | null {
  const row = value as Record<string, unknown> | null;
  return row && typeof row.id === 'string' && typeof row.project_id === 'string'
    ? { id: row.id, projectId: row.project_id }
    : null;
}

/** `edge_printed_badge_worker` row → the badge's worker and whether it is still active. */
export function printedBadgeFromJson(value: unknown): { workerId: string; active: boolean } | null {
  const row = value as Record<string, unknown> | null;
  return row && typeof row.worker_id === 'string'
    ? { workerId: row.worker_id, active: row.active === true }
    : null;
}

/** `edge_badge_device` row → badge verification input. */
export function badgeDeviceFromJson(
  value: unknown,
): { active: boolean; workerId: string; ciphertext: Uint8Array } | null {
  const row = value as Record<string, unknown> | null;
  if (!row || typeof row.worker_id !== 'string' || typeof row.secret_ciphertext !== 'string') {
    return null;
  }
  return {
    active: row.active === true,
    workerId: row.worker_id,
    ciphertext: base64UrlDecode(row.secret_ciphertext),
  };
}

const MAX_PROJECTS_PER_REQUEST = 10;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

type Pending =
  | { kind: 'done'; result: OperationResult; row: ReceiptRow | null }
  | {
      kind: 'single';
      event: OperationEvent;
      evidence: Evidence;
      workerId: string | null;
      kioskDeviceId: string | null;
    }
  | {
      kind: 'crew';
      event: OperationEvent;
      children: { workerId: string; uuid: string; rejected: string | null }[];
    };

function codeHash(code: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(code)));
}

function compact(result: OperationResult): OperationResult {
  const out: OperationResult = {
    event_uuid: result.event_uuid,
    status: result.status,
    reason: result.reason,
  };
  if (result.children && result.children.length > 0) out.children = result.children;
  if (result.worker_id) out.worker_id = result.worker_id;
  if (result.review) out.review = true;
  if (result.original_status) out.original_status = result.original_status;
  return out;
}

const hasAnyPermission = (ctx: OperationContext) =>
  ctx.projectId !== null &&
  (ctx.kiosk !== null || ctx.visitors || ctx.correct || ctx.foremanCompanyIds.length > 0);

/** Validates, authorizes and applies a request body. Throws only on infrastructure failure. */
export async function processOperations(
  body: unknown,
  deps: OperationsDeps,
): Promise<
  | { status: 200; results: OperationResult[] }
  | { status: 422 | 429; code: ApiErrorCode; message: string }
> {
  const envelope = body as { schema_version?: unknown; client_sent_at?: unknown; events?: unknown };
  if (
    !envelope ||
    typeof envelope !== 'object' ||
    !SchemaVersionSchema.safeParse(envelope.schema_version).success ||
    !UtcIsoSchema.safeParse(envelope.client_sent_at).success ||
    !Array.isArray(envelope.events) ||
    envelope.events.length < 1 ||
    envelope.events.length > TRACKING_DEFAULTS.operations_ingest_max_events
  ) {
    return { status: 422, code: 'INVALID_REQUEST', message: 'Invalid operations envelope.' };
  }
  const receivedAt = deps.now();
  const clientSentAt = Date.parse(envelope.client_sent_at as string);
  // The kiosk clock offset, measured from this request (decision #84).
  const offset = clientSentAt - receivedAt;
  const skewed = Math.abs(offset) > TRACKING_DEFAULTS.max_device_clock_skew_seconds * 1000;

  // Each event on its own: a malformed one is refused, the others still count.
  const parsed: { raw: unknown; uuid: string; event: OperationEvent | null }[] = [];
  for (const raw of envelope.events as unknown[]) {
    const uuid = UuidSchema.safeParse((raw as { event_uuid?: unknown } | null)?.event_uuid);
    if (!uuid.success) continue; // nothing to acknowledge it by
    const event = OperationEventSchema.safeParse(raw);
    parsed.push({ raw, uuid: uuid.data, event: event.success ? event.data : null });
  }
  if (parsed.length === 0) {
    return {
      status: 422,
      code: 'INVALID_REQUEST',
      message: 'No operation has a valid event_uuid.',
    };
  }

  const projectIds = [...new Set(parsed.flatMap((p) => (p.event ? [p.event.project_id] : [])))];
  if (projectIds.length > MAX_PROJECTS_PER_REQUEST) {
    return { status: 422, code: 'INVALID_REQUEST', message: 'At most 10 projects per request.' };
  }
  const contexts = new Map<string, OperationContext>();
  for (const projectId of projectIds) contexts.set(projectId, await deps.context(projectId));
  // The caller, as the database sees their JWT (the nil project answers with no permissions).
  const actorId = ([...contexts.values()][0] ?? (await deps.context(NIL_UUID))).userId;
  if (!(await deps.rateLimit(actorId, parsed.length))) {
    return { status: 429, code: 'RATE_LIMITED', message: 'Too many operations. Try again soon.' };
  }

  const stored = new Map(
    (await deps.receipts([...new Set(parsed.map((p) => p.uuid))])).map((r) => [r.eventUuid, r]),
  );
  const pending: Pending[] = [];
  const firstIndex = new Map<string, number>();
  const evidence: Evidence[] = [];
  const iso = (ms: number) => new Date(ms).toISOString();

  const done = (
    event: OperationEvent | null,
    uuid: string,
    status: OperationResult['status'],
    reason: string | null,
    extra: Partial<OperationResult> & {
      projectId?: string | null;
      kioskDeviceId?: string | null;
    } = {},
  ): Pending => {
    const { projectId, kioskDeviceId, ...fields } = extra;
    const result = compact({ event_uuid: uuid, status, reason, ...fields });
    return {
      kind: 'done',
      result,
      row: {
        event_uuid: uuid,
        kiosk_device_id: kioskDeviceId ?? null,
        actor_id: actorId,
        project_id: projectId === undefined ? (event?.project_id ?? null) : projectId,
        operation_type: event?.operation_type ?? 'INVALID',
        status,
        reason,
        worker_id: result.worker_id ?? null,
        children: result.children ?? [],
        review: result.review ?? false,
        observed_at: event?.observed_at ?? null,
      },
    };
  };

  for (const [index, item] of parsed.entries()) {
    const previous = stored.get(item.uuid);
    if (previous) {
      // Re-sent after a lost response: answer from the receipt (decision #98).
      const mine =
        previous.actorId === actorId &&
        (previous.projectId === null || previous.projectId === item.event?.project_id);
      pending.push(
        mine
          ? {
              kind: 'done',
              row: null,
              result: compact({
                event_uuid: item.uuid,
                status: 'duplicate',
                reason: previous.reason,
                children: previous.children,
                worker_id: previous.workerId,
                review: previous.review,
                original_status: previous.status === 'duplicate' ? undefined : previous.status,
              }),
            }
          : {
              kind: 'done',
              row: null,
              result: compact({
                event_uuid: item.uuid,
                status: 'rejected',
                reason: 'EVENT_UUID_CONFLICT',
              }),
            },
      );
      continue;
    }
    if (firstIndex.has(item.uuid)) {
      pending.push({
        kind: 'done',
        row: null,
        result: { event_uuid: item.uuid, status: 'duplicate', reason: null },
      });
      continue;
    }
    firstIndex.set(item.uuid, index);
    const event = item.event;
    if (!event) {
      pending.push(done(null, item.uuid, 'rejected', 'INVALID_OPERATION', { projectId: null }));
      continue;
    }
    const ctx = contexts.get(event.project_id) as OperationContext;
    if (!hasAnyPermission(ctx)) {
      // Never record anything against a project the caller has no role on.
      pending.push(
        done(event, event.event_uuid, 'rejected', 'PROJECT_NOT_AUTHORIZED', { projectId: null }),
      );
      continue;
    }
    const observedAt = event.observed_at;
    switch (event.operation_type) {
      case 'KIOSK_ENTRY':
      case 'KIOSK_EXIT': {
        const payload = event.payload;
        if (!ctx.kiosk) {
          pending.push(done(event, event.event_uuid, 'rejected', 'FORBIDDEN'));
          break;
        }
        if (ctx.projectStatus !== 'ACTIVE') {
          pending.push(done(event, event.event_uuid, 'rejected', 'PROJECT_NOT_ACTIVE'));
          break;
        }
        const kiosk = await deps.kiosk(payload.kiosk_device_id);
        if (!kiosk || kiosk.projectId !== event.project_id) {
          pending.push(done(event, event.event_uuid, 'rejected', 'KIOSK_NOT_REGISTERED'));
          break;
        }
        const crewOnly = ctx.kiosk === 'OWN_CREW';
        let workerId: string | null = null;
        let rejection: string | null = null;
        if (payload.badge_kind === 'DYNAMIC_APP') {
          let notCrew = false;
          const verdict = await verifyDynamicBadge(
            {
              payload: payload.badge_payload,
              projectId: event.project_id,
              // A wrong kiosk clock is corrected by the measured offset before the ±1 step
              // check; the scan is then recorded for review only (decision #84).
              observedAt: new Date(Date.parse(observedAt) - (skewed ? offset : 0)),
            },
            {
              key: deps.badgeKey as Uint8Array,
              loadDevice: deps.loadBadgeDevice,
              isApproved: async (worker, projectId) => {
                const [fact] = await deps.workers(projectId, [worker]);
                if (!fact?.eligible) return false;
                if (crewOnly && !ctx.foremanCompanyIds.includes(fact.companyId ?? '')) {
                  notCrew = true;
                  return false;
                }
                return true;
              },
              redeem: (projectId, deviceId, timeStep) =>
                deps.redeemBadgeStep({
                  projectId,
                  deviceId,
                  timeStep,
                  eventUuid: event.event_uuid,
                  actorId,
                  kioskDeviceId: kiosk.id,
                }),
            },
          );
          if (verdict.status === 'rejected') rejection = notCrew ? 'NOT_OWN_CREW' : verdict.reason;
          else workerId = verdict.workerId;
        } else {
          const badge = await deps.printedBadge(codeHash(payload.badge_payload));
          if (!badge) rejection = 'BADGE_INVALID';
          else if (!badge.active) rejection = 'BADGE_REVOKED';
          else {
            const [fact] = await deps.workers(event.project_id, [badge.workerId]);
            if (!fact?.eligible) rejection = 'NOT_APPROVED';
            else if (crewOnly && !ctx.foremanCompanyIds.includes(fact.companyId ?? ''))
              rejection = 'NOT_OWN_CREW';
            else workerId = badge.workerId;
          }
        }
        if (rejection || !workerId) {
          pending.push(
            done(event, event.event_uuid, 'rejected', rejection ?? 'BADGE_INVALID', {
              kioskDeviceId: kiosk.id,
            }),
          );
          break;
        }
        const item: Evidence = {
          kind: 'WITNESSED',
          eventUuid: event.event_uuid,
          projectId: event.project_id,
          workerId,
          observedAt,
          receivedAt: iso(receivedAt),
          source: sourceForOperation(event.operation_type, payload.badge_kind) as
            'KIOSK_DYNAMIC_BADGE' | 'KIOSK_PRINTED_BADGE',
          direction: payload.direction,
          actorId,
          kioskDeviceId: kiosk.id,
          method: null,
          reviewReason: skewed ? 'KIOSK_CLOCK_SKEW' : null,
        };
        evidence.push(item);
        pending.push({ kind: 'single', event, evidence: item, workerId, kioskDeviceId: kiosk.id });
        break;
      }
      case 'FOREMAN_BULK_ENTRY':
      case 'FOREMAN_BULK_EXIT': {
        const payload = event.payload;
        if (!ctx.foremanCompanyIds.includes(payload.subcontractor_id)) {
          pending.push(done(event, event.event_uuid, 'rejected', 'COMPANY_NOT_AUTHORIZED'));
          break;
        }
        if (ctx.projectStatus !== 'ACTIVE') {
          pending.push(done(event, event.event_uuid, 'rejected', 'PROJECT_NOT_ACTIVE'));
          break;
        }
        const named = [...new Set(payload.worker_ids)];
        const facts = new Map(
          (await deps.workers(event.project_id, named)).map((fact) => [fact.workerId, fact]),
        );
        const children = named.map((workerId) => {
          const fact = facts.get(workerId);
          const rejected = !fact?.enrolled
            ? 'WORKER_NOT_ENROLLED'
            : fact.companyId !== payload.subcontractor_id
              ? 'WORKER_NOT_IN_COMPANY'
              : null;
          // One idempotency id per named worker (docs/spec/11): a resent batch never doubles.
          return {
            workerId,
            uuid: deriveUuid('foreman-member', `${event.event_uuid}|${workerId}`),
            rejected,
          };
        });
        for (const child of children) {
          if (child.rejected) continue;
          evidence.push({
            kind: 'WITNESSED',
            eventUuid: child.uuid,
            projectId: event.project_id,
            workerId: child.workerId,
            observedAt,
            receivedAt: iso(receivedAt),
            source: 'FOREMAN',
            direction: payload.direction,
            actorId,
            kioskDeviceId: null,
            method: payload.verification_method,
            reviewReason: skewed ? 'CLOCK_SKEW' : null,
          });
        }
        pending.push({ kind: 'crew', event, children });
        break;
      }
      case 'MANUAL_ATTENDANCE_CORRECTION': {
        const payload = event.payload;
        if (!ctx.correct) {
          pending.push(done(event, event.event_uuid, 'rejected', 'FORBIDDEN'));
          break;
        }
        const [fact] = await deps.workers(event.project_id, [payload.worker_id]);
        if (!fact?.enrolled) {
          pending.push(done(event, event.event_uuid, 'rejected', 'WORKER_NOT_ENROLLED'));
          break;
        }
        const item: Evidence = {
          kind: 'MANUAL',
          eventUuid: event.event_uuid,
          projectId: event.project_id,
          workerId: payload.worker_id,
          observedAt,
          receivedAt: iso(receivedAt),
          actorId,
          sessionId: payload.session_id ?? null,
          correctedStartAt: payload.corrected_start_at ?? null,
          correctedEndAt: payload.corrected_end_at ?? null,
          reason: payload.reason,
        };
        evidence.push(item);
        pending.push({
          kind: 'single',
          event,
          evidence: item,
          workerId: null,
          kioskDeviceId: null,
        });
        break;
      }
      case 'VISITOR_ENTRY':
      case 'VISITOR_EXIT': {
        const payload = event.payload;
        if (!ctx.visitors) {
          pending.push(done(event, event.event_uuid, 'rejected', 'FORBIDDEN'));
          break;
        }
        // The kiosk names a new visitor itself so it can sign them out offline (decision #101).
        const visitorId = payload.visitor_id ?? deriveUuid('visitor', event.event_uuid);
        const registration = await deps.registerVisitor({
          projectId: event.project_id,
          visitorId,
          name: payload.direction === 'ENTRY' ? (payload.name ?? null) : null,
          organization: payload.direction === 'ENTRY' ? (payload.organization ?? null) : null,
          hostUserId: payload.direction === 'ENTRY' ? payload.host_user_id : null,
          purpose: payload.direction === 'ENTRY' ? payload.purpose : null,
          actorId,
        });
        if (registration !== 'ok') {
          pending.push(
            done(
              event,
              event.event_uuid,
              'rejected',
              payload.direction === 'EXIT' && registration === 'VISITOR_DETAILS_REQUIRED'
                ? 'VISIT_NOT_FOUND'
                : registration,
            ),
          );
          break;
        }
        const result = await deps.applyVisitor({
          eventUuid: event.event_uuid,
          projectId: event.project_id,
          visitorKey: visitorId,
          direction: payload.direction,
          observedAt,
          actorId,
          kioskDeviceId: null,
        });
        pending.push(done(event, event.event_uuid, result.status, result.reason));
        break;
      }
      case 'MUSTER_SELF_REPORT':
      case 'MUSTER_PHYSICAL_VERIFY':
        // Active Muster Mode arrives in Milestone 11.
        pending.push(done(event, event.event_uuid, 'rejected', 'OPERATION_NOT_SUPPORTED'));
        break;
    }
  }

  const outcome =
    evidence.length > 0
      ? await reconcile(deps.store, evidence, iso(receivedAt))
      : new Map<string, ItemResult>();
  const missing = (uuid: string): ItemResult => {
    const result = outcome.get(uuid);
    if (!result) throw new Error(`reconciler returned no result for ${uuid}`);
    return result;
  };

  const results: OperationResult[] = [];
  const rows: ReceiptRow[] = [];
  for (const entry of pending) {
    if (entry.kind === 'done') {
      results.push(entry.result);
      if (entry.row) rows.push(entry.row);
      continue;
    }
    const event = entry.event;
    if (entry.kind === 'single') {
      const result = missing(entry.evidence.eventUuid);
      const authorized = result.status !== 'rejected';
      const finished = done(event, event.event_uuid, result.status, result.reason, {
        worker_id: authorized ? entry.workerId : null,
        review: result.review,
        kioskDeviceId: entry.kioskDeviceId,
      });
      if (finished.kind === 'done') {
        results.push(finished.result);
        if (finished.row) rows.push(finished.row);
      }
      continue;
    }
    const children: OperationChildResult[] = entry.children.map((child) => {
      if (child.rejected) {
        return {
          worker_id: child.workerId,
          child_event_uuid: child.uuid,
          status: 'rejected',
          reason: child.rejected,
        };
      }
      const result = missing(child.uuid);
      return {
        worker_id: child.workerId,
        child_event_uuid: child.uuid,
        status: result.status,
        reason: result.reason,
      };
    });
    const accepted = children.some((child) => child.status === 'accepted');
    const rejected = children.filter((child) => child.status === 'rejected');
    const status: OperationResult['status'] = accepted
      ? 'accepted'
      : rejected.length === children.length
        ? 'rejected'
        : rejected.length === 0
          ? 'duplicate'
          : 'accepted';
    const reason =
      rejected.length === 0
        ? null
        : rejected.length === children.length
          ? new Set(rejected.map((child) => child.reason)).size === 1
            ? (rejected[0]?.reason ?? null)
            : 'SOME_WORKERS_REJECTED'
          : 'SOME_WORKERS_REJECTED';
    const finished = done(event, event.event_uuid, status, reason, { children });
    if (finished.kind === 'done') {
      results.push(finished.result);
      if (finished.row) rows.push(finished.row);
    }
  }
  if (rows.length > 0) await deps.recordReceipts(deps.requestId ?? newRequestId(), rows);
  return { status: 200, results };
}

export async function handleOperations(req: Request, deps: OperationsDeps): Promise<Response> {
  const requestId = deps.requestId ?? newRequestId();
  const log = (entry: Record<string, unknown>) => deps.log?.({ request_id: requestId, ...entry });
  if (!/^Bearer\s+\S+$/i.test(req.headers.get('authorization') ?? '')) {
    return apiError(401, 'UNAUTHENTICATED', requestId, 'Sign in first.');
  }
  if (!deps.badgeKey) {
    // Without the badge key no offline badge can be checked: fail closed, the outbox keeps all.
    return apiError(503, 'CONFIGURATION_ERROR', requestId, 'Operations are not configured.');
  }
  const read = await readJsonBody(req, requestId);
  if (!read.ok) return read.response;
  try {
    const outcome = await processOperations(read.body, { ...deps, requestId });
    if (outcome.status !== 200) {
      log({ outcome: 'refused', status: outcome.status, code: outcome.code });
      return apiError(
        outcome.status,
        outcome.code,
        requestId,
        outcome.message,
        outcome.status === 429 ? { 'retry-after': '60' } : {},
      );
    }
    log({
      outcome: 'ok',
      operations: outcome.results.length,
      rejected: outcome.results.filter((r) => r.status === 'rejected').length,
    });
    return json(200, { schema_version: 1, request_id: requestId, results: outcome.results });
  } catch (error) {
    if (error instanceof OperationsAuthError) {
      log({ outcome: 'refused', status: 401 });
      return apiError(401, 'UNAUTHENTICATED', requestId, 'Sign in again.');
    }
    log({
      outcome: 'fail',
      error: error instanceof Error ? error.message.slice(0, 120) : 'unknown',
    });
    return apiError(503, 'TEMPORARILY_UNAVAILABLE', requestId, 'Nothing was recorded. Try again.');
  }
}
