import { afterEach, describe, expect, it } from 'vitest';

import expoConfig, {
  assertPublicEnvSafe,
  BUNDLE_IDS,
  PRODUCTION_REQUIRED_PUBLIC_ENV,
  readAppEnv,
} from '../../app.config';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

const evaluate = () =>
  expoConfig({
    config: {},
    projectRoot: process.cwd(),
    staticConfigPath: null,
    packageJsonPath: null,
  });

describe('app.config.ts security gates', () => {
  it('defaults to the development bundle id', () => {
    delete process.env.APP_ENV;
    const config = evaluate();
    expect(config.ios?.bundleIdentifier).toBe('com.sitemuster.app.dev');
    expect(config.android?.package).toBe('com.sitemuster.app.dev');
    expect(config.extra).toMatchObject({ appEnv: 'development' });
  });

  it('keeps staging on the development identifier and production on the reserved id', () => {
    expect(BUNDLE_IDS.staging).toBe('com.sitemuster.app.dev');
    expect(BUNDLE_IDS.production).toBe('com.sitemuster.app');
  });

  it('fails closed for a production build missing required public configuration', () => {
    process.env.APP_ENV = 'production';
    for (const name of PRODUCTION_REQUIRED_PUBLIC_ENV) delete process.env[name];
    expect(() => evaluate()).toThrow(/fail closed/);
  });

  it('builds production only with complete https configuration', () => {
    process.env.APP_ENV = 'production';
    process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'public-anon-key';
    process.env.EXPO_PUBLIC_SENTRY_DSN = 'https://public@o0.ingest.sentry.io/0';
    const config = evaluate();
    expect(config.ios?.bundleIdentifier).toBe('com.sitemuster.app');
    expect(config.name).toBe('SiteMuster');

    process.env.EXPO_PUBLIC_SUPABASE_URL = 'http://example.supabase.co';
    expect(() => evaluate()).toThrow(/https/);
  });

  it.each([
    'EXPO_PUBLIC_SUPABASE_SERVICE_ROLE_KEY',
    'EXPO_PUBLIC_TWILIO_AUTH_TOKEN',
    'EXPO_PUBLIC_GOOGLE_PLACES_SERVER_KEY',
    'EXPO_PUBLIC_SENTRY_AUTH_TOKEN',
    'EXPO_PUBLIC_BADGE_SECRET_ENCRYPTION_KEY',
    'EXPO_PUBLIC_DEVICE_CREDENTIAL_PEPPER',
  ])('refuses to build when %s would be compiled into the app bundle', (name) => {
    expect(() => assertPublicEnvSafe('development', { [name]: 'x' })).toThrow(/Refusing to build/);
  });

  it('rejects unknown APP_ENV values instead of guessing', () => {
    expect(() => readAppEnv({ APP_ENV: 'prod' })).toThrow();
  });
});
