import { describe, expect, it } from 'vitest';

import {
  BULK_APPROVE_RESULTS,
  ORGANIZATION_ROLES,
  PROJECT_STAFF_ROLES,
  PROJECT_STATUSES,
} from '@sitemuster/shared';

import { KNOWN_API_ERRORS, SENSITIVE_CHANGES } from '../../src/api/errors';
import enUS from '../../src/i18n/locales/en-US.json';
import esUS from '../../src/i18n/locales/es-US.json';
import { NEXT_STATUSES } from '../../src/projects/lifecycle';
import { US_TIME_ZONES } from '../../src/projects/timezones';
import { flatten, type Dictionary } from './parity';

/**
 * Screens build some keys at runtime (`apiErrors.${code}`, `roles.${role}` …). Every member of
 * those families must exist in BOTH languages, otherwise a user would see a raw key.
 */
const SCHEDULE_ERRORS = [
  'SHIFT_NEEDS_DAYS',
  'WORK_WINDOW_REQUIRED',
  'TOO_MANY_WORK_WINDOWS',
  'INVALID_WORK_WINDOW_WEEKDAY',
  'INVALID_WORK_WINDOW_TIME',
  'EMPTY_WORK_WINDOW',
  'OVERLAPPING_WORK_WINDOWS',
];

const families: Record<string, readonly string[]> = {
  enrollmentStatus: ['PENDING', 'APPROVED', 'REJECTED', 'REVOKED'],
  employerStatus: ['PENDING_CONFIRMATION', 'VERIFIED', 'REJECTED'],
  bulkResult: [
    ...BULK_APPROVE_RESULTS,
    'VERIFIED',
    'REJECTED',
    'UNCHANGED',
    'NO_COMPANY',
    'NOT_ACTIVE',
  ],
  'workers.consent': ['DIGITAL', 'SUPERVISED'],
  apiErrors: KNOWN_API_ERRORS,
  scheduleErrors: SCHEDULE_ERRORS,
  sensitive: SENSITIVE_CHANGES,
  projectStatus: PROJECT_STATUSES,
  projectStatusHelp: PROJECT_STATUSES,
  'project.statusAction': [...new Set(Object.values(NEXT_STATUSES).flat())],
  roles: PROJECT_STAFF_ROLES,
  roleHelp: PROJECT_STAFF_ROLES,
  orgRoles: ORGANIZATION_ROLES,
  'timezone.names': US_TIME_ZONES,
  'weekdays.short': ['1', '2', '3', '4', '5', '6', '7'],
  'weekdays.long': ['1', '2', '3', '4', '5', '6', '7'],
  'wizard.steps': ['basics', 'site', 'schedule', 'review'],
  // Milestone 10
  reportStatus: [
    'PENDING_CONFIRMATION',
    'CONFIRMED',
    'DISPUTED',
    'CORRECTION_REQUESTED',
    'NOT_CONFIRMED',
    'SUPERSEDED',
  ],
  reportAction: ['CONFIRM', 'DISPUTE', 'SUBMIT_CORRECTION'],
  'requests.channel': ['WORKER_REQUEST', 'FOREMAN_REQUEST'],
  'hours.requestStatus': ['PENDING', 'APPROVED', 'REJECTED'],
  'hours.csv.statusValue': ['OPEN', 'CLOSED', 'UNRESOLVED', 'ENDED_UNVERIFIED', 'PENDING_APPROVAL'],
};

describe('runtime-built translation keys', () => {
  for (const [locale, dictionary] of [
    ['en-US', enUS],
    ['es-US', esUS],
  ] as const) {
    it(`exist for every enum member in ${locale}`, () => {
      const keys = flatten(dictionary as Dictionary);
      const missing = Object.entries(families).flatMap(([prefix, members]) =>
        members.map((member) => `${prefix}.${member}`).filter((key) => !keys.has(key)),
      );
      expect(missing).toEqual([]);
    });
  }
});
