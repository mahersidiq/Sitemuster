import { useQuery } from '@tanstack/react-query';

import { useApi } from '../state/auth';

/** Query keys: the database is the source of truth; screens refetch instead of patching caches. */
export const queryKeys = {
  organizations: ['organizations'] as const,
  projects: ['projects'] as const,
  project: (id: string) => ['project', id] as const,
  invitations: ['my-invitations'] as const,
  myEnrollments: ['my-enrollments'] as const,
  roster: (projectId: string) => ['roster', projectId] as const,
  orientationSessions: (projectId: string) => ['orientation-sessions', projectId] as const,
};

export function useOrganizations() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.organizations, queryFn: () => api.listOrganizations() });
}

export function useProjects() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.projects, queryFn: () => api.listProjects() });
}

export function useProject(projectId: string) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.project(projectId),
    queryFn: () => api.getProject(projectId),
  });
}

export function useMyInvitations() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.invitations, queryFn: () => api.myInvitations() });
}

export function useMyEnrollments() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.myEnrollments, queryFn: () => api.myEnrollments() });
}

export function useRoster(projectId: string) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.roster(projectId),
    queryFn: () => api.listEnrollments(projectId),
  });
}
