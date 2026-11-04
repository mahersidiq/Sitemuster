import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  FakeAddressProvider,
  FakeCredentialProvisioner,
  FakeLocationProvider,
  FakePushProvider,
  FakeSmsOtpProvider,
  ProviderNotConfiguredError,
  selectProvider,
  type ProviderBase,
  type RuntimeEnvironment,
} from '@sitemuster/shared';

import { parseRuntimeEnv } from '../../src/config/runtime-env';

/**
 * Integration across the shared provider registry and the app runtime env: for each environment,
 * build the full adapter set the app/back end would use when NO provider accounts exist yet.
 */
const rng = (n: number) => new Uint8Array(randomBytes(n));

function buildRegistry(env: RuntimeEnvironment): Record<string, ProviderBase> {
  return {
    sms: selectProvider({
      env,
      name: 'sms',
      real: null,
      fake: () => new FakeSmsOtpProvider(env, rng),
    }),
    address: selectProvider({
      env,
      name: 'address',
      real: null,
      fake: () => new FakeAddressProvider(env),
    }),
    push: selectProvider({ env, name: 'push', real: null, fake: () => new FakePushProvider(env) }),
    location: selectProvider({
      env,
      name: 'location',
      real: null,
      fake: () => new FakeLocationProvider(env),
    }),
    credentials: selectProvider({
      env,
      name: 'credentials',
      real: null,
      fake: () => new FakeCredentialProvisioner(env, rng),
    }),
  };
}

describe('provider registry without any third-party accounts', () => {
  it('runs on typed fakes in development and test', () => {
    for (const env of ['development', 'test'] as const) {
      const registry = buildRegistry(env);
      expect(Object.values(registry).every((provider) => provider.kind === 'fake')).toBe(true);
    }
  });

  it.each(['staging', 'production'] as const)('refuses to start in %s (fail closed)', (env) => {
    expect(() => buildRegistry(env)).toThrow(ProviderNotConfiguredError);
  });

  it('agrees with the mobile runtime env: production without config never reaches providers', () => {
    const runtime = parseRuntimeEnv({ appEnv: 'production' });
    expect(runtime.ok).toBe(false);
  });
});
