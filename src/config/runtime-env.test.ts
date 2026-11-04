import { describe, expect, it } from 'vitest';

import { isDevelopmentOnlyFeatureEnabled, parseRuntimeEnv } from './runtime-env';

const complete = {
  supabaseUrl: 'https://abcdefghijklmnop.supabase.co',
  supabaseAnonKey: 'public-anon-key',
  sentryDsn: 'https://public@o0.ingest.sentry.io/0',
};

describe('parseRuntimeEnv', () => {
  it('defaults to development and allows missing provider config there', () => {
    const result = parseRuntimeEnv({});
    expect(result).toEqual({
      ok: true,
      env: { appEnv: 'development', supabaseUrl: null, supabaseAnonKey: null, sentryDsn: null },
    });
  });

  it('fails closed in production without Supabase and Sentry configuration', () => {
    const result = parseRuntimeEnv({ appEnv: 'production' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('MISSING_PRODUCTION_CONFIG');
      expect(result.missing).toEqual([
        'EXPO_PUBLIC_SUPABASE_URL',
        'EXPO_PUBLIC_SUPABASE_ANON_KEY',
        'EXPO_PUBLIC_SENTRY_DSN',
      ]);
    }
  });

  it('rejects a non-https Supabase URL in staging/production', () => {
    const result = parseRuntimeEnv({ appEnv: 'staging', ...complete, supabaseUrl: 'http://x.co' });
    expect(result.ok).toBe(false);
  });

  it('accepts complete production configuration', () => {
    const result = parseRuntimeEnv({ appEnv: 'production', ...complete });
    expect(result.ok).toBe(true);
  });

  it('rejects unknown app environments', () => {
    expect(parseRuntimeEnv({ appEnv: 'prod' })).toEqual({
      ok: false,
      missing: ['appEnv'],
      reason: 'INVALID_APP_ENV',
    });
  });

  it('enables development-only features only in development', () => {
    const dev = parseRuntimeEnv({});
    const prod = parseRuntimeEnv({ appEnv: 'production', ...complete });
    const staging = parseRuntimeEnv({ appEnv: 'staging', ...complete });
    if (!dev.ok || !prod.ok || !staging.ok) throw new Error('fixture invalid');
    expect(isDevelopmentOnlyFeatureEnabled(dev.env)).toBe(true);
    expect(isDevelopmentOnlyFeatureEnabled(staging.env)).toBe(false);
    expect(isDevelopmentOnlyFeatureEnabled(prod.env)).toBe(false);
  });
});
