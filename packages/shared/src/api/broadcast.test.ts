import { describe, expect, it } from 'vitest';

import { BroadcastSchema, projectTopic } from './broadcast.ts';

const example = {
  schema_version: 1,
  type: 'WORKFORCE_CHANGED',
  project_id: '00000000-0000-4000-8000-000000000001',
  aggregate_version: 148,
  counts: { estimated_onsite: 37, presence_unknown: 2, approved_roster: 74, visitors_onsite: 3 },
  changed_ids: ['11111111-1111-4111-8111-111111111111'],
  occurred_at: '2026-11-03T19:30:00Z',
};

describe('BroadcastSchema (decision #19)', () => {
  it('accepts the exact spec example', () => {
    expect(BroadcastSchema.safeParse(example).success).toBe(true);
  });

  it('rejects any personal data or coordinates in the payload', () => {
    expect(BroadcastSchema.safeParse({ ...example, worker_name: 'Ana' }).success).toBe(false);
    expect(
      BroadcastSchema.safeParse({ ...example, counts: { ...example.counts, lat: 29.7 } }).success,
    ).toBe(false);
  });

  it('rejects negative/non-integer counts and more than 100 changed ids', () => {
    expect(
      BroadcastSchema.safeParse({ ...example, counts: { estimated_onsite: -1 } }).success,
    ).toBe(false);
    expect(
      BroadcastSchema.safeParse({ ...example, counts: { estimated_onsite: 1.5 } }).success,
    ).toBe(false);
    expect(
      BroadcastSchema.safeParse({
        ...example,
        changed_ids: Array.from({ length: 101 }, () => example.changed_ids[0]),
      }).success,
    ).toBe(false);
  });

  it('builds private project topics only from valid UUIDs', () => {
    expect(projectTopic(example.project_id)).toBe(`project:${example.project_id}`);
    expect(() => projectTopic('project-b')).toThrow();
  });
});
