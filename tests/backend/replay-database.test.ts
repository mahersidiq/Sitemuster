import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Client } from 'pg';
import { describe, expect, it } from 'vitest';

import { type LocationTraceFixture, LocationTraceFixtureSchema } from '@sitemuster/shared';

import { checkInvariants, compareExpected } from '../location-replay/harness/expect';
import { runFixture } from '../location-replay/harness/harness';
import { listFiles, REPO_ROOT } from '../support/repo';
import { backendEnv } from './support/env';
import { PgReplayBackend } from './support/replay-pg-backend';

/**
 * Milestone 06 parity: every deterministic trace replays against the REAL local Postgres — the
 * engine reads and writes through the service-role reconciler RPCs and time advances through the
 * SQL sweep — and must produce exactly the same expected results as the in-memory replay. Each
 * fixture runs inside one transaction that is rolled back, so the database is left unchanged.
 */
const FIXTURES: LocationTraceFixture[] = listFiles(['tests/location-traces'], (path) =>
  path.endsWith('.json'),
).map((path) =>
  LocationTraceFixtureSchema.parse(JSON.parse(readFileSync(join(REPO_ROOT, path), 'utf8'))),
);

describe('deterministic location replay — real database (reconciler RPCs + SQL sweep)', () => {
  for (const fixture of FIXTURES) {
    it(`${fixture.spec_case ? `#${fixture.spec_case} ` : ''}${fixture.id}`, async () => {
      const db = new Client({ connectionString: backendEnv().dbUrl });
      await db.connect();
      const backend = new PgReplayBackend(db, fixture.id);
      try {
        await backend.begin();
        const { harness, observation, allSessions } = await runFixture(fixture, backend);
        expect([
          ...compareExpected(fixture, observation, harness, allSessions),
          ...checkInvariants(fixture, observation),
        ]).toEqual([]);
      } finally {
        await backend.close();
        await db.end();
      }
    });
  }
});
