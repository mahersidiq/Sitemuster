import { describe, expect, it } from 'vitest';

import { readRepoFile } from '../support/repo';

/**
 * Contract between the repository and the CI `database` job (decision #46): the Supabase CLI is
 * pinned (never `latest`) and the local project config exists with the expected services.
 */
describe('Supabase CLI pin and project config', () => {
  it('pins an exact semantic version in supabase/.cli-version', () => {
    const version = readRepoFile('supabase/.cli-version').trim();
    expect(version).not.toBe('latest');
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('declares the sitemuster project with auth, realtime and edge runtime enabled', () => {
    const config = readRepoFile('supabase/config.toml');
    expect(config).toMatch(/^project_id = "sitemuster"$/m);
    for (const section of ['auth', 'realtime', 'edge_runtime', 'api']) {
      expect(config).toMatch(new RegExp(`^\\[${section}\\]\\nenabled = true`, 'm'));
    }
  });

  it('keeps pgTAP tests where `supabase test db` runs them', () => {
    const baseline = readRepoFile('supabase/tests/database/000_security_baseline.test.sql');
    expect(baseline).toContain('select plan(');
    expect(baseline).toContain('select * from finish();');
    expect(baseline.trim().endsWith('rollback;')).toBe(true);
  });
});

describe('CI workflow contract', () => {
  const workflow = readRepoFile('.github/workflows/ci.yml');

  it('runs every required npm check and the database job', () => {
    for (const command of [
      'npm ci',
      'npm run typecheck',
      'npm run lint',
      'npm run format:check',
      'npm run test:unit',
      'npm run test:integration',
      'npm run test:security',
      'npm run test:i18n',
      'npm run test:location-replay',
      'npx expo config --json',
      'npm audit --audit-level=high',
      'supabase start',
      'supabase db reset --local',
      'supabase test db',
      'npm run test:backend',
    ]) {
      expect(workflow).toContain(command);
    }
  });

  it('never replaces a check with a no-op echo or swallows a failure', () => {
    expect(workflow).not.toMatch(/run:\s*echo\b/);
    const swallowed = workflow
      .split('\n')
      .filter((line) => line.includes('|| true'))
      .filter((line) => !line.includes('supabase stop'));
    expect(swallowed).toEqual([]);
  });
});
