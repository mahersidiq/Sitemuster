import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { LocationTraceFixtureSchema, type LocationTraceFixture } from '@sitemuster/shared';

import { listFiles, REPO_ROOT } from '../support/repo';
import { checkInvariants, compareExpected } from './harness/expect';
import { runFixture } from './harness/harness';
import { MemoryBackend } from './harness/memory-backend';

/**
 * Milestone 06 acceptance: every deterministic trace in tests/location-traces replays through the
 * production attendance engine (in-memory server) with exactly the expected presence, sessions,
 * counts and server outcomes, and the always-on invariants hold (privacy egress, one open session,
 * no overlap, no double count). The same fixtures replay against the real database in the
 * `backend` project (tests/backend/replay-database.test.ts).
 */
const FIXTURES: LocationTraceFixture[] = listFiles(['tests/location-traces'], (path) =>
  path.endsWith('.json'),
).map((path) =>
  LocationTraceFixtureSchema.parse(JSON.parse(readFileSync(join(REPO_ROOT, path), 'utf8'))),
);

/** docs/spec/10 scenarios owned by later milestones (none left: reports arrived in Milestone 10). */
const LATER_MILESTONES = new Set<number>([]);

describe('deterministic location replay — suite size', () => {
  it('covers at least 55 named scenarios of docs/spec/10-testing.md plus edge cases', () => {
    const named = new Set(
      FIXTURES.flatMap((fixture) => (fixture.spec_case ? [fixture.spec_case] : [])),
    );
    expect(named.size).toBeGreaterThanOrEqual(55);
    const missing = Array.from({ length: 60 }, (_, i) => i + 1).filter(
      (n) => !named.has(n) && !LATER_MILESTONES.has(n),
    );
    expect(missing).toEqual([]);
    expect(FIXTURES.length).toBeGreaterThanOrEqual(60);
  });
});

describe('deterministic location replay — in-memory server', () => {
  for (const fixture of FIXTURES) {
    it(`${fixture.spec_case ? `#${fixture.spec_case} ` : ''}${fixture.id}`, async () => {
      const backend = new MemoryBackend();
      const { harness, observation, allSessions } = await runFixture(fixture, backend);
      expect([
        ...compareExpected(fixture, observation, harness, allSessions),
        ...checkInvariants(fixture, observation),
      ]).toEqual([]);
    });
  }
});

const phoneRecords = (fixture: LocationTraceFixture) =>
  fixture.inputs.filter(
    (input) => input.type === 'FIX' || input.type === 'EVENT_ENTER' || input.type === 'EVENT_EXIT',
  ).length;
const offlineBatch = FIXTURES.filter(
  (fixture) =>
    fixture.inputs.some(
      (input) => input.type === 'NETWORK_DOWN' && (input.target ?? 'PHONE') === 'PHONE',
    ) && !fixture.inputs.some((input) => input.type === 'SERVER_RESPONSE'),
);

describe('out-of-order delivery (trace permutations)', () => {
  for (const fixture of offlineBatch.filter((f) => phoneRecords(f) <= 25)) {
    it(`${fixture.id}: any order inside one upload gives the same result`, async () => {
      const baseline = await runFixture(fixture, new MemoryBackend());
      for (const uploadOrder of ['reverse', 'shuffle'] as const) {
        const permuted = await runFixture(fixture, new MemoryBackend(), { uploadOrder });
        const summary = (o: typeof baseline.observation) =>
          JSON.stringify({
            presence: o.presence,
            sessions: o.sessions.map((s) => [
              s.status,
              s.startAt,
              s.endAt,
              s.endEarliestAt,
              s.endLatestAt,
            ]),
          });
        expect(summary(permuted.observation)).toBe(summary(baseline.observation));
      }
    });
  }
  for (const fixture of offlineBatch) {
    it(`${fixture.id}: record-by-record reversed arrival never creates a contradictory state`, async () => {
      // MemoryBackend throws on any invariant violation (two open sessions, overlap, coordinates).
      const { observation } = await runFixture(fixture, new MemoryBackend(), {
        uploadOrder: 'reverse',
        batchSize: 1,
      });
      expect(checkInvariants(fixture, observation)).toEqual([]);
    });
  }
});
