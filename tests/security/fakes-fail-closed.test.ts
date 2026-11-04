import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  FakeAddressProvider,
  FakeCredentialProvisioner,
  FakeLocationProvider,
  FakeProviderNotAllowedError,
  FakePushProvider,
  FakeSmsOtpProvider,
} from '@sitemuster/shared';

const rng = (n: number) => new Uint8Array(randomBytes(n));

/** HUMAN_CHECKLIST: production refuses boot/privileged operation on mocks. */
describe('development-only fakes cannot exist outside development/test', () => {
  const constructors: [string, (env: 'staging' | 'production') => unknown][] = [
    ['FakeSmsOtpProvider', (env) => new FakeSmsOtpProvider(env, rng)],
    ['FakeAddressProvider', (env) => new FakeAddressProvider(env)],
    ['FakePushProvider', (env) => new FakePushProvider(env)],
    ['FakeLocationProvider', (env) => new FakeLocationProvider(env)],
    ['FakeCredentialProvisioner', (env) => new FakeCredentialProvisioner(env, rng)],
  ];

  for (const [name, construct] of constructors) {
    for (const env of ['staging', 'production'] as const) {
      it(`${name} refuses to construct in ${env}`, () => {
        expect(() => construct(env)).toThrow(FakeProviderNotAllowedError);
      });
    }
  }
});
