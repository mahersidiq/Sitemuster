import { describe, expect, it } from '@jest/globals';

import { queryKeysFor } from './ProjectLive';

const PROJECT = 'a0000000-0000-4000-8000-000000000001';
const keys = (
  ...scopes: Parameters<typeof queryKeysFor>[1] extends ReadonlySet<infer S> ? S[] : never
) => queryKeysFor(PROJECT, new Set(scopes)).map((key) => JSON.stringify(key));
const key = (...parts: string[]) => JSON.stringify(parts);

describe('which reads a live message makes stale', () => {
  it('an enrollment change refetches the map too (a revoked worker leaves it)', () => {
    expect(keys('ENROLLMENT_CHANGED')).toEqual(
      expect.arrayContaining([
        key('project-map', PROJECT),
        key('workforce', PROJECT),
        key('roster', PROJECT),
        key('dashboard', PROJECT),
      ]),
    );
  });

  it('a workforce change refetches the dashboard, roster, map and visitors; config refetches the project', () => {
    expect(keys('WORKFORCE_CHANGED')).toEqual(
      expect.arrayContaining([
        key('dashboard', PROJECT),
        key('workforce', PROJECT),
        key('project-map', PROJECT),
        key('open-visits', PROJECT),
      ]),
    );
    expect(keys('PROJECT_CONFIG_CHANGED')).toEqual(
      expect.arrayContaining([key('project', PROJECT), key('project-map', PROJECT)]),
    );
  });

  it('a full resync refetches every project read; nothing asked, nothing refetched', () => {
    expect(keys('ALL')).toHaveLength(7);
    expect(keys()).toEqual([]);
  });
});
