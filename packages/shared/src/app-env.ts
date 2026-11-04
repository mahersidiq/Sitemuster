/**
 * Runtime environments. Fake providers are allowed ONLY in `development` and automated `test`.
 * `staging` must use real providers (sandbox credentials are allowed); `production` fails closed.
 */
export const RUNTIME_ENVIRONMENTS = ['development', 'test', 'staging', 'production'] as const;
export type RuntimeEnvironment = (typeof RUNTIME_ENVIRONMENTS)[number];

export function isRuntimeEnvironment(value: unknown): value is RuntimeEnvironment {
  return typeof value === 'string' && (RUNTIME_ENVIRONMENTS as readonly string[]).includes(value);
}

export function fakesAllowedIn(env: RuntimeEnvironment): boolean {
  return env === 'development' || env === 'test';
}
