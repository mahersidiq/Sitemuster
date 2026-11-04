import { advanceTrack, processEvidence } from './engine.ts';
import type { EngineContext, EngineOutput, Evidence, ItemResult, TrackState } from './types.ts';

/**
 * Transactional reconciler (decision #78). The engine is pure; a store loads one (project,
 * worker) track with its context and commits the engine output atomically, refusing the commit
 * when the track changed meanwhile (optimistic revision). Conflicts are retried from a fresh load,
 * so concurrent devices, kiosks and the sweep can never interleave half-applied transitions.
 */
export interface TrackLoad {
  state: TrackState;
  ctx: EngineContext;
}

export interface AttendanceStore {
  load(
    projectId: string,
    workerId: string,
    eventUuids: readonly string[],
    sessionIds: readonly string[],
  ): Promise<TrackLoad>;
  /** Atomic: everything in `output` or nothing. `conflict` = revision changed or uuid race. */
  commit(output: EngineOutput, expectedRevision: number): Promise<'ok' | 'conflict'>;
}

export class AttendanceConflictError extends Error {
  constructor(projectId: string, workerId: string) {
    super(`attendance track ${projectId}/${workerId} kept changing; retry later`);
    this.name = 'AttendanceConflictError';
  }
}

const MAX_ATTEMPTS = 4;

function sessionIdsOf(items: readonly Evidence[]): string[] {
  return items.flatMap((item) =>
    (item.kind === 'MANUAL' || item.kind === 'APPROVE_UNSCHEDULED') && item.sessionId
      ? [item.sessionId]
      : [],
  );
}

/** Applies evidence for any number of (project, worker) tracks; results keyed by event uuid. */
export async function reconcile(
  store: AttendanceStore,
  evidence: readonly Evidence[],
  now: string,
): Promise<Map<string, ItemResult>> {
  const groups = new Map<string, Evidence[]>();
  for (const item of evidence) {
    const key = `${item.projectId}|${item.workerId}`;
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  const results = new Map<string, ItemResult>();
  for (const items of groups.values()) {
    const first = items[0] as Evidence;
    let committed = false;
    for (let attempt = 0; attempt < MAX_ATTEMPTS && !committed; attempt += 1) {
      const { state, ctx } = await store.load(
        first.projectId,
        first.workerId,
        items.map((item) => item.eventUuid),
        sessionIdsOf(items),
      );
      const output = processEvidence(state, items, ctx, now);
      if ((await store.commit(output, state.revision)) === 'ok') {
        for (const result of output.results) results.set(result.eventUuid, result);
        committed = true;
      }
    }
    if (!committed) throw new AttendanceConflictError(first.projectId, first.workerId);
  }
  return results;
}

/** Time rules only (the scheduled sweep) for one track. */
export async function sweepTrack(
  store: AttendanceStore,
  projectId: string,
  workerId: string,
  now: string,
): Promise<void> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const { state, ctx } = await store.load(projectId, workerId, [], []);
    if ((await store.commit(advanceTrack(state, ctx, now), state.revision)) === 'ok') return;
  }
  throw new AttendanceConflictError(projectId, workerId);
}
