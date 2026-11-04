import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { errorCode } from '../api/errors';
import type { RuntimeEnv } from '../config/runtime-env';
import { AuthProvider } from './auth';
import { LanguageProvider } from './language';
import { OutboxProvider } from './outbox';
import { SelectedProjectLive, SelectedProjectProvider } from './selected-project';
import { SessionProvider } from './session';
import { TrackingProvider } from './tracking';

export function AppProviders({ env, children }: { env: RuntimeEnv; children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          // The database is the source of truth; never pretend stale data is fresh.
          // Authorization refusals are final: no retries, so revoked data disappears at once.
          queries: {
            retry: (failureCount, error) => !isAuthorizationError(error) && failureCount < 2,
            staleTime: 0,
            refetchOnReconnect: true,
          },
          mutations: { retry: 0 },
        },
      }),
  );
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <LanguageProvider appEnv={env.appEnv}>
          <SessionProvider env={env}>
            <AuthProvider env={env}>
              <OutboxProvider>
                <SelectedProjectProvider>
                  <SelectedProjectLive>
                    <TrackingProvider env={env}>{children}</TrackingProvider>
                  </SelectedProjectLive>
                </SelectedProjectProvider>
              </OutboxProvider>
            </AuthProvider>
          </SessionProvider>
        </LanguageProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}

function isAuthorizationError(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'FORBIDDEN' || code === 'UNAUTHENTICATED';
}
