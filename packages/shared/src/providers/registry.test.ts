import { describe, expect, it } from 'vitest';

import { FakeAddressProvider } from './fakes.ts';
import {
  assertFakeAllowed,
  FakeProviderNotAllowedError,
  ProviderNotConfiguredError,
  selectProvider,
} from './registry.ts';
import type { AddressProvider } from './types.ts';

const realAddress: AddressProvider = {
  name: 'RealAddress',
  kind: 'real',
  search: async () => [],
  resolve: async (placeId) => ({ placeId, formattedAddress: '', lat: 0, lng: 0, attribution: '' }),
};

describe('provider selection', () => {
  it('prefers live configuration in every environment', () => {
    for (const env of ['development', 'test', 'staging', 'production'] as const) {
      const chosen = selectProvider<AddressProvider>({
        env,
        name: 'address',
        real: () => realAddress,
        fake: () => new FakeAddressProvider('test'),
      });
      expect(chosen.kind).toBe('real');
    }
  });

  it('uses fakes only in development and test', () => {
    for (const env of ['development', 'test'] as const) {
      const chosen = selectProvider<AddressProvider>({
        env,
        name: 'address',
        real: null,
        fake: () => new FakeAddressProvider(env),
      });
      expect(chosen.kind).toBe('fake');
    }
  });

  it('fails closed in staging and production without live configuration', () => {
    for (const env of ['staging', 'production'] as const) {
      expect(() =>
        selectProvider<AddressProvider>({
          env,
          name: 'address',
          real: null,
          fake: () => new FakeAddressProvider('test'),
        }),
      ).toThrow(ProviderNotConfiguredError);
    }
  });

  it('assertFakeAllowed rejects staging and production', () => {
    expect(() => assertFakeAllowed('development', 'x')).not.toThrow();
    expect(() => assertFakeAllowed('test', 'x')).not.toThrow();
    expect(() => assertFakeAllowed('staging', 'x')).toThrow(FakeProviderNotAllowedError);
    expect(() => assertFakeAllowed('production', 'x')).toThrow(FakeProviderNotAllowedError);
  });
});
