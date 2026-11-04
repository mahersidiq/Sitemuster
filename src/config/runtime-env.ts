/**
 * Runtime configuration for the mobile app (pure; no React Native imports so Vitest can test it).
 * Production fails closed: a production build without its required public configuration renders
 * a blocking configuration error instead of running on mocks.
 */
export type AppEnv = 'development' | 'staging' | 'production';

export interface RuntimeEnv {
  appEnv: AppEnv;
  supabaseUrl: string | null;
  supabaseAnonKey: string | null;
  sentryDsn: string | null;
}

export interface RuntimeEnvInput {
  appEnv?: unknown;
  supabaseUrl?: string | undefined;
  supabaseAnonKey?: string | undefined;
  sentryDsn?: string | undefined;
}

export type RuntimeEnvResult =
  | { ok: true; env: RuntimeEnv }
  | { ok: false; missing: string[]; reason: 'INVALID_APP_ENV' | 'MISSING_PRODUCTION_CONFIG' };

const APP_ENVS: readonly AppEnv[] = ['development', 'staging', 'production'];

function clean(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function parseRuntimeEnv(input: RuntimeEnvInput): RuntimeEnvResult {
  const appEnv = input.appEnv ?? 'development';
  if (typeof appEnv !== 'string' || !(APP_ENVS as readonly string[]).includes(appEnv)) {
    return { ok: false, missing: ['appEnv'], reason: 'INVALID_APP_ENV' };
  }
  const env: RuntimeEnv = {
    appEnv: appEnv as AppEnv,
    supabaseUrl: clean(input.supabaseUrl),
    supabaseAnonKey: clean(input.supabaseAnonKey),
    sentryDsn: clean(input.sentryDsn),
  };
  if (env.appEnv === 'production' || env.appEnv === 'staging') {
    const missing: string[] = [];
    if (!env.supabaseUrl || !env.supabaseUrl.startsWith('https://')) {
      missing.push('EXPO_PUBLIC_SUPABASE_URL');
    }
    if (!env.supabaseAnonKey) missing.push('EXPO_PUBLIC_SUPABASE_ANON_KEY');
    if (env.appEnv === 'production' && !env.sentryDsn) missing.push('EXPO_PUBLIC_SENTRY_DSN');
    if (missing.length > 0) return { ok: false, missing, reason: 'MISSING_PRODUCTION_CONFIG' };
  }
  return { ok: true, env };
}

/** Development-only conveniences (role preview, simulators) are never enabled outside dev. */
export function isDevelopmentOnlyFeatureEnabled(env: RuntimeEnv): boolean {
  return env.appEnv === 'development';
}
