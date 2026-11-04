import type { ConfigContext, ExpoConfig } from 'expo/config';

import NATIVE_EN from './locales/native/en.json';

/**
 * SiteMuster Expo configuration.
 *
 * - APP_ENV selects development | staging | production (default development).
 * - Bundle identifiers follow CLAUDE.md: `com.sitemuster.app.dev` is the working development ID
 *   (also used for staging builds, decision #49); `com.sitemuster.app` is a production
 *   RESERVATION ONLY until brand clearance (decision #30).
 * - Production fails closed: evaluating this config with APP_ENV=production throws when a
 *   required public value is missing, so no production build can silently fall back to mocks.
 * - Only NON-SECRET values may appear here. Server secrets never use the EXPO_PUBLIC_ prefix.
 */

export const APP_ENVS = ['development', 'staging', 'production'] as const;
export type AppEnv = (typeof APP_ENVS)[number];

export const BUNDLE_IDS: Record<AppEnv, string> = {
  development: 'com.sitemuster.app.dev',
  staging: 'com.sitemuster.app.dev',
  production: 'com.sitemuster.app',
};

/** Public build-time variables a production build cannot run without. Names only, never values. */
export const PRODUCTION_REQUIRED_PUBLIC_ENV = [
  'EXPO_PUBLIC_SUPABASE_URL',
  'EXPO_PUBLIC_SUPABASE_ANON_KEY',
  'EXPO_PUBLIC_SENTRY_DSN',
] as const;

/**
 * Build-time (not EXPO_PUBLIC_) values a production build cannot ship without. The Android Maps
 * SDK key is an app-restricted CLIENT key written into AndroidManifest by react-native-maps; it is
 * never one of the Google server keys used only by Edge Functions (Places/Geocoding).
 */
export const PRODUCTION_REQUIRED_BUILD_ENV = [
  'GOOGLE_MAPS_ANDROID_API_KEY',
  // Transistorsoft Android release license (decision #12), bound to the final package id.
  'TRANSISTORSOFT_LICENSE_ANDROID',
] as const;

/** Native tracking permissions (docs/spec/03 "Permissions and platform policies"). */
export const ANDROID_TRACKING_PERMISSIONS = [
  'ACCESS_COARSE_LOCATION',
  'ACCESS_FINE_LOCATION',
  'ACCESS_BACKGROUND_LOCATION',
  'FOREGROUND_SERVICE',
  'FOREGROUND_SERVICE_LOCATION',
  'POST_NOTIFICATIONS',
  'RECEIVE_BOOT_COMPLETED',
  'ACTIVITY_RECOGNITION',
  'WAKE_LOCK',
] as const;

/** Server-only Google keys (Edge Function secrets). They must never reach the app build. */
const GOOGLE_SERVER_KEY_NAMES = ['GOOGLE_PLACES_SERVER_KEY', 'GOOGLE_GEOCODING_SERVER_KEY'];

/** Variable-name fragments that must never be exposed to the app bundle via EXPO_PUBLIC_. */
const SECRET_NAME_FRAGMENTS = [
  'SERVICE_ROLE',
  'SECRET',
  'PRIVATE',
  'PASSWORD',
  'AUTH_TOKEN',
  'SERVER_KEY',
  'PEPPER',
  'ENCRYPTION_KEY',
  'ACCESS_TOKEN',
];

export function readAppEnv(env: Record<string, string | undefined> = process.env): AppEnv {
  const raw = env.APP_ENV ?? 'development';
  if (!(APP_ENVS as readonly string[]).includes(raw)) {
    throw new Error(
      `APP_ENV must be one of ${APP_ENVS.join(', ')}; received an unsupported value.`,
    );
  }
  return raw as AppEnv;
}

/** Throws (listing variable NAMES only) when public env is unsafe for the selected environment. */
export function assertPublicEnvSafe(
  appEnv: AppEnv,
  env: Record<string, string | undefined> = process.env,
): void {
  const leaked = Object.keys(env).filter(
    (name) =>
      name.startsWith('EXPO_PUBLIC_') &&
      SECRET_NAME_FRAGMENTS.some((fragment) => name.toUpperCase().includes(fragment)),
  );
  if (leaked.length > 0) {
    throw new Error(
      `Refusing to build: secret-looking variables are exposed to the app bundle: ${leaked.join(', ')}`,
    );
  }
  const mapsKey = env.GOOGLE_MAPS_ANDROID_API_KEY?.trim();
  if (mapsKey && GOOGLE_SERVER_KEY_NAMES.some((name) => env[name]?.trim() === mapsKey)) {
    throw new Error(
      'Refusing to build: GOOGLE_MAPS_ANDROID_API_KEY must be a separate app-restricted key, not a server key.',
    );
  }
  if (appEnv !== 'production') return;
  const missing = [...PRODUCTION_REQUIRED_PUBLIC_ENV, ...PRODUCTION_REQUIRED_BUILD_ENV].filter(
    (name) => !env[name]?.trim(),
  );
  if (missing.length > 0) {
    throw new Error(
      `Production build configuration is incomplete (fail closed). Missing: ${missing.join(', ')}`,
    );
  }
  const supabaseUrl = env.EXPO_PUBLIC_SUPABASE_URL ?? '';
  if (!supabaseUrl.startsWith('https://')) {
    throw new Error('Production build requires an https:// EXPO_PUBLIC_SUPABASE_URL.');
  }
}

