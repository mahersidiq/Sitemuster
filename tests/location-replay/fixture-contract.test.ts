import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { LocationTraceFixtureSchema } from '@sitemuster/shared';

import { listFiles, REPO_ROOT } from '../support/repo';

/**
 * Milestone 01 scope: the replay FIXTURE CONTRACT only (file format shared by the harness and
 * the production normalizer). The deterministic engine replay of >=55 fixtures is Milestone 06;
 * this suite does not claim any location-engine behaviour.
 */
const FIXTURES = listFiles(['tests/location-traces'], (path) => path.endsWith('.json'));

describe('location trace fixture contract', () => {
  it('has at least the spec example fixture', () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(1);
  });

  for (const path of FIXTURES) {
    it(`${basename(path)} conforms to LocationTraceFixtureSchema`, () => {
      const raw: unknown = JSON.parse(readFileSync(join(REPO_ROOT, path), 'utf8'));
      const parsed = LocationTraceFixtureSchema.safeParse(raw);
      expect(parsed.error?.issues ?? []).toEqual([]);
      expect(parsed.data?.id).toBe(basename(path, '.json'));
    });
  }

  it('uses unique fixture ids', () => {
    const ids = FIXTURES.map((path) => basename(path, '.json'));
    expect(new Set(ids).size).toBe(ids.length);
  });
});
