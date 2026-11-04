import type { ConfigContext, ExpoConfig } from 'expo/config';

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
  if (appEnv !== 'production') return;
  const missing = PRODUCTION_REQUIRED_PUBLIC_ENV.filter((name) => !env[name]?.trim());
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
    },
    android: {
      package: bundleId,
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
      [
        '@sentry/react-native/expo',
        {
          url: 'https://sentry.io/',
          ...(process.env.SENTRY_ORG ? { organization: process.env.SENTRY_ORG } : {}),
          ...(process.env.SENTRY_PROJECT ? { project: process.env.SENTRY_PROJECT } : {}),
        },
      ],
    ],
    extra: {
      appEnv,
      ...(process.env.EAS_PROJECT_ID ? { eas: { projectId: process.env.EAS_PROJECT_ID } } : {}),
    },
  };
}
