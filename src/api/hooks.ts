import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { useApi } from '../state/auth';
import { errorCode } from './errors';

/**
 * When the latest attempt was refused (access revoked or session ended), previously loaded data
 * must not stay on screen under the error (review finding on PR #4). Screens use this for every
 * protected read; signing out also clears the whole cache.
 */
export function hideOnAuthError<T>(query: UseQueryResult<T>): UseQueryResult<T> {
  const code = query.error ? errorCode(query.error) : null;
  if (code === 'FORBIDDEN' || code === 'UNAUTHENTICATED') {
    return { ...query, data: undefined } as UseQueryResult<T>;
  }
  return query;
}

/** Query keys: the database is the source of truth; screens refetch instead of patching caches. */
export const queryKeys = {
  organizations: ['organizations'] as const,
  projects: ['projects'] as const,
  project: (id: string) => ['project', id] as const,
  invitations: ['my-invitations'] as const,
  myEnrollments: ['my-enrollments'] as const,
  roster: (projectId: string) => ['roster', projectId] as const,
  orientationSessions: (projectId: string) => ['orientation-sessions', projectId] as const,
  foremanProjects: ['foreman-projects'] as const,
  crew: (projectId: string, companyId: string) => ['crew', projectId, companyId] as const,
  openVisits: (projectId: string) => ['open-visits', projectId] as const,
  correctable: (projectId: string, workerId: string) =>
    ['correctable', projectId, workerId] as const,
  dashboard: (projectId: string) => ['dashboard', projectId] as const,
  workforce: (projectId: string) => ['workforce', projectId] as const,
  projectMap: (projectId: string) => ['project-map', projectId] as const,
  // Milestone 10
  reportsOf: (projectId: string) => ['reports', projectId] as const,
  reports: (projectId: string, localDate: string) => ['reports', projectId, localDate] as const,
  pendingReports: ['pending-reports'] as const,
  myAttendance: (projectId: string, from: string) => ['my-attendance', projectId, from] as const,
  correctionRequests: (projectId: string) => ['correction-requests', projectId] as const,
  kioskGrants: (projectId: string) => ['kiosk-grants', projectId] as const,
  // Milestone 11 (everything under ['muster', projectId] refetches on MUSTER_CHANGED)
  musterOf: (projectId: string) => ['muster', projectId] as const,
  projectMusters: (projectId: string) => ['muster', projectId, 'list'] as const,
  musterBoard: (projectId: string, musterId: string) =>
    ['muster', projectId, 'board', musterId] as const,
  musterReport: (projectId: string, musterId: string) =>
    ['muster', projectId, 'report', musterId] as const,
  myMusters: ['my-musters'] as const,
  foremanMusters: ['foreman-musters'] as const,
  foremanMuster: (musterId: string) => ['foreman-muster', musterId] as const,
};

export function useOrganizations() {
  const api = useApi();
  return hideOnAuthError(
    useQuery({ queryKey: queryKeys.organizations, queryFn: () => api.listOrganizations() }),
  );
}

export function useProjects() {
  const api = useApi();
  return hideOnAuthError(
    useQuery({ queryKey: queryKeys.projects, queryFn: () => api.listProjects() }),
  );
}

export function useProject(projectId: string) {
  const api = useApi();
  return hideOnAuthError(
    useQuery({
      queryKey: queryKeys.project(projectId),
      queryFn: () => api.getProject(projectId),
    }),
  );
}

export function useMyInvitations() {
  const api = useApi();
  return hideOnAuthError(
    useQuery({ queryKey: queryKeys.invitations, queryFn: () => api.myInvitations() }),
  );
}

export function useMyEnrollments() {
  const api = useApi();
  return hideOnAuthError(
    useQuery({ queryKey: queryKeys.myEnrollments, queryFn: () => api.myEnrollments() }),
  );
}

export function useRoster(projectId: string) {
  const api = useApi();
  return hideOnAuthError(
    useQuery({
      queryKey: queryKeys.roster(projectId),
      queryFn: () => api.listEnrollments(projectId),
    }),
  );
}

// Milestone 08: kiosk, foreman, visitor and correction screens.

export function useForemanProjects() {
  const api = useApi();
  return hideOnAuthError(
    useQuery({ queryKey: queryKeys.foremanProjects, queryFn: () => api.myForemanProjects() }),
  );
}

export function useCrew(projectId: string, companyId: string) {
  const api = useApi();
  return hideOnAuthError(
    useQuery({
      queryKey: queryKeys.crew(projectId, companyId),
      queryFn: () => api.foremanCrew(projectId, companyId),
    }),
  );
}

export function useOpenVisits(projectId: string) {
  const api = useApi();
  return hideOnAuthError(
    useQuery({
      queryKey: queryKeys.openVisits(projectId),
      queryFn: () => api.openVisitorVisits(projectId),
    }),
  );
}

