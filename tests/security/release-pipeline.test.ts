import { describe, expect, it } from 'vitest';

import withPinnedNativeSdks from '../../plugins/with-pinned-native-sdks.js';
import { NATIVE_SDK_PINS } from '../../app.config';
import { readRepoFile } from '../support/repo';

/**
 * Milestone 13 release configuration (decisions #144–#149): reproducible EAS builds and release
 * pipelines that fail closed. These checks keep eas.json, the workflows and the native pins
 * consistent with each other and with the rules in docs/release/native-builds.md.
 */
const eas = JSON.parse(readRepoFile('eas.json')) as {
  cli: { version: string; appVersionSource: string; requireCommit: boolean };
  build: Record<
    string,
    {
      extends?: string;
      node?: string;
      environment?: string;
      env?: Record<string, string>;
      distribution?: string;
      developmentClient?: boolean;
      autoIncrement?: boolean;
    }
  >;
  submit: Record<string, { android?: { track?: string; releaseStatus?: string } }>;
};
const release = readRepoFile('.github/workflows/release.yml');
const deploy = readRepoFile('.github/workflows/deploy-backend.yml');
const ci = readRepoFile('.github/workflows/ci.yml');
const pkg = JSON.parse(readRepoFile('package.json')) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};
const EXACT = /^\d+\.\d+\.\d+$/;

describe('eas.json', () => {
  it('pins the EAS CLI exactly, takes build numbers from EAS and builds only committed code', () => {
    expect(eas.cli.version).toMatch(EXACT);
    expect(eas.cli.appVersionSource).toBe('remote');
    expect(eas.cli.requireCommit).toBe(true);
    expect(eas.build.base?.node).toMatch(EXACT);
    expect(eas.build.base?.node?.startsWith('22.')).toBe(true);
  });

  it('maps each profile to its EAS environment and app environment (staging never production)', () => {
    expect(eas.build.development).toMatchObject({
      extends: 'base',
      developmentClient: true,
      distribution: 'internal',
      environment: 'development',
      env: { APP_ENV: 'development' },
    });
    expect(eas.build.preview).toMatchObject({
      extends: 'base',
      distribution: 'internal',
      environment: 'preview',
      env: { APP_ENV: 'staging' },
    });
    expect(eas.build.production).toMatchObject({
      extends: 'base',
      distribution: 'store',
      environment: 'production',
      autoIncrement: true,
      env: { APP_ENV: 'production' },
    });
  });

  it('holds no secret or backend value: those live in EAS environments only', () => {
    for (const profile of Object.values(eas.build)) {
      expect(Object.keys(profile.env ?? {}).filter((name) => name !== 'APP_ENV')).toEqual([]);
    }
  });

  it('submits to Play only as an internal-testing draft (publishing stays a human action)', () => {
    expect(eas.submit.production?.android).toEqual({ track: 'internal', releaseStatus: 'draft' });
  });

  it('ships no over-the-air update channel (decision #147)', () => {
    expect(pkg.dependencies['expo-updates']).toBeUndefined();
    expect(JSON.stringify(eas)).not.toMatch(/"channel"/);
  });
});

