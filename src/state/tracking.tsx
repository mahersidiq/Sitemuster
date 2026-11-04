import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { AppState } from 'react-native';

import type { SiteMusterApi } from '../api/types';
import { canOpenWorkerShell } from '../auth/routing';
import type { RuntimeEnv } from '../config/runtime-env';
import { createNativeTrackingService } from '../tracking/factory';
import type { TrackingService, TrackingStatus } from '../tracking/service';
import { useAuth } from './auth';

/**
 * Automatic-attendance state for the signed-in worker (Milestone 07). Starts the tracking service
 * for workers only, refreshes it when the app returns to the foreground (renewal ≤ 7 days, plan,
 * already-inside recheck), and stops it — dropping the native queue — when the worker signs out.
 */
interface TrackingContextValue {
  /** null: not a worker session, or no backend configured (production fails closed). */
  status: TrackingStatus | null;
  refresh(): Promise<void>;
  requestPermission(): Promise<void>;
  syncNow(): Promise<void>;
}

const TrackingContext = createContext<TrackingContextValue>({
  status: null,
  refresh: async () => undefined,
  requestPermission: async () => undefined,
  syncNow: async () => undefined,
});

export type TrackingServiceFactory = (api: SiteMusterApi) => TrackingService | null;

export function TrackingProvider({
  env,
  createService,
  children,
}: {
  env: RuntimeEnv;
  createService?: TrackingServiceFactory;
  children: ReactNode;
}) {
  const { state, api } = useAuth();
  const { t } = useTranslation();
  const [status, setStatus] = useState<TrackingStatus | null>(null);
  const serviceRef = useRef<TrackingService | null>(null);
  const userId =
    state.status === 'signed_in' && canOpenWorkerShell(state) ? state.access.user_id : null;
  // The localized Android notification is read when the SDK starts, so a language switch never
  // recreates the service (recreating it must not touch the native queue).
  const tRef = useRef(t);
  const factory = useMemo<TrackingServiceFactory>(
    () =>
      createService ??
      ((backendApi) =>
        env.supabaseUrl
          ? createNativeTrackingService({
              api: backendApi,
              supabaseUrl: env.supabaseUrl,
              notification: () => ({
                title: tRef.current('tracking.notification.title'),
                text: tRef.current('tracking.notification.text'),
                channelName: tRef.current('tracking.notification.channelName'),
              }),
              permissionRationale: () => ({
                title: tRef.current('tracking.rationale.title'),
                message: tRef.current('tracking.rationale.message'),
                positiveAction: tRef.current('tracking.rationale.positive'),
                negativeAction: tRef.current('tracking.rationale.negative'),
              }),
            })
          : null),
    [createService, env.supabaseUrl],
  );
  // Updated in a layout effect — which runs before the passive cleanup below — so that cleanup
  // can tell "signed out / other user" (drop this worker's queue) from a mere re-creation.
  const currentUser = useRef(userId);
  useLayoutEffect(() => {
    tRef.current = t;
    currentUser.current = userId;
  }, [t, userId]);

  useEffect(() => {
    if (!api || !userId) return undefined;
    const service = factory(api);
    if (!service) return undefined;
    serviceRef.current = service;
    const unsubscribe = service.subscribe(setStatus);
    service.start(userId).catch((error: unknown) => {
      console.warn('tracking: start failed', error instanceof Error ? error.message : 'unknown');
    });
    const foreground = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        service.refresh().catch((error: unknown) => {
          console.warn(
            'tracking: refresh failed',
            error instanceof Error ? error.message : 'unknown',
          );
        });
      }
    });
    return () => {
      foreground.remove();
      unsubscribe();
      serviceRef.current = null;
      setStatus(null);
      if (currentUser.current !== userId) {
        // Signed out or another user: stop tracking and drop this worker's queue.
        service.stop().catch((error: unknown) => {
          console.warn('tracking: stop failed', error instanceof Error ? error.message : 'unknown');
        });
      } else {
        // Same worker, new backend client: release listeners only; the SDK keeps running.
        service.release();
      }
    };
  }, [api, userId, factory]);

  const run = useCallback(async (action: (service: TrackingService) => Promise<unknown>) => {
    const service = serviceRef.current;
    if (service) await action(service);
  }, []);

  // Stable identities: screens may refresh on mount without re-running on every status change.
  const refresh = useCallback(() => run((service) => service.refresh()), [run]);
  const requestPermission = useCallback(() => run((service) => service.requestPermission()), [run]);
  const syncNow = useCallback(() => run((service) => service.syncNow()), [run]);
  const value = useMemo<TrackingContextValue>(
    () => ({ status, refresh, requestPermission, syncNow }),
    [status, refresh, requestPermission, syncNow],
  );
  return <TrackingContext.Provider value={value}>{children}</TrackingContext.Provider>;
}

export function useTracking(): TrackingContextValue {
  return useContext(TrackingContext);
}