export function useCorrectableSessions(projectId: string, workerId: string) {
  const api = useApi();
  return hideOnAuthError(
    useQuery({
      queryKey: queryKeys.correctable(projectId, workerId),
      queryFn: () => api.workerAttendanceSessions(projectId, workerId),
    }),
  );
}

// Milestone 09: dashboard, roster and map. The live channel invalidates these (src/realtime);
// while it is paused they refetch every minute (dashboard data, never the phone's location).

export function useProjectDashboard(projectId: string | null) {
  const api = useApi();
  return hideOnAuthError(
    useQuery({
      queryKey: queryKeys.dashboard(projectId ?? ''),
      queryFn: () => api.projectDashboard(projectId ?? ''),
      enabled: Boolean(projectId),
    }),
  );
}

export function useWorkforceRoster(projectId: string | null) {
  const api = useApi();
  return hideOnAuthError(
    useQuery({
      queryKey: queryKeys.workforce(projectId ?? ''),
      queryFn: () => api.workforceRoster(projectId ?? ''),
      enabled: Boolean(projectId),
    }),
  );
}

export function useProjectMap(projectId: string | null, enabled: boolean) {
  const api = useApi();
  return hideOnAuthError(
    useQuery({
      queryKey: queryKeys.projectMap(projectId ?? ''),
      queryFn: () => api.projectMap(projectId ?? ''),
      enabled: Boolean(projectId) && enabled,
    }),
  );
}

// Milestone 10: daily company reports, the foreman's answers, own hours and correction requests.

export function useReports(projectId: string, localDate: string | null) {
  const api = useApi();
  return hideOnAuthError(
    useQuery({
      queryKey: queryKeys.reports(projectId, localDate ?? ''),
      queryFn: () => api.listReports(projectId, localDate ?? ''),
      enabled: Boolean(localDate),
    }),
  );
}

export function usePendingReports(enabled = true) {
  const api = useApi();
  return hideOnAuthError(
    useQuery({
      queryKey: queryKeys.pendingReports,
      queryFn: () => api.pendingReports(),
      enabled,
    }),
  );
}

export function useMyAttendance(projectId: string | null, from: string, to: string) {
  const api = useApi();
  return hideOnAuthError(
    useQuery({
      queryKey: queryKeys.myAttendance(projectId ?? '', from),
      queryFn: () => api.myAttendance(projectId ?? '', from, to),
      enabled: Boolean(projectId),
    }),
  );
}

export function useCorrectionRequests(projectId: string) {
  const api = useApi();
  return hideOnAuthError(
    useQuery({
      queryKey: queryKeys.correctionRequests(projectId),
      queryFn: () => api.correctionRequests(projectId),
    }),
  );
}

export function useKioskGrants(projectId: string) {
  const api = useApi();
  return hideOnAuthError(
    useQuery({
      queryKey: queryKeys.kioskGrants(projectId),
      queryFn: () => api.foremanKioskGrants(projectId),
    }),
  );
}

// Milestone 11: Active Muster Mode. Time-critical reads refetch often while a screen is open;
// the private project channel also invalidates staff reads. Never location polling.

/** How often an open muster screen refreshes (seconds matter in an emergency). */
export const MUSTER_REFRESH_MS = 10_000;

export function useProjectMusters(projectId: string) {
  const api = useApi();
  return hideOnAuthError(
    useQuery({
      queryKey: queryKeys.projectMusters(projectId),
      queryFn: () => api.projectMusters(projectId),
      refetchInterval: MUSTER_REFRESH_MS,
    }),
  );
}

export function useMusterBoard(projectId: string, musterId: string | null) {
  const api = useApi();
  return hideOnAuthError(
    useQuery({
      queryKey: queryKeys.musterBoard(projectId, musterId ?? ''),
      queryFn: () => api.musterBoard(musterId ?? ''),
      enabled: Boolean(musterId),
      refetchInterval: MUSTER_REFRESH_MS,
    }),
  );
}

export function useMusterReport(projectId: string, musterId: string) {
  const api = useApi();
  return hideOnAuthError(
    useQuery({
      queryKey: queryKeys.musterReport(projectId, musterId),
      queryFn: () => api.musterReport(musterId),
    }),
  );
}

export function useMyMusters(enabled = true) {
  const api = useApi();
  return hideOnAuthError(
    useQuery({
      queryKey: queryKeys.myMusters,
      queryFn: () => api.myActiveMusters(),
      enabled,
      refetchInterval: 20_000,
    }),
  );
}

export function useForemanMusters() {
  const api = useApi();
  return hideOnAuthError(
    useQuery({
      queryKey: queryKeys.foremanMusters,
      queryFn: () => api.foremanActiveMusters(),
      refetchInterval: 20_000,
    }),
  );
}

export function useForemanMuster(musterId: string) {
  const api = useApi();
  return hideOnAuthError(
    useQuery({
      queryKey: queryKeys.foremanMuster(musterId),
      queryFn: () => api.foremanMuster(musterId),
      refetchInterval: MUSTER_REFRESH_MS,
    }),
  );
}
