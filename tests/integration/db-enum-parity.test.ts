import { describe, expect, it } from 'vitest';

import { DB_ENUM_MIRRORS } from '@sitemuster/shared';

import { listFiles, readRepoFile } from '../support/repo';

/**
 * "ISO code enums mirrored across DB and packages/shared Zod" (spec 11): every enum created by a
 * migration must have an identical, identically ordered TypeScript mirror.
 */
function parseDbEnums(): Map<string, string[]> {
  const enums = new Map<string, string[]>();
  const migrations = listFiles(['supabase/migrations'], (path) => path.endsWith('.sql'));
  for (const file of migrations) {
    const sql = readRepoFile(file);
    for (const match of sql.matchAll(/create type public\.(\w+) as enum \(([^;]*?)\);/gis)) {
      const [, name, body] = match;
      if (!name || body === undefined) continue;
      enums.set(
        name,
        [...body.matchAll(/'([^']*)'/g)].map((m) => m[1] ?? ''),
      );
    }
  }
  return enums;
}

describe('database enum ↔ shared TypeScript mirror parity', () => {
  const dbEnums = parseDbEnums();

  it('finds the migration enums', () => {
    expect(dbEnums.size).toBeGreaterThanOrEqual(40);
  });

  it('has a mirror for every database enum and no stale mirrors', () => {
    expect([...dbEnums.keys()].sort()).toEqual(Object.keys(DB_ENUM_MIRRORS).sort());
  });

  for (const [name, mirror] of Object.entries(DB_ENUM_MIRRORS)) {
    it(`${name} values and order match`, () => {
      expect(dbEnums.get(name)).toEqual([...mirror]);
    });
  }
});
