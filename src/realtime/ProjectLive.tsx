import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';

import { queryKeys } from '../api/hooks';
import { useAuth } from '../state/auth';
import { ProjectLiveSync, type LiveState, type RefreshScope } from './live-sync';

/**
 * Live updates for the selected project's staff tabs (decision #106). One private channel per
 * project; messages invalidate the TanStack queries that read authorized rows. While the channel
 * is not live, screens refetch every minute and on returning to the app — refetching dashboard
 * data is not location polling (the phone's own location is never requested here).
 */
export const FALLBACK_REFRESH_MS = 60_000;

const LiveContext = createContext<LiveState>('CONNECTING');

export function ProjectLiveProvider({
  projectId,
  children,
}: {
  projectId: string | null;
  children: ReactNode;
}) {
  const { api } = useAuth();
  const queryClient = useQueryClient();
  // Keyed by project: switching projects starts at CONNECTING without resetting state in an effect.
  const [live, setLive] = useState<{ projectId: string | null; state: LiveState }>({
    projectId: null,
    state: 'CONNECTING',
  });

  useEffect(() => {
    if (!api || !projectId) return undefined;
    const sync = new ProjectLiveSync(projectId, {
      subscribe: (id, listener) => api.subscribeProject(id, listener),
      refresh: (scopes) => {
        for (const queryKey of queryKeysFor(projectId, scopes)) {
          void queryClient.invalidateQueries({ queryKey });
        }
      },
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    });
    const off = sync.onState((state) => setLive({ projectId, state }));
    sync.start();
    const foreground = AppState.addEventListener('change', (next) => {
      if (next === 'active') sync.resync();
    });
    const timer = setInterval(() => {
      const waiting = sync.status === 'PAUSED' || sync.status === 'CONNECTING';
      if (waiting && AppState.currentState === 'active') sync.resync();
    }, FALLBACK_REFRESH_MS);
    return () => {
      clearInterval(timer);
      foreground?.remove();
      off();
      sync.stop();
    };
  }, [api, projectId, queryClient]);

  const state = live.projectId === projectId && projectId ? live.state : 'CONNECTING';
  return <LiveContext.Provider value={state}>{children}</LiveContext.Provider>;
}

export function useLiveState(): LiveState {
  return useContext(LiveContext);
}

/** Which screens' reads a message (or a full resync) makes stale. */
export function queryKeysFor(projectId: string, scopes: ReadonlySet<RefreshScope>): QueryKey[] {
  const keys = new Map<string, QueryKey>();
  const add = (key: QueryKey) => keys.set(JSON.stringify(key), key);
  const any = (...wanted: RefreshScope[]) =>
    scopes.has('ALL') || wanted.some((scope) => scopes.has(scope));
  if (scopes.size > 0) add(queryKeys.dashboard(projectId));
  if (any('WORKFORCE_CHANGED', 'ENROLLMENT_CHANGED')) add(queryKeys.workforce(projectId));
  if (any('WORKFORCE_CHANGED', 'PROJECT_CONFIG_CHANGED')) add(queryKeys.projectMap(projectId));
  if (any('WORKFORCE_CHANGED')) add(queryKeys.openVisits(projectId));
  if (any('ENROLLMENT_CHANGED')) add(queryKeys.roster(projectId));
  if (any('PROJECT_CONFIG_CHANGED')) {
    add(queryKeys.project(projectId));
    add(queryKeys.projects);
  }
  return [...keys.values()];
}
