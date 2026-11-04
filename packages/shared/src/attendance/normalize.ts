import { SdkEventWireSchema } from '../api/location-ingest.ts';
import { containsCoordinateKeys, stripCoordinateKeys } from '../privacy/coordinates.ts';
import { deriveUuid } from './config.ts';
import { distanceMeters } from './geo.ts';
import type { Evidence, ItemResult, ReceiptRow } from './types.ts';

/**
 * Turns native SDK records (docs/spec/11 SdkEventWireSchema) into engine evidence. Identity and
 * project come only from the device credential context; identifiers the device is not bound to
 * are rejected without looking at any other project (PROJECT_NOT_AUTHORIZED). Coordinates are
 * accepted only inside a bound native fence; anything else is discarded, never stored.
 */
export interface DeviceFence {
  projectId: string;
  configVersionId: string;
  identifier: string;
  center: { lat: number; lng: number };
  /** Native fence radius = site radius + exit hysteresis. */
  nativeRadiusM: number;
}

export interface DeviceContext {
  deviceId: string;
  workerId: string;
  /** Fences of every bound project: current version plus versions of still-open sessions. */
  fences: readonly DeviceFence[];
  /**
   * false while continuous coordinates are not released for this platform/build (decision #90):
   * any record that carries coordinates is rejected and nothing about the position is kept.
   * Defaults to true.
   */
  coordinatesAllowed?: boolean;
}

export type NormalizedRecord =
  | {
      kind: 'evidence';
      /** The SDK record uuid; fan-out evidence (several projects) uses derived uuids. */
      sourceUuid: string;
      evidence: Evidence[];
    }
  | {
      kind: 'terminal';
      sourceUuid: string | null;
      result: ItemResult | null;
      receipt: ReceiptRow | null;
      /** Bounded, coordinate-free copy for the restricted quarantine (rejected records only). */
      quarantine: Record<string, unknown> | null;
    };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sanitized(raw: unknown): Record<string, unknown> {
  const copy = stripCoordinateKeys(raw);
  const text = JSON.stringify(copy ?? null) ?? 'null';
  if (text.length <= 2000 && copy && typeof copy === 'object' && !Array.isArray(copy)) {
    return copy as Record<string, unknown>;
  }
  return { truncated: true, size: text.length };
}

function terminal(
  device: DeviceContext,
  raw: unknown,
  uuid: string | null,
  observedAt: string,
  receivedAt: string,
  status: 'accepted' | 'rejected',
  reason: string | null,
  eventType: ReceiptRow['event_type'] = 'OTHER',
): NormalizedRecord {
  return {
    kind: 'terminal',
    sourceUuid: uuid,
    result: uuid ? { eventUuid: uuid, status, reason, review: false } : null,
    receipt: uuid
      ? {
          event_uuid: uuid,
          device_id: device.deviceId,
          worker_id: device.workerId,
          project_id: null,
          config_version_id: null,
          event_type: eventType,
          observed_at: observedAt,
          server_received_at: receivedAt,
          accuracy_m: null,
          qualification_state: 'NOT_APPLICABLE',
          terminal_result: status,
          rejection_reason: status === 'rejected' ? reason : null,
        }
      : null,
    quarantine: status === 'rejected' ? sanitized(raw) : null,
  };
}

function projectsOf(device: DeviceContext): string[] {
  return [...new Set(device.fences.map((fence) => fence.projectId))].sort();
}

function monitoringFanOut(
  device: DeviceContext,
  uuid: string,
  observedAt: string,
  receivedAt: string,
  change: 'UNAVAILABLE' | 'RESTARTED',
  reason: string,
): NormalizedRecord {
  const projects = projectsOf(device);
  return {
    kind: 'evidence',
    sourceUuid: uuid,
    evidence: projects.map((projectId) => ({
      kind: 'MONITORING' as const,
      eventUuid: projects.length === 1 ? uuid : deriveUuid('fan-out', `${uuid}|${projectId}`),
      projectId,
      workerId: device.workerId,
      deviceId: device.deviceId,
      observedAt,
      receivedAt,
      change,
      reason,
    })),
  };
}

/** Location permission and provider state reported by the SDK `providerchange` event. */
function providerAvailable(provider: unknown): boolean {
  if (!provider || typeof provider !== 'object') return true;
  const p = provider as Record<string, unknown>;
  if (p.enabled === false || p.gps === false) return false;
  if (p.accuracyAuthorization === 1) return false; // iOS reduced accuracy / Android approximate
  if (typeof p.status === 'number' && p.status !== 3) return false; // only "Always" keeps automatic attendance
  return true;
}

