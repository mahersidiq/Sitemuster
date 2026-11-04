import type { ConfigContext, ExpoConfig } from 'expo/config';

import NATIVE_EN from './locales/native/en.json';

/**
 * SiteMuster Expo configuration.
 *
 * - APP_ENV selects development | staging | production (default development).
 * - Bundle identifiers follow CLAUDE.md: `com.sitemuster.app.dev` is the working development ID
 *   (also used for staging builds, decision #49); `com.sitemuster.app` is a production
 *   RESERVATION ONLY until brand clearance (decision #30).
 * - Production fails closed: on the EAS build server (EAS_BUILD=true) evaluating this config with
 *   APP_ENV=production throws when a required value is missing (decisions #51, #146), so no
 *   production build can silently fall back to mocks; the app also refuses to run without it.
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
  'TS_ANDROID_LICENSE_KEY',
  // Brand/package clearance (HUMAN_CHECKLIST §9, decision #145): the owner sets this to the
  // cleared production id; until then no production build can be made.
  'SITEMUSTER_CLEARED_APP_ID',
] as const;

/**
 * Exact Transistorsoft native SDK versions inside every build (decision #144). The privacy
 * sign-off is per app version (decision #90), so the native code of a version must not drift.
 */
export const NATIVE_SDK_PINS = { tslocationmanagerAndroid: '4.7.8', tslocationmanagerIos: '4.8.3' };

/**
 * Permissions a dependency declares that SiteMuster never needs: shared storage (CSV and printable
 * badges are written to the app's own files and handed to the share sheet) and the microphone.
 */
export const ANDROID_BLOCKED_PERMISSIONS = [
  'android.permission.READ_EXTERNAL_STORAGE',
  'android.permission.WRITE_EXTERNAL_STORAGE',
  'android.permission.RECORD_AUDIO',
] as const;
/** "Draw over other apps" comes from the React Native template for developer tools only. */
export const ANDROID_RELEASE_BLOCKED_PERMISSIONS = [
  'android.permission.SYSTEM_ALERT_WINDOW',
] as const;

/**
 * iOS privacy manifest (App Store requirement). Required-reason APIs: the union of what the
 * native dependencies declare in their own manifests, repeated at app level because statically
 * linked pods are not always picked up. Collected data: what the app sends to SiteMuster's servers;
 * nothing is used for tracking or advertising. The App Store privacy label must match
 * (docs/release/store-submission.md).
 */
const collected = (type: string, linked = true) => ({
  NSPrivacyCollectedDataType: `NSPrivacyCollectedDataType${type}`,
  NSPrivacyCollectedDataTypeLinked: linked,
  NSPrivacyCollectedDataTypeTracking: false,
  NSPrivacyCollectedDataTypePurposes: ['NSPrivacyCollectedDataTypePurposeAppFunctionality'],
});
export const IOS_PRIVACY_MANIFEST = {
  NSPrivacyTracking: false,
  NSPrivacyTrackingDomains: [],
  NSPrivacyAccessedAPITypes: [
    {
      NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryUserDefaults',
      NSPrivacyAccessedAPITypeReasons: ['CA92.1', '1C8F.1'],
    },
    {
      NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryFileTimestamp',
      NSPrivacyAccessedAPITypeReasons: ['C617.1', '0A2A.1', '3B52.1'],
    },
    {
      NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategorySystemBootTime',
      NSPrivacyAccessedAPITypeReasons: ['35F9.1'],
    },
    {
      NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryDiskSpace',
      NSPrivacyAccessedAPITypeReasons: ['E174.1', '85F4.1'],
    },
  ],
  NSPrivacyCollectedDataTypes: [
    collected('PreciseLocation'),
    collected('Name'),
    collected('PhoneNumber'),
    collected('EmailAddress'),
    collected('UserID'),
    collected('DeviceID'),
    // Crash reports are scrubbed and carry no user id (src/monitoring, decision #134).
    collected('CrashData', false),
  ],
};

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
  // The release gates run where every value exists: on the EAS build server (EAS_BUILD=true),
  // which also receives "Secret" variables. The EAS CLI first evaluates this file on the
  // developer's machine or CI runner with only the build profile's env to find the project, so
  // throwing there would make every production build impossible (decision #146). A production
  // binary built anywhere still refuses to run without its public configuration (runtime check,
  // src/config/runtime-env.ts) and the location SDK refuses to run unlicensed.
  if (appEnv !== 'production' || env.EAS_BUILD !== 'true') return;
  const missing = [...PRODUCTION_REQUIRED_PUBLIC_ENV, ...PRODUCTION_REQUIRED_BUILD_ENV].filter(
    (name) => !env[name]?.trim(),
  );
  if (missing.length > 0) {
    throw new Error(
      `Production build configuration is incomplete (fail closed). Missing: ${missing.join(', ')}`,
    );
  }
  if (env.SITEMUSTER_CLEARED_APP_ID?.trim() !== BUNDLE_IDS.production) {
    throw new Error(
      `Production build refused: SITEMUSTER_CLEARED_APP_ID must equal the cleared production id ${BUNDLE_IDS.production} (brand clearance, HUMAN_CHECKLIST §9).`,
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
      privacyManifests: IOS_PRIVACY_MANIFEST,
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
      blockedPermissions: [
        ...ANDROID_BLOCKED_PERMISSIONS,
        ...(appEnv === 'production' ? ANDROID_RELEASE_BLOCKED_PERMISSIONS : []),
      ],
      // No cloud backup of app data: the session store, the operational outbox and the device
      // secrets belong to this phone only and must never be restored onto another one.
      allowBackup: false,
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
        process.env.TS_ANDROID_LICENSE_KEY ? { license: process.env.TS_ANDROID_LICENSE_KEY } : {},
      ],
      [
        './plugins/with-pinned-native-sdks.js',
        {
          android: NATIVE_SDK_PINS.tslocationmanagerAndroid,
          ios: NATIVE_SDK_PINS.tslocationmanagerIos,
        },
      ],
      // Muster alerts (Milestone 11): Expo push; APNs/FCM credentials live in EAS, never here.
      'expo-notifications',
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
