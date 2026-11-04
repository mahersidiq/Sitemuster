import {
  advanceVisits,
  type AttendanceConfig,
  type AttendanceEventRow,
  type AttendanceStore,
  applyVisitorEvent,
  configAt,
  containsCoordinateKeys,
  type CorrectionRow,
  emptyTrack,
  type EngineOutput,
  type ItemResult,
  ms,
  type ProjectContext,
  type ReceiptRow,
  type SessionRecord,
  sweepTrack,
  type TrackLoad,
  type TrackState,
  type VisitorEvent,
  type VisitRecord,
} from '@sitemuster/shared';

import type { Eligibility, ServerBackend, StoredPosition } from './backend';

/**
 * In-memory backend for the replay harness. `commit` enforces the same invariants as the database
 * migration (one OPEN/PENDING_APPROVAL/UNRESOLVED session per project and worker, no overlapping
 * sessions, unique event uuids, immutable session ownership, ordered bounds, coordinate-free
 * state) and throws on any violation — a violation is an engine bug, never a fixture outcome.
 */
const ACTIVE_OR_UNRESOLVED = new Set(['OPEN', 'PENDING_APPROVAL', 'UNRESOLVED']);

function key(projectId: string, workerId: string): string {
  return `${projectId}|${workerId}`;
}

export function assertSessionInvariants(sessions: readonly SessionRecord[]): void {
  const byTrack = new Map<string, SessionRecord[]>();
  for (const session of sessions) {
    const k = key(session.projectId, session.workerId);
    byTrack.set(k, [...(byTrack.get(k) ?? []), session]);
    if (session.endAt !== null && ms(session.endAt) < ms(session.startAt)) {
      throw new Error(`session ${session.id} ends before it starts`);
    }
    if ((session.endAt === null) !== (session.endSource === null)) {
      throw new Error(`session ${session.id} end time and end source disagree`);
    }
    if (
      (session.status === 'OPEN' || session.status === 'PENDING_APPROVAL') &&
      session.endAt !== null
    ) {
      throw new Error(`open session ${session.id} has an end time`);
    }
    if (
      session.endEarliestAt &&
      session.endLatestAt &&
      ms(session.endEarliestAt) > ms(session.endLatestAt)
    ) {
      throw new Error(`session ${session.id} has inverted end bounds`);
    }
    if (containsCoordinateKeys(session))
      throw new Error(`session ${session.id} carries coordinates`);
  }
  for (const [k, list] of byTrack) {
    const live = list.filter((session) => ACTIVE_OR_UNRESOLVED.has(session.status));
    if (live.length > 1) throw new Error(`more than one open/unresolved session for ${k}`);
    const ranges = list
      .filter((session) => session.status !== 'VOID')
      .map((session) => {
        const end = session.endAt ?? session.endLatestAt;
        return [ms(session.startAt), end ? ms(end) : Number.POSITIVE_INFINITY, session.id] as const;
      })
      .sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < ranges.length; i += 1) {
      const previous = ranges[i - 1];
      const current = ranges[i];
      if (
        previous &&
        current &&
        current[0] < previous[1] &&
        current[0] < current[1] &&
        previous[0] < previous[1]
      ) {
        throw new Error(`overlapping sessions ${previous[2]} and ${current[2]} for ${k}`);
      }
    }
  }
}

export class MemoryBackend implements ServerBackend, AttendanceStore {
  readonly mode = 'memory' as const;
  private readonly projects = new Map<string, ProjectContext>();
  private readonly configs = new Map<string, AttendanceConfig[]>();
  private readonly eligibility = new Map<string, Eligibility>();
  private readonly tracks = new Map<string, TrackState>();
  private readonly sessionRows = new Map<string, SessionRecord>();
  private readonly eventRows = new Map<string, AttendanceEventRow>();
  private readonly receiptRows = new Map<string, ReceiptRow>();
  private readonly correctionRows: CorrectionRow[] = [];
  private readonly positions = new Map<string, StoredPosition>();
  private readonly visitRows = new Map<string, VisitRecord>();

