import { useQueryClient } from '@tanstack/react-query';
import { AppState } from 'react-native';
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

import type { SiteMusterApi } from '../api/types';
import { AccessSchema, type Access } from '../auth/access';
import { createAuthBackend, type AuthBackend } from '../auth/create-gateway';
import type { AuthGateway } from '../auth/gateway';
import { deriveAuthState, type AuthState } from '../auth/routing';
import { installationHash, wipeDeviceCredentials } from '../device/device-store';
import type { RuntimeEnv } from '../config/runtime-env';
import { useLanguage } from './language';

/**
 * Authentication state for routing. The server stays the authority for every data access; this
 * context only decides which screen to show. The last confirmed access summary is kept in the
 * encrypted session store so a signed-in worker can keep using offline features (badge, sync
 * status) without signal — it is labelled stale and refreshed as soon as the network returns.
 */
const ACCESS_CACHE_KEY = 'sitemuster-access-cache';

interface AuthContextValue {
  state: AuthState;
  gateway: AuthGateway | null;
  api: SiteMusterApi | null;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ env, children }: { env: RuntimeEnv; children: ReactNode }) {
  const backend = useMemo<AuthBackend | null>(() => createAuthBackend(env), [env]);
  const [state, setState] = useState<AuthState>(
    backend ? { status: 'loading' } : { status: 'unavailable' },
  );
  const queryClient = useQueryClient();
  const { activeLocale } = useLanguage();
  const savedLocale = useRef<string | null>(null);
  // Bumped on sign-out: a refresh that started before it must not write storage or state after it.
  const generation = useRef(0);
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const refresh = useCallback(async () => {
    if (!backend) {
      setState({ status: 'unavailable' });
      return;
    }
    const started = generation.current;
    const superseded = () => started !== generation.current;
    const { gateway, storage } = backend;
    const hasSession = await gateway.hasSession();
    if (superseded()) return;
    if (!hasSession) {
      // A cached summary must never be reused for whoever signs in next on this phone.
      await storage.removeItem(ACCESS_CACHE_KEY);
      if (superseded()) return;
      setState({ status: 'signed_out' });
      return;
    }
    const sessionUserId = await gateway.sessionUserId();
    const assurance = await gateway.assurance();
    if (superseded()) return;
    let access: Access;
    let stale = false;
    try {
      access = await gateway.fetchAccess();
      if (superseded()) return;
      await storage.setItem(ACCESS_CACHE_KEY, JSON.stringify(access));
    } catch (error) {
      if (superseded()) return;
      const cached = await storage.getItem(ACCESS_CACHE_KEY);
      let parsed: ReturnType<typeof AccessSchema.safeParse> | null = null;
      try {
        parsed = cached ? AccessSchema.safeParse(JSON.parse(cached)) : null;
      } catch {
        parsed = null;
      }
      // Only this signed-in user's own summary may be used offline (review finding on PR #3).
      if (!parsed?.success || parsed.data.user_id !== sessionUserId) {
        console.warn(
          'auth: access lookup failed and no cached access is available',
          error instanceof Error ? error.message : 'unknown',
        );
        setState({ status: 'offline' });
        return;
      }
      access = parsed.data;
      stale = true;
    }
    const factorIds = stale ? [] : await gateway.verifiedTotpFactorIds();
    if (superseded()) return;
    const next = deriveAuthState({
      hasSession,
      access,
      assurance,
      verifiedTotpFactorIds: factorIds,
    });
    setState(next.status === 'signed_in' ? { ...next, accessIsStale: stale } : next);
  }, [backend]);

  useEffect(() => {
    if (!backend) return undefined;
    // Restore the persisted session asynchronously, then follow server auth events.
    void Promise.resolve().then(refresh);
    return backend.gateway.onChange(() => {
      void refresh();
    });
  }, [backend, refresh]);

  // Coming back to the foreground retries an offline or stale access check (review finding on
  // PR #3): connectivity usually returns while the app is in the background.
  useEffect(() => {
    if (!backend) return undefined;
    const subscription = AppState.addEventListener('change', (next) => {
      if (next !== 'active') return;
      const current = stateRef.current;
      if (
        current.status === 'offline' ||
        (current.status === 'signed_in' && current.accessIsStale)
      ) {
        void refresh();
      }
    });
    // Jest's React Native preset returns no subscription; real devices always do.
    return () => subscription?.remove();
  }, [backend, refresh]);

  // Persist the chosen UI language to the server profile once signed in (and on every change).
  useEffect(() => {
    if (!backend || state.status !== 'signed_in' || state.accessIsStale) return;
    if (savedLocale.current === activeLocale) return;
    savedLocale.current = activeLocale;
    backend.gateway.saveLanguage(activeLocale).catch((error: unknown) => {
      savedLocale.current = null;
      console.warn(
        'auth: language not saved to profile yet',
        error instanceof Error ? error.message : 'unknown',
      );
    });
  }, [backend, state, activeLocale]);

  const signOut = useCallback(async () => {
    if (!backend) return;
    generation.current += 1;
    // Revoke this worker's phone server-side while the session is still valid (docs/spec/03:
    // revoke on logout). Offline sign-out still wipes everything on the phone; the server-side
    // secret then ends at its expiry or at the next activation.
    await backend.api?.revokeMyDevice().catch((error: unknown) => {
      console.warn(
        'auth: phone not revoked on the server yet',
        error instanceof Error ? error.message : 'unknown',
      );
    });
    // Muster alerts belong to the person, not the phone: stop them for this person here.
    if (backend.api) {
      const api = backend.api;
      await installationHash()
        .then((installationId) => api.revokeMyPushTokens(installationId))
        .catch((error: unknown) => {
          console.warn(
            'auth: muster alerts not stopped on the server yet',
            error instanceof Error ? error.message : 'unknown',
          );
        });
    }
    await backend.gateway.signOut();
    await backend.storage.wipe();
    // The badge secret and upload token belong to this worker only (decision #74).
    await wipeDeviceCredentials();
    queryClient.clear();
    savedLocale.current = null;
    setState({ status: 'signed_out' });
  }, [backend, queryClient]);

  const value = useMemo(
    () => ({
      state,
      gateway: backend?.gateway ?? null,
      api: backend?.api ?? null,
      refresh,
      signOut,
    }),
    [state, backend, refresh, signOut],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}

/** The typed data API (throws when used without a configured backend — callers sit behind guards). */
export function useApi(): SiteMusterApi {
  const { api } = useAuth();
  if (!api) throw new Error('SiteMuster API unavailable (no backend configured)');
  return api;
}
