import { useQueryClient } from '@tanstack/react-query';
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

import { AccessSchema, type Access } from '../auth/access';
import { createAuthBackend, type AuthBackend } from '../auth/create-gateway';
import type { AuthGateway } from '../auth/gateway';
import { deriveAuthState, type AuthState } from '../auth/routing';
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

  const refresh = useCallback(async () => {
    if (!backend) {
      setState({ status: 'unavailable' });
      return;
    }
    const { gateway, storage } = backend;
    const hasSession = await gateway.hasSession();
    if (!hasSession) {
      setState({ status: 'signed_out' });
      return;
    }
    const assurance = await gateway.assurance();
    let access: Access;
    let stale = false;
    try {
      access = await gateway.fetchAccess();
      await storage.setItem(ACCESS_CACHE_KEY, JSON.stringify(access));
    } catch (error) {
      const cached = await storage.getItem(ACCESS_CACHE_KEY);
      const parsed = cached ? AccessSchema.safeParse(JSON.parse(cached)) : null;
      if (!parsed?.success) {
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
    await backend.gateway.signOut();
    await backend.storage.wipe();
    queryClient.clear();
    savedLocale.current = null;
    setState({ status: 'signed_out' });
  }, [backend, queryClient]);

  const value = useMemo(
    () => ({ state, gateway: backend?.gateway ?? null, refresh, signOut }),
    [state, backend, refresh, signOut],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}
