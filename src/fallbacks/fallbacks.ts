import { sha256 } from '@noble/hashes/sha2.js';

import {
  addDays,
  base64UrlEncode,
  BadgePayloadSchema,
  formatLocalDate,
  localDateOf,
  type OperationResult,
  parseLocalDate,
  PrintedBadgePayloadSchema,
  zonedParts,
  zonedToUtc,
} from '@sitemuster/shared';

import { effectiveOutcome, type OutboxEntry } from '../outbox/outbox';

/**
 * Pure helpers for the kiosk, crew, visitor and correction screens (Milestone 08).
 */

/** What a scanned code is: an offline phone badge, a printed badge, or not a badge at all. */
export function classifyBadge(
  raw: string,
): { code: string; kind: 'DYNAMIC_APP' | 'PRINTED' } | null {
  const code = raw.trim();
  if (BadgePayloadSchema.safeParse(code).success) return { code, kind: 'DYNAMIC_APP' };
  if (PrintedBadgePayloadSchema.safeParse(code).success) return { code, kind: 'PRINTED' };
  return null;
}

/**
 * The kiosk id this phone registers for one project: derived from the installation and the
 * project, so the same phone used at two projects cannot be linked by its kiosk ids.
 */
export function kioskPublicId(installationHash: string, projectId: string): string {
  return base64UrlEncode(
    sha256(new TextEncoder().encode(`kiosk|${installationHash}|${projectId}`)),
  );
}

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;

function minutes(text: string): number | null {
  const match = HHMM.exec(text.trim());
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/**
 * Corrected times typed in the project's time zone → UTC instants. A departure earlier than the
 * arrival is the next day (a night shift). Empty fields are "unchanged" (null); anything invalid
 * returns null as a whole.
 */
export function correctionTimes(input: {
  date: string;
  start: string;
  end: string;
  timeZone: string;
}): { startAt: string | null; endAt: string | null } | null {
  let date;
  try {
    date = parseLocalDate(input.date.trim());
  } catch {
    return null;
  }
  const start = input.start.trim() === '' ? null : minutes(input.start);
  const end = input.end.trim() === '' ? null : minutes(input.end);
  if ((input.start.trim() !== '' && start === null) || (input.end.trim() !== '' && end === null)) {
    return null;
  }
  if (start === null && end === null) return null;
  const startAt = start === null ? null : zonedToUtc(date, start, input.timeZone);
  let endAt = end === null ? null : zonedToUtc(date, end, input.timeZone);
  if (endAt !== null && start !== null && end !== null && end <= start) {
    endAt = zonedToUtc(addDays(date, 1), end, input.timeZone);
  }
  return {
    startAt: startAt === null ? null : new Date(startAt).toISOString(),
    endAt: endAt === null ? null : new Date(endAt).toISOString(),
  };
}

/**
 * Corrected times for an EXISTING visit, typed in the project's time zone (review finding on
 * PR #10). The arrival is on the visit's arrival date. A departure is the first moment at that
 * clock time after the arrival (the corrected one, else the recorded one), so a departure-only fix
 * on a 22:00–06:00 visit lands on the next day. Empty fields are "unchanged" (null); anything
 * invalid returns null as a whole.
 */
export function visitCorrectionTimes(input: {
  visitStartAt: string;
  start: string;
  end: string;
  timeZone: string;
}): { startAt: string | null; endAt: string | null } | null {
  const start = input.start.trim() === '' ? null : minutes(input.start);
  const end = input.end.trim() === '' ? null : minutes(input.end);
  if ((input.start.trim() !== '' && start === null) || (input.end.trim() !== '' && end === null)) {
    return null;
  }
  if (start === null && end === null) return null;
  const visitStart = Date.parse(input.visitStartAt);
  if (Number.isNaN(visitStart)) return null;
  const date = localDateOf(visitStart, input.timeZone);
  const startAt = start === null ? null : zonedToUtc(date, start, input.timeZone);
  const after = startAt ?? visitStart;
  let endAt: number | null = null;
  if (end !== null) {
    endAt = zonedToUtc(date, end, input.timeZone);
    // At most two days on: a visit can never be corrected to end before it began.
    for (let day = 1; endAt <= after && day <= 2; day += 1) {
      endAt = zonedToUtc(addDays(date, day), end, input.timeZone);
    }
  }
  return {
    startAt: startAt === null ? null : new Date(startAt).toISOString(),
    endAt: endAt === null ? null : new Date(endAt).toISOString(),
  };
}

/** The project-local date (YYYY-MM-DD) and time (HH:MM) of an instant. */
export function localDateTime(instant: string, timeZone: string): { date: string; time: string } {
  const t = Date.parse(instant);
  const parts = zonedParts(t, timeZone);
  return {
    date: formatLocalDate(localDateOf(t, timeZone)),
    time: `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`,
  };
}

export type OutcomeView =
  | { kind: 'PENDING' }
  | { kind: 'ACCEPTED'; workerId: string | null; review: boolean }
  | { kind: 'REJECTED'; reason: string };

/** How one outbox entry reads on screen: never "confirmed" before the server said so. */
export function outcomeOf(entry: OutboxEntry): OutcomeView {
  const outcome = effectiveOutcome(entry);
  const result: OperationResult | null = entry.result;
  if (outcome === 'PENDING') return { kind: 'PENDING' };
  if (outcome === 'ACCEPTED') {
    return {
      kind: 'ACCEPTED',
      workerId: result?.worker_id ?? null,
      review: result?.review === true,
    };
  }
  return { kind: 'REJECTED', reason: result?.reason ?? 'other' };
}