describe('release workflow', () => {
  it('runs only when started by hand', () => {
    expect(release).toMatch(/^"on":\n {2}workflow_dispatch:/m);
    expect(release).not.toMatch(/^\s+(push|pull_request|schedule|workflow_run):/m);
  });

  it('builds only commits whose required CI passed, production only from main', () => {
    expect(release).toContain('for check in code-quality database; do');
    expect(release).toContain("inputs.profile == 'production' && github.ref != 'refs/heads/main'");
    expect(release).toContain('needs: gate');
  });

  it('fails closed before checkout when the EAS credentials are missing', () => {
    const credentials = release.indexOf('Release credentials are configured (fail closed)');
    const checkout = release.indexOf('uses: actions/checkout@v4', credentials);
    expect(credentials).toBeGreaterThan(0);
    expect(checkout).toBeGreaterThan(credentials);
    for (const name of ['EXPO_TOKEN', 'EAS_PROJECT_ID', 'EXPO_OWNER']) {
      expect(release).toContain(`[ -n "\${${name}}" ]`);
    }
  });

  it('uses the same pinned EAS CLI and Node as eas.json, and a commit-pinned Expo action', () => {
    expect(release).toContain(`eas-version: ${eas.cli.version}`);
    expect(release).toContain(`node-version: '${eas.build.base?.node}'`);
    expect(release).toMatch(/uses: expo\/expo-github-action@[0-9a-f]{40} # \d+\.\d+\.\d+/);
  });

  it('separates staging and production credentials by GitHub environment', () => {
    expect(release).toContain(
      "environment: ${{ inputs.profile == 'production' && 'production' || 'staging' }}",
    );
  });

  it('submits only production builds, and only as store test drafts', () => {
    expect(release).toContain("if: inputs.submit && inputs.profile == 'production'");
    expect(release).toContain('eas submit --profile production');
    expect(release).not.toMatch(/--release-status completed|track production/);
  });
});

describe('backend deploy workflow', () => {
  it('runs by hand, after green CI, production only from main', () => {
    expect(deploy).toMatch(/^"on":\n {2}workflow_dispatch:/m);
    expect(deploy).not.toMatch(/^\s+(push|pull_request|schedule|workflow_run):/m);
    expect(deploy).toContain('for check in code-quality database; do');
    expect(deploy).toContain("inputs.target == 'production' && github.ref != 'refs/heads/main'");
    expect(deploy).toContain('environment: ${{ inputs.target }}');
  });

  it('only moves the database forward and never resets it', () => {
    expect(deploy).toContain('supabase db push --password');
    expect(deploy).not.toMatch(/db reset|--include-all|migration repair|db dump/);
    expect(deploy).toContain('supabase functions deploy --project-ref');
  });

  it('uses the pinned Supabase CLI and fails closed without its credentials', () => {
    expect(deploy).toContain('supabase/.cli-version');
    for (const name of ['SUPABASE_ACCESS_TOKEN', 'SUPABASE_DB_PASSWORD', 'SUPABASE_PROJECT_REF']) {
      expect(deploy).toContain(`[ -n "\${${name}}" ]`);
    }
  });

  it('never passes Edge Function secrets through GitHub', () => {
    for (const name of [
      'BADGE_SECRET_ENCRYPTION_KEY',
      'SUPABASE_SERVICE_ROLE_KEY',
      'GOOGLE_PLACES_SERVER_KEY',
      'EXPO_ACCESS_TOKEN',
    ]) {
      expect(deploy).not.toContain(name);
      expect(release).not.toContain(name);
    }
  });

  it('leaves the CI workflow for pull requests unchanged in purpose (no deploys from CI)', () => {
    expect(ci).not.toMatch(/eas (build|submit)|supabase (db push|functions deploy|link)/);
  });
});

describe('pinned native location SDKs (decision #144)', () => {
  const { pinAndroid, pinIos } = withPinnedNativeSdks as unknown as {
    pinAndroid(gradle: string, version: string): string;
    pinIos(podfile: string, version: string): string;
  };

  it('writes an exact version once, however often prebuild runs', () => {
    const gradle = 'buildscript {}\napply plugin: "com.facebook.react.rootproject"\n';
    const once = pinAndroid(gradle, NATIVE_SDK_PINS.tslocationmanagerAndroid);
    expect(pinAndroid(once, NATIVE_SDK_PINS.tslocationmanagerAndroid)).toBe(once);
    expect(once).toContain(
      `ext.tslocationmanagerVersion = "${NATIVE_SDK_PINS.tslocationmanagerAndroid}"`,
    );
    const podfile = "require 'json'\nplatform :ios, '15.1'\n";
    const pod = pinIos(podfile, NATIVE_SDK_PINS.tslocationmanagerIos);
    expect(pinIos(pod, NATIVE_SDK_PINS.tslocationmanagerIos)).toBe(pod);
    expect(
      pod.startsWith(
        `ENV['TSLOCATIONMANAGER_VERSION'] = '${NATIVE_SDK_PINS.tslocationmanagerIos}'`,
      ),
    ).toBe(true);
  });

  it('refuses a range instead of an exact version', () => {
    expect(() => pinAndroid('', '4.7.+')).toThrow(/exact/);
    expect(() => pinIos('', '~> 4.8.0')).toThrow(/exact/);
  });

  it('records the pins in the CLAUDE.md dependency manifest', () => {
    const manifest = readRepoFile('CLAUDE.md');
    expect(manifest).toContain(
      `${NATIVE_SDK_PINS.tslocationmanagerAndroid} / ${NATIVE_SDK_PINS.tslocationmanagerIos}`,
    );
    expect(manifest).toContain(eas.cli.version);
  });

  it('stays inside the ranges the pinned React Native package supports', () => {
    const gradle = readRepoFile(
      'node_modules/react-native-background-geolocation/android/build.gradle',
    );
    const podspec = readRepoFile(
      'node_modules/react-native-background-geolocation/RNBackgroundGeolocation.podspec',
    );
    const androidRange = /DEFAULT_TSLOCATIONMANAGER_VERSION\s*=\s*"(\d+)\.(\d+)\.\+"/.exec(gradle);
    const iosRange = /TSLOCATIONMANAGER_VERSION'\]\s*\|\|\s*'~> (\d+)\.(\d+)\.\d+'/.exec(podspec);
    expect(androidRange).not.toBeNull();
    expect(iosRange).not.toBeNull();
    expect(
      NATIVE_SDK_PINS.tslocationmanagerAndroid.startsWith(
        `${androidRange?.[1]}.${androidRange?.[2]}.`,
      ),
    ).toBe(true);
    expect(
      NATIVE_SDK_PINS.tslocationmanagerIos.startsWith(`${iosRange?.[1]}.${iosRange?.[2]}.`),
    ).toBe(true);
  });
});
