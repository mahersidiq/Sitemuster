import { describe, expect, it } from 'vitest';

import { buildBadgePayload } from '@sitemuster/shared';

import type { OutboxEntry } from '../outbox/outbox';
import {
  classifyBadge,
  correctionTimes,
  kioskPublicId,
  localDateTime,
  outcomeOf,
  visitCorrectionTimes,
} from './fallbacks';

const DEVICE = '5d000000-0000-4000-8000-0000000000a1';
const PROJECT = '0a000000-0000-4000-8000-0000000000a1';

describe('kiosk helpers', () => {
  it('tells phone badges, printed badges and anything else apart', () => {
    const phone = buildBadgePayload(new Uint8Array(32).fill(1), DEVICE, PROJECT, 1_793_000_000);
    expect(classifyBadge(` ${phone} `)).toEqual({ code: phone, kind: 'DYNAMIC_APP' });
    expect(classifyBadge('SMP1.0123456789abcdefABCDEF_-xy')?.kind).toBe('PRINTED');
    expect(classifyBadge('SMO1.orientation.code')).toBeNull();
    expect(classifyBadge('https://example.test')).toBeNull();
  });

  it('derives a different kiosk id per project for the same phone', () => {
    const a = kioskPublicId('install', PROJECT);
    const b = kioskPublicId('install', '0b000000-0000-4000-8000-0000000000b1');
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
    expect(kioskPublicId('install', PROJECT)).toBe(a);
  });
});

describe('correction times (project time zone)', () => {
  it('converts local times to UTC, with a night-shift departure on the next day', () => {
    expect(
      correctionTimes({
        date: '2026-11-04',
        start: '06:30',
        end: '15:00',
        timeZone: 'America/Chicago',
      }),
    ).toEqual({ startAt: '2026-11-04T12:30:00.000Z', endAt: '2026-11-04T21:00:00.000Z' });
    expect(
      correctionTimes({
        date: '2026-11-04',
        start: '20:00',
        end: '04:00',
        timeZone: 'America/Chicago',
      }),
    ).toEqual({ startAt: '2026-11-05T02:00:00.000Z', endAt: '2026-11-05T10:00:00.000Z' });
    expect(
      correctionTimes({ date: '2026-11-04', start: '', end: '15:00', timeZone: 'America/Chicago' }),
    ).toEqual({ startAt: null, endAt: '2026-11-04T21:00:00.000Z' });
  });

  it('refuses invalid input instead of guessing', () => {
    expect(
      correctionTimes({ date: '2026-11-04', start: '25:00', end: '', timeZone: 'UTC' }),
    ).toBeNull();
    expect(
      correctionTimes({ date: 'yesterday', start: '06:00', end: '', timeZone: 'UTC' }),
    ).toBeNull();
    expect(correctionTimes({ date: '2026-11-04', start: '', end: '', timeZone: 'UTC' })).toBeNull();
  });

  it('an existing visit keeps its own dates: a night shift departure is the next day (review on PR #10)', () => {
    const tz = 'America/Chicago';
    // 22:00 CST on Nov 3 → departure-only fix "07:00" is 07:00 on Nov 4, after the arrival.
    expect(
      visitCorrectionTimes({
        visitStartAt: '2026-11-04T04:00:00Z',
        start: '',
        end: '07:00',
        timeZone: tz,
      }),
    ).toEqual({ startAt: null, endAt: '2026-11-04T13:00:00.000Z' });
    // A day visit stays on its day.
    expect(
      visitCorrectionTimes({
        visitStartAt: '2026-11-04T13:00:00Z',
        start: '',
        end: '16:00',
        timeZone: tz,
      }),
    ).toEqual({ startAt: null, endAt: '2026-11-04T22:00:00.000Z' });
    // Both ends: the arrival on the visit's date, the departure after the corrected arrival.
    expect(
      visitCorrectionTimes({
        visitStartAt: '2026-11-04T04:00:00Z',
        start: '21:30',
        end: '05:00',
        timeZone: tz,
      }),
    ).toEqual({ startAt: '2026-11-04T03:30:00.000Z', endAt: '2026-11-04T11:00:00.000Z' });
    // Arrival only.
    expect(
      visitCorrectionTimes({
        visitStartAt: '2026-11-04T13:00:00Z',
        start: '06:30',
        end: '',
        timeZone: tz,
      }),
    ).toEqual({ startAt: '2026-11-04T12:30:00.000Z', endAt: null });
    // Across the fall-back night (Nov 1): 22:00 CDT Oct 31 → 06:00 CST Nov 1.
    expect(
      visitCorrectionTimes({
        visitStartAt: '2026-11-01T03:00:00Z',
        start: '',
        end: '06:00',
        timeZone: tz,
      }),
    ).toEqual({ startAt: null, endAt: '2026-11-01T12:00:00.000Z' });
    expect(
      visitCorrectionTimes({
        visitStartAt: '2026-11-04T04:00:00Z',
        start: '',
        end: '7pm',
        timeZone: tz,
      }),
    ).toBeNull();
    expect(
      visitCorrectionTimes({
        visitStartAt: '2026-11-04T04:00:00Z',
        start: '',
        end: '',
        timeZone: tz,
      }),
    ).toBeNull();
  });

  it('shows an instant in project-local date and time', () => {
    expect(localDateTime('2026-11-04T12:30:00Z', 'America/Chicago')).toEqual({
      date: '2026-11-04',
      time: '06:30',
    });
  });
});

describe('outcomes on screen', () => {
  const entry = (patch: Partial<OutboxEntry>): OutboxEntry =>
    ({ status: 'PENDING', result: null, ...patch }) as OutboxEntry;

  it('waiting is never shown as confirmed; a resend shows the first outcome', () => {
    expect(outcomeOf(entry({}))).toEqual({ kind: 'PENDING' });
    expect(
      outcomeOf(
        entry({
          status: 'ACCEPTED',
          result: {
            event_uuid: 'e',
            status: 'accepted',
            reason: null,
            worker_id: 'w',
            review: true,
          },
        }),
      ),
    ).toEqual({ kind: 'ACCEPTED', workerId: 'w', review: true });
    expect(
      outcomeOf(
        entry({
          status: 'DUPLICATE',
          result: {
            event_uuid: 'e',
            status: 'duplicate',
            reason: 'BADGE_REPLAY',
            original_status: 'rejected',
          },
        }),
      ),
    ).toEqual({ kind: 'REJECTED', reason: 'BADGE_REPLAY' });
  });
});
