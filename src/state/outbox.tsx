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
import { AppState } from 'react-native';

import type { SiteMusterApi } from '../api/types';
import { createNativeOutbox } from '../outbox/native-outbox';
import type {
  OperationalOutbox,
  OperationDraft,
  OutboxEntry,
  OutboxLabel,
  OutboxStatusSummary,
} from '../outbox/outbox';
import { useAuth } from './auth';

/**
 * The signed-in person's operational outbox (Milestone 08). Every recorded kiosk scan, crew
 * sign-in/out, correction or visitor goes into it first and is sent from there: right away,
 * when the app returns to the foreground, every minute while something waits, and on "Sync now".
 * Retrying an outbox upload is not location polling (CLAUDE.md bans only that).
 */
const RETRY_INTERVAL_MS = 60_000;

interface OutboxContextValue {
  /** null: signed out or no backend configured (production fails closed). */
  status: OutboxStatusSummary | null;
  entries: OutboxEntry[];
  enqueue(draft: OperationDraft, label: OutboxLabel): Promise<OutboxEntry>;
  syncNow(): Promise<void>;
  /** Only after the person explicitly chose to discard unsent operations (sign-out). */
  discardAll(): Promise<void>;
}

const OutboxContext = createContext<OutboxContextValue>({
  status: null,
  entries: [],
  enqueue: async () => {
    throw new Error('OUTBOX_UNAVAILABLE');
  },
  syncNow: async () => undefined,
  discardAll: async () => undefined,
});

export type OutboxFactory = (api: SiteMusterApi, userId: string) => OperationalOutbox;

export function OutboxProvider({
  createOutbox = createNativeOutbox,
  children,
}: {
  createOutbox?: OutboxFactory;
  children: ReactNode;
}) {
  const { state, api } = useAuth();
  const userId = state.status === 'signed_in' ? state.access.user_id : null;
  const [status, setStatus] = useState<OutboxStatusSummary | null>(null);
  const [entries, setEntries] = useState<OutboxEntry[]>([]);
  const outboxRef = useRef<OperationalOutbox | null>(null);

  const reload = useCallback(async () => {
    const outbox = outboxRef.current;
    if (outbox) setEntries(await outbox.entries());
  }, []);

  const flush = useCallback(async () => {
    const outbox = outboxRef.current;
    if (!outbox) return;
    await outbox.flush();
    await reload();
  }, [reload]);

  useEffect(() => {
    if (!api || !userId) return undefined;
    const outbox = createOutbox(api, userId);
    outboxRef.current = outbox;
    const unsubscribe = outbox.subscribe(setStatus);
    const report = (error: unknown) =>
      console.warn('outbox: sync failed', error instanceof Error ? error.message : 'unknown');
    void outbox
      .refresh()
      .then(reload)
      .then(() => (outbox.status.pending > 0 ? flush() : undefined))
      .catch(report);
    const foreground = AppState.addEventListener('change', (next) => {
      if (next === 'active') flush().catch(report);
    });
    const timer = setInterval(() => {
      if (AppState.currentState === 'active' && outbox.status.pending > 0) flush().catch(report);
    }, RETRY_INTERVAL_MS);
    return () => {
      clearInterval(timer);
      foreground?.remove();
      unsubscribe();
      outboxRef.current = null;
      setStatus(null);
      setEntries([]);
    };
  }, [api, userId, createOutbox, flush, reload]);

  const enqueue = useCallback(
    async (draft: OperationDraft, label: OutboxLabel) => {
      const outbox = outboxRef.current;
      if (!outbox) throw new Error('OUTBOX_UNAVAILABLE');
      const entry = await outbox.enqueue(draft, label);
      await reload();
      // Send right away when possible; a failure keeps it queued for the next attempt.
      flush().catch((error: unknown) =>
        console.warn('outbox: sync failed', error instanceof Error ? error.message : 'unknown'),
      );
      return entry;
    },
    [flush, reload],
  );

  const discardAll = useCallback(async () => {
    const outbox = outboxRef.current;
    if (!outbox) return;
    await outbox.discardAll();
    await reload();
  }, [reload]);

  const value = useMemo<OutboxContextValue>(
    () => ({ status, entries, enqueue, syncNow: flush, discardAll }),
    [status, entries, enqueue, flush, discardAll],
  );
  return <OutboxContext.Provider value={value}>{children}</OutboxContext.Provider>;
}

export function useOutbox(): OutboxContextValue {
  return useContext(OutboxContext);
}
