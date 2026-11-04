import { configFromSettings } from './config.ts';
import { emptyTrack } from './engine.ts';
import type { AttendanceStore, TrackLoad } from './reconcile.ts';
import type {
  AttendanceConfig,
  EngineOutput,
  ProjectContext,
  SessionRecord,
  TrackState,
} from './types.ts';

/**
 * One codec between the reconciler's database functions (`edge_attendance_load` /
 * `edge_attendance_commit`, Milestone 06) and the engine types, shared by the Edge Functions and
 * the database-mode replay so both talk to Postgres identically.
 */
type Json = Record<string, unknown>;

interface ConfigRow {
  configVersionId: string;
  projectId: string;
  versionNumber: number;
  effectiveAt: string;
  settings: Record<string, unknown>;
  center: { lat: number; lng: number };
  radiusM: number | string;
  exitHysteresisM: number | string;
}

function toConfig(row: ConfigRow): AttendanceConfig {
  return configFromSettings({
    configVersionId: row.configVersionId,
    projectId: row.projectId,
    versionNumber: row.versionNumber,
    effectiveAt: row.effectiveAt,
    settings: row.settings,
    center: row.center,
    radiusM: Number(row.radiusM),
    exitHysteresisM: Number(row.exitHysteresisM),
  });
}

function toSession(json: Json): SessionRecord {
  return { ...(json as unknown as SessionRecord) };
}

function toTrack(json: Json): TrackState {
  const track = json as unknown as TrackState & { current: Json | null; previous: Json | null };
  return {
    ...track,
    revision: Number(track.revision),
    current: track.current ? toSession(track.current) : null,
    previous: track.previous ? toSession(track.previous) : null,
  };
}

/** `edge_attendance_load` result → engine state and context. */
export function trackLoadFromJson(json: Json, projectId: string, workerId: string): TrackLoad {
  const configs = ((json.configs as ConfigRow[] | undefined) ?? []).map(toConfig);
  const latest = [...configs].sort((a, b) => b.versionNumber - a.versionNumber)[0];
  if (!latest) throw new Error('CONFIG_VERSION_MISSING');
  const eligibility = json.eligibility as {
    eligible: boolean;
    reason: string | null;
    employerId: string | null;
  };
  const position = json.lastPosition as {
    lat: number;
    lng: number;
    accuracyM: number | string;
    observedAt: string;
  } | null;
  return {
    state: json.track
      ? toTrack(json.track as Json)
      : emptyTrack(projectId, workerId, latest.configVersionId),
    ctx: {
      project: json.project as ProjectContext,
      configs: new Map(configs.map((config) => [config.configVersionId, config])),
      eligibility: { eligible: eligibility.eligible, reason: eligibility.reason },
      duplicates: new Set((json.duplicates as string[] | undefined) ?? []),
      lastPosition: position
        ? {
            lat: position.lat,
            lng: position.lng,
            accuracyM: Number(position.accuracyM),
            observedAt: position.observedAt,
          }
        : null,
      extraSessions: new Map(
        ((json.extraSessions as Json[] | undefined) ?? []).map((session) => [
          String(session.id),
          toSession(session),
        ]),
      ),
      employerSnapshotId: eligibility.employerId,
    },
  };
}

/** Engine output → the `edge_attendance_commit` changeset (atomic compare-and-swap). */
export function changesetFromOutput(output: EngineOutput, expectedRevision: number): Json {
  return {
    projectId: output.state.projectId,
    workerId: output.state.workerId,
    expectedRevision,
    state: output.state,
    sessions: output.sessions,
    events: output.events,
    receipts: output.receipts,
    corrections: output.corrections,
    position: output.position,
  };
}

/** Calls one service-role database function; throws on any failure (caller answers 503). */
export type ServiceRpc = (fn: string, args: Record<string, unknown>) => Promise<unknown>;

/** The attendance store behind an RPC transport (PostgREST in Edge Functions). */
export class RpcAttendanceStore implements AttendanceStore {
  constructor(private readonly rpc: ServiceRpc) {}

  async load(
    projectId: string,
    workerId: string,
    eventUuids: readonly string[],
    sessionIds: readonly string[],
  ): Promise<TrackLoad> {
    const json = await this.rpc('edge_attendance_load', {
      p_project: projectId,
      p_worker: workerId,
      p_event_uuids: [...eventUuids],
      p_session_ids: [...sessionIds],
    });
    if (!json || typeof json !== 'object') throw new Error('ATTENDANCE_LOAD_FAILED');
    return trackLoadFromJson(json as Json, projectId, workerId);
  }

  async commit(output: EngineOutput, expectedRevision: number): Promise<'ok' | 'conflict'> {
    const result = await this.rpc('edge_attendance_commit', {
      p_changeset: changesetFromOutput(output, expectedRevision),
    });
    if (result === 'ok' || result === 'conflict') return result;
    throw new Error('ATTENDANCE_COMMIT_FAILED');
  }
}
