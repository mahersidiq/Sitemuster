import { fakesAllowedIn, type RuntimeEnvironment } from '../app-env.ts';
import type { ProviderBase } from './types.ts';

export class FakeProviderNotAllowedError extends Error {
  constructor(providerName: string, env: RuntimeEnvironment) {
    super(`Fake provider "${providerName}" is not allowed in the ${env} environment.`);
    this.name = 'FakeProviderNotAllowedError';
  }
}

export class ProviderNotConfiguredError extends Error {
  constructor(providerName: string, env: RuntimeEnvironment) {
    super(
      `Provider "${providerName}" has no live configuration in the ${env} environment; ` +
        'refusing to fall back to a fake (fail closed).',
    );
    this.name = 'ProviderNotConfiguredError';
  }
}

/** Throws unless the environment is `development` or automated `test`. */
export function assertFakeAllowed(env: RuntimeEnvironment, providerName: string): void {
  if (!fakesAllowedIn(env)) throw new FakeProviderNotAllowedError(providerName, env);
}

export interface ProviderSelection<T extends ProviderBase> {
  env: RuntimeEnvironment;
  name: string;
  /** Factory for the live provider, or null when its configuration/secret is absent. */
  real: (() => T) | null;
  /** Factory for the typed development-only fake. */
  fake: () => T;
}

/**
 * Select a provider. Live configuration always wins. Without it, a fake is used ONLY in
 * development/test; staging and production fail closed with ProviderNotConfiguredError.
 */
export function selectProvider<T extends ProviderBase>(selection: ProviderSelection<T>): T {
  if (selection.real) return selection.real();
  if (fakesAllowedIn(selection.env)) return selection.fake();
  throw new ProviderNotConfiguredError(selection.name, selection.env);
}
