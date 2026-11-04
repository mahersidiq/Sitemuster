import { describe, expect, it } from 'vitest';

import { TRACKING_DEFAULTS } from '@sitemuster/shared';

import { withDb } from './support/db';

/**
 * Every configuration version stores the complete merged settings built by the database
 * (app_private.tracking_defaults + project overrides). Those defaults must equal the locked spec
 * values the app and replay engine use (packages/shared TRACKING_DEFAULTS, spec 06).
 */
describe('locked tracking defaults: database = shared package', () => {
  it('has the same value for every key the database writes into config versions', async () => {
    const dbDefaults = await withDb(async (db) => {
      const result = await db.query<{ d: Record<string, unknown> }>(
        'select app_private.tracking_defaults() as d',
      );
      return result.rows[0]?.d ?? {};
    });
    const shared = TRACKING_DEFAULTS as unknown as Record<string, unknown>;
    const aliases: Record<string, unknown> = {
      operates_24_7: TRACKING_DEFAULTS.operates_24_7_default,
    };
    const mismatches = Object.entries(dbDefaults).filter(([key, value]) => {
      const expected = key in aliases ? aliases[key] : shared[key];
      return expected === undefined || JSON.stringify(expected) !== JSON.stringify(value);
    });
    expect(mismatches).toEqual([]);
    expect(Object.keys(dbDefaults).length).toBeGreaterThanOrEqual(20);
  });
});
