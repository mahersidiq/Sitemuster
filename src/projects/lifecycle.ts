import type { ProjectStatus } from '@sitemuster/shared';

/** Allowed lifecycle moves (mirrors public.set_project_status; the server decides). */
export const NEXT_STATUSES: Record<ProjectStatus, readonly ProjectStatus[]> = {
  DRAFT: ['ACTIVE', 'ARCHIVED'],
  ACTIVE: ['PAUSED', 'COMPLETED'],
  PAUSED: ['ACTIVE', 'COMPLETED'],
  COMPLETED: ['ARCHIVED'],
  ARCHIVED: [],
};

/** Closing a project (or archiving it) must carry an audit reason. */
export const STATUSES_NEEDING_REASON: readonly ProjectStatus[] = ['COMPLETED', 'ARCHIVED'];

export function isClosed(status: ProjectStatus): boolean {
  return status === 'COMPLETED' || status === 'ARCHIVED';
}
