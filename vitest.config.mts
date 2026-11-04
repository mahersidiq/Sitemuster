import { defineConfig } from 'vitest/config';

/**
 * Vitest runs every non-React-Native test (shared domain, schemas, Edge Function logic, security,
 * i18n parity and deterministic location replay). React Native component tests run in Jest.
 * Each project fails when it has no test files, so a CI step can never pass vacuously.
 */
const shared = {
  environment: 'node' as const,
  restoreMocks: true,
};

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          ...shared,
          name: 'unit',
          include: [
            'packages/*/src/**/*.test.ts',
            'src/**/*.test.ts',
            'scripts/**/*.test.ts',
            'supabase/functions/**/*.test.ts',
          ],
        },
      },
      { test: { ...shared, name: 'integration', include: ['tests/integration/**/*.test.ts'] } },
      { test: { ...shared, name: 'security', include: ['tests/security/**/*.test.ts'] } },
      { test: { ...shared, name: 'i18n', include: ['tests/i18n/**/*.test.ts'] } },
      { test: { ...shared, name: 'replay', include: ['tests/location-replay/**/*.test.ts'] } },
    ],
  },
});
