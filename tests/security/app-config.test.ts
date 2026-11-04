import { afterEach, describe, expect, it } from 'vitest';

import expoConfig, {
  assertPublicEnvSafe,
  BUNDLE_IDS,
  PRODUCTION_REQUIRED_BUILD_ENV,
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
    process.env.GOOGLE_MAPS_ANDROID_API_KEY = 'android-restricted-maps-key';
    process.env.TRANSISTORSOFT_LICENSE_ANDROID = 'transistorsoft-release-license';
    const config = evaluate();
    expect(config.ios?.bundleIdentifier).toBe('com.sitemuster.app');
    expect(config.name).toBe('SiteMuster');
    expect(config.plugins).toContainEqual([
      'react-native-maps',
      { androidGoogleMapsApiKey: 'android-restricted-maps-key' },
    ]);

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

  it('fails closed for a production build without the Android Maps key', () => {
    expect(PRODUCTION_REQUIRED_BUILD_ENV).toContain('GOOGLE_MAPS_ANDROID_API_KEY');
    expect(() =>
      assertPublicEnvSafe('production', {
        EXPO_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
        EXPO_PUBLIC_SUPABASE_ANON_KEY: 'public-anon-key',
        EXPO_PUBLIC_SENTRY_DSN: 'https://public@o0.ingest.sentry.io/0',
      }),
    ).toThrow(/GOOGLE_MAPS_ANDROID_API_KEY/);
  });

  it('never configures a Google key for iOS (Apple Maps) and omits the Android key in development', () => {
    delete process.env.APP_ENV;
    delete process.env.GOOGLE_MAPS_ANDROID_API_KEY;
    const config = evaluate();
    expect(config.plugins).toContainEqual(['react-native-maps', {}]);
    expect(JSON.stringify(config)).not.toMatch(/iosGoogleMapsApiKey|GMSApiKey/);
  });

  it('refuses to reuse a Google server key as the Android Maps client key', () => {
    expect(() =>
      assertPublicEnvSafe('development', {
        GOOGLE_PLACES_SERVER_KEY: 'same-key',
        GOOGLE_MAPS_ANDROID_API_KEY: 'same-key',
      }),
    ).toThrow(/separate app-restricted key/);
  });

  it('fails closed for a production build without the Transistorsoft Android license', () => {
    process.env.APP_ENV = 'production';
    process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'public-anon-key';
    process.env.EXPO_PUBLIC_SENTRY_DSN = 'https://public@o0.ingest.sentry.io/0';
    process.env.GOOGLE_MAPS_ANDROID_API_KEY = 'android-restricted-maps-key';
    delete process.env.TRANSISTORSOFT_LICENSE_ANDROID;
    expect(() => evaluate()).toThrow(/TRANSISTORSOFT_LICENSE_ANDROID/);
  });

  it('configures native background tracking: plugin, iOS background modes and texts, Android permissions', () => {
    delete process.env.APP_ENV;
    delete process.env.TRANSISTORSOFT_LICENSE_ANDROID;
    const config = evaluate();
    expect(config.plugins).toContainEqual(['react-native-background-geolocation', {}]);
    expect(config.ios?.infoPlist).toMatchObject({
      UIBackgroundModes: ['location', 'fetch', 'processing'],
      NSLocationAlwaysAndWhenInUseUsageDescription: expect.stringContaining('Always'),
      NSLocationWhenInUseUsageDescription: expect.any(String),
      NSMotionUsageDescription: expect.any(String),
    });
    expect(config.android?.permissions).toEqual(
      expect.arrayContaining([
        'ACCESS_BACKGROUND_LOCATION',
        'FOREGROUND_SERVICE_LOCATION',
        'POST_NOTIFICATIONS',
        'RECEIVE_BOOT_COMPLETED',
      ]),
    );
    expect(
      Object.keys(process.env).filter((n) => n.startsWith('EXPO_PUBLIC_TRANSISTORSOFT')),
    ).toEqual([]);
  });

  it('rejects unknown APP_ENV values instead of guessing', () => {
    expect(() => readAppEnv({ APP_ENV: 'prod' })).toThrow();
  });
});
