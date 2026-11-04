import Constants from 'expo-constants';

import { parseRuntimeEnv, type RuntimeEnvResult } from './runtime-env';

/** Reads build-time values. EXPO_PUBLIC_* are inlined by Metro; appEnv comes from app.config.ts. */
export function readRuntimeEnv(): RuntimeEnvResult {
  const extra = (Constants.expoConfig?.extra ?? {}) as { appEnv?: unknown };
  return parseRuntimeEnv({
    appEnv: extra.appEnv,
    supabaseUrl: process.env.EXPO_PUBLIC_SUPABASE_URL,
    supabaseAnonKey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
    sentryDsn: process.env.EXPO_PUBLIC_SENTRY_DSN,
  });
}
