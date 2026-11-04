import * as SecureStore from 'expo-secure-store';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { useAuth } from './auth';

/**
 * The project the staff tabs show (docs/spec/01 "Home (selected project)"; decision #107). It is
 * remembered per person on this phone (a project id only) and forgotten at sign-out; screens drop
 * it when the person can no longer open that project.
 */
const KEY = 'sitemuster.selected-project.v1';
const OPTIONS = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK };

interface SelectedProjectValue {
  projectId: string | null;
  /** True once the remembered choice (if any) has been read. */
  ready: boolean;
  select(projectId: string | null): void;
}

const SelectedProjectContext = createContext<SelectedProjectValue>({
  projectId: null,
  ready: true,
  select: () => undefined,
});

const warn = (step: string) => (error: unknown) =>
  console.warn(`selected project: ${step}`, error instanceof Error ? error.message : 'unknown');

export function SelectedProjectProvider({ children }: { children: ReactNode }) {
  const { state } = useAuth();
  const userId = state.status === 'signed_in' ? state.access.user_id : null;
  // Keyed by person: another (or no) signed-in person never sees this choice.
  const [choice, setChoice] = useState<{ userId: string | null; projectId: string | null }>({
    userId: null,
    projectId: null,
  });
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const previousUser = useRef<string | null>(null);

  useEffect(() => {
    const before = previousUser.current;
    previousUser.current = userId;
    if (!userId) {
      // Signed out (or switched person): the remembered choice leaves the phone too.
      if (before) {
        void SecureStore.deleteItemAsync(KEY, OPTIONS)
          .catch(warn('forget failed'))
          .finally(() => setChoice({ userId: null, projectId: null }));
      }
      return undefined;
    }
    let cancelled = false;
    SecureStore.getItemAsync(KEY, OPTIONS)
      .then((raw) => {
        if (cancelled || !raw) return;
        const stored = JSON.parse(raw) as { userId?: unknown; projectId?: unknown };
        if (stored.userId === userId && typeof stored.projectId === 'string') {
          setChoice({ userId, projectId: stored.projectId });
        }
      })
      .catch(warn('read failed'))
      .finally(() => {
        if (!cancelled) setLoadedFor(userId);
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const projectId = choice.userId === userId ? choice.projectId : null;
  const ready = !userId || loadedFor === userId;

  const select = useCallback(
    (next: string | null) => {
      setChoice({ userId, projectId: next });
      if (!userId) return;
      const write = next
        ? SecureStore.setItemAsync(KEY, JSON.stringify({ userId, projectId: next }), OPTIONS)
        : SecureStore.deleteItemAsync(KEY, OPTIONS);
      void write.catch(warn('save failed'));
    },
    [userId],
  );

  const value = useMemo(() => ({ projectId, ready, select }), [projectId, ready, select]);
  return (
    <SelectedProjectContext.Provider value={value}>{children}</SelectedProjectContext.Provider>
  );
}

export function useSelectedProject(): SelectedProjectValue {
  return useContext(SelectedProjectContext);
}
