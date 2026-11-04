import { describe, expect, it } from 'vitest';

import { listFiles, readRepoFile } from '../support/repo';

/**
 * Static scan for CLAUDE.md "Strictly banned patterns" in shipped code (app/, src/, packages/).
 * Tests and this scanner are excluded so they may name the patterns they forbid.
 */
const SHIPPED_CODE = listFiles(
  ['app', 'src', 'packages'],
  (path) => /\.(ts|tsx|js|jsx)$/.test(path) && !/\.test\.(ts|tsx)$/.test(path),
);

const RULES: { name: string; pattern: RegExp }[] = [
  { name: 'browser localStorage', pattern: /\blocalStorage\b/ },
  { name: 'browser sessionStorage', pattern: /\bsessionStorage\b/ },
  { name: 'browser geolocation API', pattern: /navigator\.geolocation/ },
  { name: 'expo-location as tracker', pattern: /from ['"]expo-location['"]/ },
  { name: 'service role key', pattern: /service_role|SERVICE_ROLE_KEY/i },
  { name: 'Twilio secret', pattern: /TWILIO_AUTH_TOKEN|TWILIO_ACCOUNT_SID/ },
  { name: 'Google server key', pattern: /GOOGLE_(PLACES|GEOCODING)_SERVER_KEY/ },
  { name: 'Sentry auth token', pattern: /SENTRY_AUTH_TOKEN/ },
  {
    name: 'badge/device server secret',
    pattern: /BADGE_SECRET_ENCRYPTION_KEY|DEVICE_CREDENTIAL_PEPPER/,
  },
  { name: 'explicit any', pattern: /:\s*any\b|as any\b|<any>/ },
  { name: 'empty catch', pattern: /catch\s*(\([^)]*\))?\s*\{\s*\}/ },
  { name: 'JS timer location polling', pattern: /setInterval\([^)]*(locat|position|gps)/i },
  { name: 'hardcoded headcount demo data', pattern: /DEMO_HEADCOUNT|FAKE_HEADCOUNT/ },
];

describe('banned patterns in shipped code', () => {
  it('scans a non-trivial set of shipped files', () => {
    expect(SHIPPED_CODE.length).toBeGreaterThan(20);
  });

  for (const rule of RULES) {
    it(`contains no ${rule.name}`, () => {
      const offenders = SHIPPED_CODE.filter((path) => rule.pattern.test(readRepoFile(path)));
      expect(offenders).toEqual([]);
    });
  }
});

describe('public environment variable names', () => {
  it('never declares a secret-looking EXPO_PUBLIC_ variable anywhere in config', () => {
    const files = ['app.config.ts', '.env.example', ...listFiles(['src', 'app'], () => true)];
    const offenders = files.filter((path) =>
      /EXPO_PUBLIC_[A-Z0-9_]*(SERVICE_ROLE|SECRET|PRIVATE|PASSWORD|AUTH_TOKEN|SERVER_KEY|PEPPER|ENCRYPTION_KEY)/.test(
        readRepoFile(path).replace(/SECRET_NAME_FRAGMENTS[\s\S]*?\];/, ''),
      ),
    );
    expect(offenders).toEqual([]);
  });
});
