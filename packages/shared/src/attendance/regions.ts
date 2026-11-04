/**
 * Native region budget (docs/spec/03 "Recovery and geofence scheduling"): iOS allows 20 monitored
 * regions (we target 15), Android ~100 (we target 75). When a worker is enrolled in more projects
 * than the budget, monitor first the project with an open session, then the nearest ones, then
 * those with the soonest upcoming shift; every other project is shown as "not monitoring".
 */
export interface RegionCandidate {
  projectId: string;
  /** Distance from the last known position, when one is known. */
  distanceM: number | null;
  activeSession: boolean;
  /** Milliseconds until the next authorized shift starts (0 = in progress). */
  nextShiftInMs: number | null;
}

export function selectNativeRegions(
  candidates: readonly RegionCandidate[],
  budget: number,
): { monitored: string[]; unmonitored: string[] } {
  const rank = (value: number | null) => (value === null ? Number.POSITIVE_INFINITY : value);
  const ordered = [...candidates].sort(
    (a, b) =>
      Number(b.activeSession) - Number(a.activeSession) ||
      rank(a.distanceM) - rank(b.distanceM) ||
      rank(a.nextShiftInMs) - rank(b.nextShiftInMs) ||
      a.projectId.localeCompare(b.projectId),
  );
  const limit = Math.max(0, Math.floor(budget));
  return {
    monitored: ordered.slice(0, limit).map((candidate) => candidate.projectId),
    unmonitored: ordered.slice(limit).map((candidate) => candidate.projectId),
  };
}