export default function expoConfig({ config }: ConfigContext): ExpoConfig {
  const appEnv = readAppEnv();
  assertPublicEnvSafe(appEnv);
  const bundleId = BUNDLE_IDS[appEnv];
  const displaySuffix =
    appEnv === 'production' ? '' : appEnv === 'staging' ? ' (Staging)' : ' (Dev)';

  return {
    ...config,
    name: `SiteMuster${displaySuffix}`,
    slug: 'sitemuster',
    scheme: appEnv === 'production' ? 'sitemuster' : 'sitemuster-dev',
    version: '0.1.0',
    orientation: 'portrait',
    platforms: ['ios', 'android'],
    userInterfaceStyle: 'light',
    ...(process.env.EXPO_OWNER ? { owner: process.env.EXPO_OWNER } : {}),
    ios: {
      bundleIdentifier: bundleId,
      // Kiosk attendant mode runs on supervised staff phones or tablets.
      supportsTablet: true,
      infoPlist: {
        // Transistorsoft v5: location updates + background fetch/processing (decision #14).
        UIBackgroundModes: ['location', 'fetch', 'processing'],
        BGTaskSchedulerPermittedIdentifiers: [
          'com.transistorsoft.fetch',
          'com.transistorsoft.customtask',
        ],
        // English defaults; Spanish comes from locales/native/es.json (InfoPlist.strings).
        NSLocationWhenInUseUsageDescription: NATIVE_EN.ios.NSLocationWhenInUseUsageDescription,
        NSLocationAlwaysAndWhenInUseUsageDescription:
          NATIVE_EN.ios.NSLocationAlwaysAndWhenInUseUsageDescription,
        NSMotionUsageDescription: NATIVE_EN.ios.NSMotionUsageDescription,
      },
    },
    android: {
      package: bundleId,
      permissions: [...ANDROID_TRACKING_PERMISSIONS],
    },
    plugins: [
      'expo-router',
      [
        'expo-localization',
        {
          supportedLocales: {
            ios: ['en', 'es'],
            android: ['en-US', 'es-US'],
          },
        },
      ],
      // QR scanning only (orientation codes and kiosk badges); no microphone.
      [
        'expo-camera',
        {
          cameraPermission:
            'SiteMuster uses the camera only to scan orientation and badge QR codes.',
          microphonePermission: false,
          recordAudioAndroid: false,
        },
      ],
      // Apple Maps on iOS (no iOS Google key, by design); Google Maps on Android.
      [
        'react-native-maps',
        process.env.GOOGLE_MAPS_ANDROID_API_KEY
          ? { androidGoogleMapsApiKey: process.env.GOOGLE_MAPS_ANDROID_API_KEY }
          : {},
      ],
      // Native background tracking. The Android license is a build-time value (EAS secret); a
      // development build runs without it (Transistorsoft DEBUG builds), production fails closed.
      [
        'react-native-background-geolocation',
        process.env.TRANSISTORSOFT_LICENSE_ANDROID
          ? { license: process.env.TRANSISTORSOFT_LICENSE_ANDROID }
          : {},
      ],
      [
        '@sentry/react-native/expo',
        {
          url: 'https://sentry.io/',
          ...(process.env.SENTRY_ORG ? { organization: process.env.SENTRY_ORG } : {}),
          ...(process.env.SENTRY_PROJECT ? { project: process.env.SENTRY_PROJECT } : {}),
        },
      ],
    ],
    // Native permission texts in English and Spanish (docs/spec/08-i18n.md).
    locales: {
      en: './locales/native/en.json',
      es: './locales/native/es.json',
    },
    extra: {
      appEnv,
      ...(process.env.EAS_PROJECT_ID ? { eas: { projectId: process.env.EAS_PROJECT_ID } } : {}),
    },
  };
}