export function normalizeSdkRecord(
  device: DeviceContext,
  raw: unknown,
  receivedAt: string,
): NormalizedRecord {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const uuid =
    typeof record.uuid === 'string' && UUID.test(record.uuid) ? record.uuid.toLowerCase() : null;
  const stamp =
    typeof record.timestamp === 'string' && !Number.isNaN(Date.parse(record.timestamp))
      ? record.timestamp
      : receivedAt;

  // Geofence and provider-change records must never carry coordinates (offsite privacy).
  if (record.event === 'geofence' && containsCoordinateKeys(record)) {
    return terminal(device, raw, uuid, stamp, receivedAt, 'rejected', 'COORDINATES_NOT_PERMITTED');
  }
  if (record.event === 'providerchange' && containsCoordinateKeys(record)) {
    return terminal(device, raw, uuid, stamp, receivedAt, 'rejected', 'PROVIDER_CHANGE_DISCARDED');
  }
  const parsed = SdkEventWireSchema.safeParse(raw);
  if (!parsed.success || !uuid) {
    return terminal(device, raw, uuid, stamp, receivedAt, 'rejected', 'INVALID_RECORD');
  }
  const wire = parsed.data;
  const observedAt = wire.timestamp;

  if (wire.event === 'geofence' && wire.geofence) {
    const fence = device.fences.find(
      (candidate) => candidate.identifier === wire.geofence?.identifier,
    );
    if (!fence) {
      return terminal(
        device,
        raw,
        uuid,
        observedAt,
        receivedAt,
        'rejected',
        'PROJECT_NOT_AUTHORIZED',
        wire.geofence.action === 'ENTER' ? 'GEOFENCE_ENTER' : 'GEOFENCE_EXIT',
      );
    }
    return {
      kind: 'evidence',
      sourceUuid: uuid,
      evidence: [
        {
          kind: 'GEOFENCE',
          eventUuid: uuid,
          projectId: fence.projectId,
          workerId: device.workerId,
          deviceId: device.deviceId,
          observedAt,
          receivedAt,
          action: wire.geofence.action,
          configVersionId: fence.configVersionId,
          accuracyM: wire.accuracy ?? null,
        },
      ],
    };
  }

  if (wire.event === 'providerchange') {
    const provider = (raw as Record<string, unknown>).provider;
    return providerAvailable(provider)
      ? monitoringFanOut(device, uuid, observedAt, receivedAt, 'RESTARTED', 'PROVIDER_AVAILABLE')
      : monitoringFanOut(
          device,
          uuid,
          observedAt,
          receivedAt,
          'UNAVAILABLE',
          'PROVIDER_UNAVAILABLE',
        );
  }

  if (!wire.coords) {
    if (wire.extras && wire.extras.sitemuster_monitoring === 'RESTARTED') {
      return monitoringFanOut(
        device,
        uuid,
        observedAt,
        receivedAt,
        'RESTARTED',
        'MONITORING_RESTARTED',
      );
    }
    if (wire.event === 'location') {
      return terminal(device, raw, uuid, observedAt, receivedAt, 'rejected', 'INVALID_RECORD');
    }
    // Heartbeat / motion change without a position: proof of life only, no presence evidence.
    return terminal(device, raw, uuid, observedAt, receivedAt, 'accepted', null);
  }

  if (device.coordinatesAllowed === false) {
    return terminal(
      device,
      raw,
      uuid,
      observedAt,
      receivedAt,
      'rejected',
      'COORDINATES_NOT_PERMITTED',
      'ONSITE_FIX',
    );
  }
  const point = { lat: wire.coords.latitude, lng: wire.coords.longitude };
  const inside = projectsOf(device).filter((projectId) =>
    device.fences.some(
      (fence) =>
        fence.projectId === projectId && distanceMeters(point, fence.center) <= fence.nativeRadiusM,
    ),
  );
  if (inside.length === 0) {
    // An offsite coordinate reached the server: discard it immediately (never stored).
    return terminal(
      device,
      raw,
      uuid,
      observedAt,
      receivedAt,
      'rejected',
      'COORDINATES_NOT_PERMITTED',
      'ONSITE_FIX',
    );
  }
  const ambiguous = inside.length > 1;
  return {
    kind: 'evidence',
    sourceUuid: uuid,
    evidence: inside.map((projectId) => ({
      kind: 'FIX' as const,
      eventUuid: ambiguous ? deriveUuid('fan-out', `${uuid}|${projectId}`) : uuid,
      projectId,
      workerId: device.workerId,
      deviceId: device.deviceId,
      observedAt,
      receivedAt,
      lat: point.lat,
      lng: point.lng,
      accuracyM: wire.coords?.accuracy ?? Number.POSITIVE_INFINITY,
      mock: wire.mock === true,
      ambiguous,
    })),
  };
}

/** Combines per-project results of a fan-out record into the one result the SDK receives. */
export function combineResults(sourceUuid: string, results: readonly ItemResult[]): ItemResult {
  if (results.length === 0)
    return { eventUuid: sourceUuid, status: 'accepted', reason: null, review: false };
  if (results.every((result) => result.status === 'duplicate')) {
    return { eventUuid: sourceUuid, status: 'duplicate', reason: null, review: false };
  }
  const accepted = results.find((result) => result.status === 'accepted');
  if (accepted) {
    return {
      eventUuid: sourceUuid,
      status: 'accepted',
      reason: accepted.reason,
      review: results.some((r) => r.review),
    };
  }
  const rejected = results.find((result) => result.status === 'rejected');
  return {
    eventUuid: sourceUuid,
    status: rejected ? 'rejected' : 'duplicate',
    reason: rejected?.reason ?? null,
    review: false,
  };
}