  get store(): AttendanceStore {
    return this;
  }

  async createProject(project: ProjectContext, first: AttendanceConfig): Promise<void> {
    this.projects.set(project.id, { ...project });
    this.configs.set(project.id, [first]);
  }

  async addConfigVersion(config: AttendanceConfig): Promise<void> {
    this.configs.get(config.projectId)?.push(config);
  }

  async setProjectStatus(projectId: string, status: ProjectContext['status']): Promise<void> {
    const project = this.projects.get(projectId);
    if (project) project.status = status;
  }

  async enrollWorker(projectId: string, workerId: string, eligibility: Eligibility): Promise<void> {
    this.eligibility.set(key(projectId, workerId), { ...eligibility });
  }

  async setEligibility(
    projectId: string,
    workerId: string,
    eligibility: Eligibility,
  ): Promise<void> {
    this.eligibility.set(key(projectId, workerId), { ...eligibility });
  }

  async load(
    projectId: string,
    workerId: string,
    eventUuids: readonly string[],
    sessionIds: readonly string[],
  ): Promise<TrackLoad> {
    const project = this.projects.get(projectId);
    const versions = this.configs.get(projectId) ?? [];
    if (!project || versions.length === 0) throw new Error(`unknown project ${projectId}`);
    const latest = [...versions].sort(
      (a, b) => b.versionNumber - a.versionNumber,
    )[0] as AttendanceConfig;
    const state = structuredClone(
      this.tracks.get(key(projectId, workerId)) ??
        emptyTrack(projectId, workerId, latest.configVersionId),
    );
    const eligibility = this.eligibility.get(key(projectId, workerId)) ?? {
      eligible: false,
      reason: 'ENROLLMENT_NOT_APPROVED',
    };
    const duplicates = new Set(
      eventUuids.filter(
        (uuid) =>
          this.receiptRows.has(uuid) ||
          this.eventRows.has(uuid) ||
          this.correctionRows.some((row) => row.event_uuid === uuid),
      ),
    );
    const position = this.positions.get(key(projectId, workerId));
    const extra = new Map<string, SessionRecord>();
    for (const id of sessionIds) {
      const row = this.sessionRows.get(id);
      if (row && row.projectId === projectId && row.workerId === workerId)
        extra.set(id, structuredClone(row));
    }
    return {
      state,
      ctx: {
        project: { ...project },
        configs: new Map(versions.map((config) => [config.configVersionId, config])),
        eligibility: { eligible: eligibility.eligible, reason: eligibility.reason },
        duplicates,
        lastPosition: position
          ? {
              lat: position.lat,
              lng: position.lng,
              accuracyM: position.accuracyM,
              observedAt: position.observedAt,
            }
          : null,
        extraSessions: extra,
        employerSnapshotId: eligibility.employerId ?? null,
      },
    };
  }

