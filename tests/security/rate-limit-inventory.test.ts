import { describe, expect, it } from 'vitest';

import { listFiles, readRepoFile } from '../support/repo';

/**
 * docs/security/rate-limits.md is the reviewed inventory of every rate limit (spec 09). This test
 * keeps it honest: every bucket used by a migration is documented with its exact limit, and every
 * documented bucket still exists. The sign-in code limits in supabase/config.toml are checked too.
 */
const MIGRATIONS = listFiles(['supabase/migrations'], (path) => path.endsWith('.sql'));
const DOC = readRepoFile('docs/security/rate-limits.md');

interface Bucket {
  name: string;
  limit: number;
}

function bucketsInMigrations(): Bucket[] {
  const found = new Map<string, number>();
  for (const path of MIGRATIONS) {
    const sql = readRepoFile(path);
    for (const m of sql.matchAll(/consume_rate_limit\('([a-z_]+)',\s*[^,]+,\s*(\d+),\s*\d+\)/g)) {
      found.set(m[1] ?? '', Number(m[2]));
    }
    for (const m of sql.matchAll(
      /consume_rate_limit_units\('([a-z_]+)',\s*[^,]+,\s*greatest\([^)]*\),\s*(\d+),\s*\d+\)/g,
    )) {
      found.set(m[1] ?? '', Number(m[2]));
    }
    for (const m of sql.matchAll(/rate_limit_insert\('([a-z_]+)',\s*'(\d+)',\s*'\d+'\)/g)) {
      found.set(m[1] ?? '', Number(m[2]));
    }
  }
  return [...found].map(([name, limit]) => ({ name, limit }));
}

function documentedRows(): Map<string, string> {
  const rows = new Map<string, string>();
  for (const line of DOC.split('\n')) {
    const match = /^\|[^|]*\|\s*`([a-z_]+)`\s*\|([^|]+)\|/.exec(line);
    if (match?.[1] && match[2]) rows.set(match[1], match[2].trim());
  }
  return rows;
}

describe('rate-limit inventory', () => {
  const buckets = bucketsInMigrations();
  const documented = documentedRows();

  it('finds the limits in the migrations', () => {
    expect(buckets.length).toBeGreaterThanOrEqual(19);
  });

  it('documents every bucket with its exact limit', () => {
    for (const { name, limit } of buckets) {
      const row = documented.get(name);
      expect(row, `${name} is missing from docs/security/rate-limits.md`).toBeDefined();
      expect(row?.replace(/,/g, ''), name).toContain(String(limit));
    }
  });

  it('documents no bucket that no longer exists', () => {
    const names = new Set(buckets.map((bucket) => bucket.name));
    expect([...documented.keys()].filter((name) => !names.has(name))).toEqual([]);
  });

  it('covers every area spec 09 names', () => {
    for (const area of [
      'Enrollment',
      'Badge issue',
      'Badge scan',
      'Invites',
      'Operator functions',
      'Attendance ingestion',
      'Report exports',
      'SMS code',
    ]) {
      expect(DOC).toContain(`| ${area}`);
    }
  });

  it('keeps the documented sign-in code limits in supabase/config.toml', () => {
    const config = readRepoFile('supabase/config.toml');
    expect(Number(/^sms_sent = (\d+)/m.exec(config)?.[1])).toBeGreaterThanOrEqual(400);
    expect(config.match(/^max_frequency = "60s"/gm)?.length).toBeGreaterThanOrEqual(2);
    expect(/^sign_in_sign_ups = 30$/m.test(config)).toBe(true);
    expect(/^token_verifications = 30$/m.test(config)).toBe(true);
  });
});
