import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import type { RuntimeEnv } from '../config/runtime-env';
import { AuthProvider } from './auth';
import { LanguageProvider } from './language';
import { SessionProvider } from './session';

export function AppProviders({ env, children }: { env: RuntimeEnv; children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          // The database is the source of truth; never pretend stale data is fresh.
          queries: { retry: 2, staleTime: 0, refetchOnReconnect: true },
          mutations: { retry: 0 },
        },
      }),
  );
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <LanguageProvider appEnv={env.appEnv}>
          <SessionProvider env={env}>
            <AuthProvider env={env}>{children}</AuthProvider>
          </SessionProvider>
        </LanguageProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}
