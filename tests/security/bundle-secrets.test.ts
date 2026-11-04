import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Acceptance test (Milestone 04): server keys never reach the app bundle. Builds the real iOS and
 * Android JavaScript bundles with planted canary values for every server-only secret and checks
 * that none of them — and no direct Google Places/Geocoding endpoint — appears in the output,
 * while a public EXPO_PUBLIC_ canary does (proving the build actually saw the environment).
 */
const SERVER_ONLY = {
  GOOGLE_PLACES_SERVER_KEY: 'canary-places-server-key-0b7d',
  GOOGLE_GEOCODING_SERVER_KEY: 'canary-geocoding-server-key-91ce',
  SUPABASE_SERVICE_ROLE_KEY: 'canary-service-role-key-5a12',
  TWILIO_AUTH_TOKEN: 'canary-twilio-token-77e0',
  SENTRY_AUTH_TOKEN: 'canary-sentry-token-c3f1',
  // Client key for the native Android map: lives in AndroidManifest, never in the JS bundle.
  GOOGLE_MAPS_ANDROID_API_KEY: 'canary-android-maps-key-2d44',
};
const PUBLIC_CANARY = 'https://canary-public-project.supabase.co';

let outDir = '';
let bundles: { path: string; text: string }[] = [];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

beforeAll(() => {
  outDir = mkdtempSync(join(tmpdir(), 'sitemuster-bundle-'));
  const result = spawnSync(
    'npx',
    [
      'expo',
      'export',
      '--platform',
      'ios',
      '--platform',
      'android',
      '--no-bytecode',
      '--output-dir',
      outDir,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...SERVER_ONLY,
        CI: '1',
        EXPO_OFFLINE: '1',
        APP_ENV: 'development',
        EXPO_PUBLIC_SUPABASE_URL: PUBLIC_CANARY,
        EXPO_PUBLIC_SUPABASE_ANON_KEY: 'public-anon-canary',
      },
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    throw new Error(`expo export failed (${String(result.status)}): ${result.stderr.slice(-2000)}`);
  }
  bundles = walk(outDir)
    .filter((path) => path.endsWith('.js') || path.endsWith('.hbc') || path.endsWith('.map'))
    .map((path) => ({ path, text: readFileSync(path, 'utf8') }));
}, 600_000);

afterAll(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

describe('app bundle secret scan', () => {
  it('built an iOS and an Android bundle that contain the public configuration', () => {
    const js = bundles.filter((b) => b.path.endsWith('.js'));
    expect(js.some((b) => b.path.includes('/ios/'))).toBe(true);
    expect(js.some((b) => b.path.includes('/android/'))).toBe(true);
    for (const bundle of js) expect(bundle.text).toContain(PUBLIC_CANARY);
  });

  it.each(Object.entries(SERVER_ONLY))('never contains the value of %s', (_name, canary) => {
    for (const bundle of bundles) expect(bundle.text.includes(canary), bundle.path).toBe(false);
  });

  it('never calls Google Places or Geocoding directly (only through the Edge Functions)', () => {
    for (const bundle of bundles) {
      expect(bundle.text, bundle.path).not.toMatch(/places\.googleapis\.com|maps\/api\/geocode/);
      expect(bundle.text, bundle.path).not.toMatch(/GOOGLE_(PLACES|GEOCODING)_SERVER_KEY/);
    }
  });
  it('never ships the simulated location SDK (CI trace driver) in a release bundle (decision #18)', () => {
    expect(bundles.length).toBeGreaterThan(0);
    for (const bundle of bundles) {
      expect(bundle.text.includes('SITEMUSTER-SIMULATED-SDK')).toBe(false);
    }
  });
});