  async commit(output: EngineOutput, expectedRevision: number): Promise<'ok' | 'conflict'> {
    const state = output.state;
    const k = key(state.projectId, state.workerId);
    const current = this.tracks.get(k);
    if ((current?.revision ?? 0) !== expectedRevision) return 'conflict';
    for (const row of output.receipts) if (this.receiptRows.has(row.event_uuid)) return 'conflict';
    for (const row of output.events) if (this.eventRows.has(row.event_uuid)) return 'conflict';
    for (const row of output.corrections) {
      if (this.correctionRows.some((existing) => existing.event_uuid === row.event_uuid))
        return 'conflict';
    }
    const merged = new Map(this.sessionRows);
    for (const session of output.sessions) {
      const before = merged.get(session.id);
      if (
        before &&
        (before.projectId !== session.projectId || before.workerId !== session.workerId)
      ) {
        throw new Error(`session ${session.id} changed owner`);
      }
      if (session.projectId !== state.projectId || session.workerId !== state.workerId) {
        throw new Error(`session ${session.id} committed through another track`);
      }
      merged.set(session.id, structuredClone(session));
    }
    assertSessionInvariants(
      [...merged.values()].filter(
        (s) => s.projectId === state.projectId && s.workerId === state.workerId,
      ),
    );
    if (state.current && !ACTIVE_OR_UNRESOLVED.has(state.current.status)) {
      throw new Error('track current session is not open or unresolved');
    }
    if (
      containsCoordinateKeys(state) ||
      output.receipts.some((row) => containsCoordinateKeys(row))
    ) {
      throw new Error('coordinates in persisted attendance state');
    }
    for (const session of output.sessions)
      this.sessionRows.set(session.id, structuredClone(session));
    for (const row of output.receipts) this.receiptRows.set(row.event_uuid, { ...row });
    for (const row of output.events) this.eventRows.set(row.event_uuid, { ...row });
    for (const row of output.corrections) this.correctionRows.push(structuredClone(row));
    if (output.position?.op === 'set') {
      const { lat, lng, accuracyM, observedAt, expiryAt } = output.position;
      this.positions.set(k, { lat, lng, accuracyM, observedAt, expiryAt });
    } else if (output.position?.op === 'clear') {
      this.positions.delete(k);
    }
    this.tracks.set(k, { ...structuredClone(state), revision: expectedRevision + 1 });
    return 'ok';
  }

  async registerDevice(): Promise<void> {}

  async deactivateDevice(): Promise<void> {}

  async registerKiosk(): Promise<void> {}

  async insertReceipts(rows: readonly ReceiptRow[]): Promise<void> {
    for (const row of rows) {
      if (containsCoordinateKeys(row)) throw new Error('coordinates in a receipt');
      if (!this.receiptRows.has(row.event_uuid)) this.receiptRows.set(row.event_uuid, { ...row });
    }
  }

  async sweep(now: string): Promise<void> {
    for (const track of [...this.tracks.values()]) {
      await sweepTrack(this, track.projectId, track.workerId, now);
    }
    for (const visit of advanceVisits([...this.visitRows.values()], now))
      this.visitRows.set(visit.id, visit);
    for (const [k, position] of this.positions)
      if (ms(position.expiryAt) <= ms(now)) this.positions.delete(k);
  }

  async visitorEvent(event: VisitorEvent): Promise<ItemResult> {
    const project = this.projects.get(event.projectId);
    const config = configAt(this.configs.get(event.projectId) ?? [], event.observedAt);
    if (!project || !config)
      return {
        eventUuid: event.eventUuid,
        status: 'rejected',
        reason: 'PROJECT_NOT_FOUND',
        review: false,
      };
    if (project.status !== 'ACTIVE')
      return {
        eventUuid: event.eventUuid,
        status: 'rejected',
        reason: 'PROJECT_NOT_ACTIVE',
        review: false,
      };
    const { changed, result } = applyVisitorEvent(
      [...this.visitRows.values()],
      event,
      config,
      project.timezone,
    );
    if (changed) this.visitRows.set(changed.id, changed);
    return result;
  }

  async snapshot(projectId: string) {
    return {
      tracks: [...this.tracks.values()]
        .filter((track) => track.projectId === projectId)
        .map((track) => structuredClone(track)),
      sessions: [...this.sessionRows.values()]
        .filter((session) => session.projectId === projectId)
        .map((session) => structuredClone(session)),
      receipts: [...this.receiptRows.values()].filter((row) => row.project_id === projectId).length,
      events: [...this.eventRows.values()].filter((row) => row.project_id === projectId).length,
      positions: [...this.positions.entries()]
        .filter(([k]) => k.startsWith(`${projectId}|`))
        .map(([, position]) => position),
      visits: [...this.visitRows.values()]
        .filter((visit) => visit.projectId === projectId)
        .map((visit) => ({ ...visit })),
    };
  }

  async close(): Promise<void> {}
}
