import { afterEach, describe, expect, it } from 'vitest';

import expoConfig, {
  ANDROID_BLOCKED_PERMISSIONS,
  assertPublicEnvSafe,
  BUNDLE_IDS,
  IOS_PRIVACY_MANIFEST,
  NATIVE_SDK_PINS,
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
    process.env.EAS_BUILD = 'true';
    for (const name of PRODUCTION_REQUIRED_PUBLIC_ENV) delete process.env[name];
    expect(() => evaluate()).toThrow(/fail closed/);
  });

  it('builds production only with complete https configuration', () => {
    process.env.APP_ENV = 'production';
    process.env.EAS_BUILD = 'true';
    process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'public-anon-key';
    process.env.EXPO_PUBLIC_SENTRY_DSN = 'https://public@o0.ingest.sentry.io/0';
    process.env.GOOGLE_MAPS_ANDROID_API_KEY = 'android-restricted-maps-key';
    process.env.TS_ANDROID_LICENSE_KEY = 'transistorsoft-release-license';
    process.env.SITEMUSTER_CLEARED_APP_ID = 'com.sitemuster.app';
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
        EAS_BUILD: 'true',
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
    process.env.EAS_BUILD = 'true';
    process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'public-anon-key';
    process.env.EXPO_PUBLIC_SENTRY_DSN = 'https://public@o0.ingest.sentry.io/0';
    process.env.GOOGLE_MAPS_ANDROID_API_KEY = 'android-restricted-maps-key';
    delete process.env.TS_ANDROID_LICENSE_KEY;
    expect(() => evaluate()).toThrow(/TS_ANDROID_LICENSE_KEY/);
  });

  it('configures native background tracking: plugin, iOS background modes and texts, Android permissions', () => {
    delete process.env.APP_ENV;
    delete process.env.TS_ANDROID_LICENSE_KEY;
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
    expect(Object.keys(process.env).filter((n) => n.startsWith('EXPO_PUBLIC_TS_'))).toEqual([]);
  });

  it('rejects unknown APP_ENV values instead of guessing', () => {
    expect(() => readAppEnv({ APP_ENV: 'prod' })).toThrow();
  });
});

describe('release configuration (Milestone 13)', () => {
  const production = {
    EAS_BUILD: 'true',
    EXPO_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
    EXPO_PUBLIC_SUPABASE_ANON_KEY: 'public-anon-key',
    EXPO_PUBLIC_SENTRY_DSN: 'https://public@o0.ingest.sentry.io/0',
    GOOGLE_MAPS_ANDROID_API_KEY: 'android-restricted-maps-key',
    TS_ANDROID_LICENSE_KEY: 'transistorsoft-release-license',
  };

  it('refuses a production build until the cleared app id is recorded (brand clearance)', () => {
    expect(PRODUCTION_REQUIRED_BUILD_ENV).toContain('SITEMUSTER_CLEARED_APP_ID');
    expect(() => assertPublicEnvSafe('production', production)).toThrow(
      /SITEMUSTER_CLEARED_APP_ID/,
    );
    expect(() =>
      assertPublicEnvSafe('production', {
        ...production,
        SITEMUSTER_CLEARED_APP_ID: 'com.sitemuster.app.dev',
      }),
    ).toThrow(/cleared production id com\.sitemuster\.app/);
    expect(() =>
      assertPublicEnvSafe('production', {
        ...production,
        SITEMUSTER_CLEARED_APP_ID: 'com.sitemuster.app',
      }),
    ).not.toThrow();
    // Development and staging builds keep working before clearance.
    expect(() => assertPublicEnvSafe('staging', {})).not.toThrow();
  });

  it('lets the EAS CLI read the project before upload, but still refuses leaked secrets there', () => {
    // EAS CLI evaluates the config locally with only the profile env (no EAS_BUILD): no throw,
    // so the build can start; the EAS build server then enforces every gate.
    expect(() => assertPublicEnvSafe('production', { APP_ENV: 'production' })).not.toThrow();
    expect(() =>
      assertPublicEnvSafe('production', { EXPO_PUBLIC_SUPABASE_SERVICE_ROLE_KEY: 'x' }),
    ).toThrow(/Refusing to build/);
    expect(() =>
      assertPublicEnvSafe('production', { ...production, EAS_BUILD: undefined }),
    ).not.toThrow();
    expect(() => assertPublicEnvSafe('production', production)).toThrow(
      /SITEMUSTER_CLEARED_APP_ID/,
    );
  });

  it('pins the Transistorsoft native SDKs to exact versions in every build', () => {
    delete process.env.APP_ENV;
    const config = evaluate();
    expect(NATIVE_SDK_PINS.tslocationmanagerAndroid).toMatch(/^\d+\.\d+\.\d+$/);
    expect(NATIVE_SDK_PINS.tslocationmanagerIos).toMatch(/^\d+\.\d+\.\d+$/);
    expect(config.plugins).toContainEqual([
      './plugins/with-pinned-native-sdks.js',
      {
        android: NATIVE_SDK_PINS.tslocationmanagerAndroid,
        ios: NATIVE_SDK_PINS.tslocationmanagerIos,
      },
    ]);
  });

  it('declares no tracking, the required-reason APIs and the collected data on iOS', () => {
    delete process.env.APP_ENV;
    const config = evaluate();
    expect(config.ios?.privacyManifests).toEqual(IOS_PRIVACY_MANIFEST);
    expect(IOS_PRIVACY_MANIFEST.NSPrivacyTracking).toBe(false);
    expect(IOS_PRIVACY_MANIFEST.NSPrivacyTrackingDomains).toEqual([]);
    expect(
      IOS_PRIVACY_MANIFEST.NSPrivacyCollectedDataTypes.every(
        (entry) => entry.NSPrivacyCollectedDataTypeTracking === false,
      ),
    ).toBe(true);
    expect(
      IOS_PRIVACY_MANIFEST.NSPrivacyCollectedDataTypes.map((e) => e.NSPrivacyCollectedDataType),
    ).toContain('NSPrivacyCollectedDataTypePreciseLocation');
  });

  it('blocks storage, microphone and (in production) overlay permissions, and turns off Android backup', () => {
    delete process.env.APP_ENV;
    const development = evaluate();
    expect(development.android?.allowBackup).toBe(false);
    expect(development.android?.blockedPermissions).toEqual([...ANDROID_BLOCKED_PERMISSIONS]);
    Object.assign(process.env, production, {
      APP_ENV: 'production',
      SITEMUSTER_CLEARED_APP_ID: 'com.sitemuster.app',
    });
    const release = evaluate();
    expect(release.android?.allowBackup).toBe(false);
    expect(release.android?.blockedPermissions).toEqual(
      expect.arrayContaining([
        'android.permission.SYSTEM_ALERT_WINDOW',
        'android.permission.RECORD_AUDIO',
        'android.permission.READ_EXTERNAL_STORAGE',
        'android.permission.WRITE_EXTERNAL_STORAGE',
      ]),
    );
    // A blocked permission is never also requested.
    expect(
      (release.android?.permissions ?? []).some((name) =>
        (release.android?.blockedPermissions ?? []).includes(`android.permission.${name}`),
      ),
    ).toBe(false);
  });
});
