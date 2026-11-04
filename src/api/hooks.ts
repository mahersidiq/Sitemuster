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
