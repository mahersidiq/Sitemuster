import { describe, expect, it } from 'vitest';

import type { MapMarker, WorkforceMember } from '../api/types';
import { markerAge, rosterGroup, serverNow, wholeMinutes } from './format';

const EVALUATED = '2026-11-04T15:00:00.000Z';
const marker = (minutesOld: number, expiresInMinutes: number, fresh = true): MapMarker => ({
  worker_id: 'a0000000-0000-4000-8000-000000000001',
  legal_name: 'Ana Acosta',
  company_name: 'Acme Concrete',
  lat: 29.7605,
  lng: -95.3697,
  accuracy_m: 12,
  observed_at: new Date(Date.parse(EVALUATED) - minutesOld * 60_000).toISOString(),
  expires_at: new Date(Date.parse(EVALUATED) + expiresInMinutes * 60_000).toISOString(),
  fresh,
});
const map = { evaluated_at: EVALUATED, fresh_seconds: 600 };

describe('marker freshness on server time', () => {
  it('a 2-minute-old marker is fresh; after 8 more minutes on screen it is stale', () => {
    const fetchedAt = 1_000_000; // the phone clock is irrelevant: only elapsed time counts
    expect(markerAge(marker(2, 18), map, fetchedAt, fetchedAt)).toEqual({
      ageMs: 120_000,
      fresh: true,
      expired: false,
    });
    const later = markerAge(marker(2, 18), map, fetchedAt, fetchedAt + 8 * 60_000);
    expect(later.fresh).toBe(false);
    expect(later.expired).toBe(false);
  });

  it('a marker past its expiry disappears; one the server called stale stays stale', () => {
    const fetchedAt = 5_000;
    expect(markerAge(marker(15, 5), map, fetchedAt, fetchedAt + 5 * 60_000).expired).toBe(true);
    expect(markerAge(marker(1, 19, false), map, fetchedAt, fetchedAt).fresh).toBe(false);
  });

  it('a phone clock that jumps backwards never makes time run backwards', () => {
    expect(serverNow(EVALUATED, 10_000, 4_000)).toBe(Date.parse(EVALUATED));
    expect(wholeMinutes(-5)).toBe(0);
    expect(wholeMinutes(119_999)).toBe(1);
  });
});

describe('roster groups', () => {
  const member = (overrides: Partial<WorkforceMember>): WorkforceMember => ({
    worker_id: 'a0000000-0000-4000-8000-000000000001',
    enrollment_id: 'e0000000-0000-4000-8000-000000000001',
    legal_name: 'Ana Acosta',
    managed_identity: false,
    company_id: null,
    company_name: null,
    trade: null,
    employer_status: 'VERIFIED',
    presence: 'NONE',
    counted: false,
    source: null,
    witnessed: false,
    arrived_at: null,
    last_seen_at: null,
    session_status: null,
    needs_review: false,
    tracking: 'NO_PHONE',
    ...overrides,
  });

  it('counted first; silence is unknown (not gone); review and pending stay visible', () => {
    expect(rosterGroup(member({ counted: true, presence: 'ONSITE_ESTIMATED' }))).toBe('ONSITE');
    expect(rosterGroup(member({ presence: 'PRESENCE_UNKNOWN' }))).toBe('UNKNOWN');
    expect(rosterGroup(member({ presence: 'UNRESOLVED', needs_review: true }))).toBe('REVIEW');
    expect(rosterGroup(member({ presence: 'ARRIVING' }))).toBe('PENDING');
    expect(rosterGroup(member({ presence: 'UNSCHEDULED_PENDING' }))).toBe('PENDING');
    expect(rosterGroup(member({ presence: 'OFFSITE' }))).toBe('NOT_ONSITE');
    expect(rosterGroup(member({}))).toBe('NOT_ONSITE');
  });
});
