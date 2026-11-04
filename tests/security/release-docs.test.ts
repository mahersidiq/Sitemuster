import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ANDROID_BLOCKED_PERMISSIONS, ANDROID_TRACKING_PERMISSIONS } from '../../app.config';
import { REPO_ROOT, readRepoFile } from '../support/repo';

/**
 * Milestone 13 release documents are part of the release gate, so they are checked like code:
 * the phone checklist covers every native-only scenario of docs/spec/07 and the device matrix of
 * docs/spec/03; the readiness board never shows PASS without evidence and never claims readiness
 * while a gate is open; the review notes carry no credential; the store and pilot documents cover
 * what the specs require.
 */
const SPEC_07 = readRepoFile('docs/spec/07-edge-cases.md');
const SPEC_03 = readRepoFile('docs/spec/03-location-engine.md');
const CHECKLIST = readRepoFile('docs/release/phone-test-checklist.md');
const BOARD = readRepoFile('docs/release/release-readiness.md');
const PILOT = readRepoFile('docs/release/field-pilot-protocol.md');
const SIGN_OFF = readRepoFile('docs/release/pilot/pilot-sign-off.md');
const NOTES = readRepoFile('docs/release/apple-review-notes.md');
const STORE = readRepoFile('docs/release/store-submission.md');
const VIDEO = readRepoFile('docs/release/play-background-location-video.md');
const NATIVE_EN = JSON.parse(readRepoFile('locales/native/en.json')) as {
  ios: Record<string, string>;
};
const APP_EN = JSON.parse(readRepoFile('src/i18n/locales/en-US.json')) as {
  tracking: { disclosure: { body: string } };
};

const MANUAL_VALIDATION =
  /physical|manual|OEM|checklist|pilot|rehearsal|locked iOS|network payload|network trace|upgrade E2E|device test/i;

function spec07Rows(): { scenario: string; validation: string }[] {
  return SPEC_07.split('\n')
    .filter((line) => line.startsWith('| ') && !line.startsWith('| Scenario'))
    .map((line) => line.split('|').map((cell) => cell.trim()))
    .filter((cells) => cells.length >= 5)
    .map((cells) => ({ scenario: cells[1] ?? '', validation: cells[3] ?? '' }));
}

describe('phone test checklist', () => {
  it('covers every native-only scenario of docs/spec/07 by name', () => {
    const manual = spec07Rows().filter((row) => MANUAL_VALIDATION.test(row.validation));
    expect(manual.length).toBeGreaterThanOrEqual(15);
    const missing = manual.filter((row) => !CHECKLIST.includes(`| ${row.scenario} |`));
    expect(missing.map((row) => row.scenario)).toEqual([]);
  });

  it('covers every item of the docs/spec/03 device validation matrix', () => {
    const matrix = /## Device validation matrix\s+Test iPhone and Android: ([^.]+)\./.exec(SPEC_03);
    const items = (matrix?.[1] ?? '').split(',').map((item) => item.trim());
    expect(items.length).toBeGreaterThanOrEqual(18);
    expect(items.filter((item) => !CHECKLIST.includes(`| ${item} |`))).toEqual([]);
  });

  it('starts every result as not executed: nothing is marked passed on a device by this agent', () => {
    expect(CHECKLIST).toContain('NOT_EXECUTED_PHYSICAL_DEVICE');
    expect(CHECKLIST).not.toMatch(/\|\s*PASS\s*\|/);
  });
});

describe('release readiness board', () => {
  const ALLOWED = [
    'PASS',
    'NOT VERIFIED',
    'BLOCKED',
    'NOT_EXECUTED_PHYSICAL_DEVICE',
    'FIELD_PILOT_PENDING',
  ];
  const rows = BOARD.split('\n')
    .filter((line) => line.startsWith('| ') && !line.startsWith('| Gate'))
    .map((line) => line.split('|').map((cell) => cell.trim()))
    .map((cells) => ({ gate: cells[1] ?? '', status: cells[2] ?? '', evidence: cells[3] ?? '' }));

  it('uses only the defined statuses', () => {
    expect(rows.length).toBeGreaterThanOrEqual(20);
    expect(rows.filter((row) => !ALLOWED.includes(row.status))).toEqual([]);
  });

  it('shows PASS only with evidence that exists in the repository', () => {
    for (const row of rows.filter((entry) => entry.status === 'PASS')) {
      const cited = [...row.evidence.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? '');
      expect(cited.length, `${row.gate} needs evidence`).toBeGreaterThan(0);
      for (const item of cited) {
        if (/^\d{3}_[a-z0-9_]+$/.test(item)) {
          expect(
            existsSync(join(REPO_ROOT, `supabase/tests/database/${item}.test.sql`)),
            item,
          ).toBe(true);
        } else if (item.includes('/') && !item.includes(' ')) {
          expect(existsSync(join(REPO_ROOT, item)), item).toBe(true);
        }
      }
    }
  });

  it('never claims readiness while a gate is open or the pilot is unsigned', () => {
    const open = rows.some((row) => row.status !== 'PASS');
    const signed = /^\*\*Current status: SIGNED/m.test(SIGN_OFF);
    if (open || !signed) {
      expect(BOARD).toContain('**Overall: NOT READY FOR PUBLIC RELEASE');
      expect(BOARD).toContain('FIELD_PILOT_PENDING');
    }
    expect(SIGN_OFF).toContain('**Current status: `FIELD_PILOT_PENDING` — not signed.**');
  });

  it('lists the Milestone 13 acceptance tests', () => {
    for (const gate of [
      'Reproducible EAS builds',
      'Reviewer demo cannot affect real data',
      'real devices (network capture)',
      'App Store and Google Play requirements documented',
      '30-workday field pilot, owner-signed',
    ]) {
      expect(BOARD).toContain(gate);
    }
  });
});

describe('field pilot protocol', () => {
  it('is marked pending and measures what spec 10 and spec 01 require', () => {
    expect(PILOT).toContain('**Status: `FIELD_PILOT_PENDING`.**');
    for (const measure of [
      'false positive',
      'battery',
      'adoption by mode',
      'SMS delivery success',
      'kiosk offline recovery',
      'report confirmation rate',
      'day-close time',
      'detected-event latency',
      'missing events',
      'correction burden',
      'at least two subcontractors',
      '30 workdays',
    ]) {
      expect(PILOT.toLowerCase(), measure).toContain(measure.toLowerCase());
    }
    // The logs hold counts and codes only: no column for a name, phone number or e-mail.
    for (const file of ['daily-log-template.csv', 'device-register-template.csv']) {
      const columns = (readRepoFile(`docs/release/pilot/${file}`).split('\n')[0] ?? '').split(',');
      expect(columns.length, file).toBeGreaterThan(5);
      expect(
        columns.filter(
          (column) => /(^|_)(name|email)($|_)/.test(column) || /^phone(_number)?$/.test(column),
        ),
        file,
      ).toEqual([]);
    }
  });
});

describe('store review texts', () => {
  it('explain sign-in, the demo label, background location, push, camera and deletion', () => {
    for (const topic of [
      'HOW TO SIGN IN',
      'DEMO DATA AND SIMULATION',
      'WHY THE APP USES LOCATION "ALWAYS"',
      'ACCOUNT DELETION',
      'not a certified life-safety system',
      'It is not GPS',
    ]) {
      expect(NOTES).toContain(topic);
    }
  });

  it('carry no credential: no phone number, fixed code or authenticator secret', () => {
    expect(NOTES).not.toMatch(/\+?1?[\s(.-]*\d{3}[\s).-]*\d{3}[\s.-]*\d{4}/);
    expect(NOTES).not.toMatch(/\b\d{6}\b/);
    expect(NOTES).not.toMatch(/\b[A-Z2-7]{16,}\b/);
    for (const doc of [readRepoFile('docs/release/reviewer-demo.md'), VIDEO, STORE]) {
      expect(doc).not.toMatch(/\b[A-Z2-7]{16,}\b/);
    }
  });

  it('justify every Android permission the app requests and list the removed ones', () => {
    for (const permission of [...ANDROID_TRACKING_PERMISSIONS, 'CAMERA']) {
      expect(STORE, permission).toContain(`\`${permission}\``);
    }
    for (const permission of ANDROID_BLOCKED_PERMISSIONS) {
      expect(STORE).toContain(permission.replace('android.permission.', ''));
    }
  });

  it('show every iOS permission text', () => {
    for (const [key, text] of Object.entries(NATIVE_EN.ios)) {
      expect(STORE).toContain(`\`${key}\``);
      expect(STORE).toContain(text.replace(/\\"/g, '"'));
    }
  });

  it('describe the Play background-location video on a real device with the prominent disclosure', () => {
    for (const phrase of [
      'real Android phone',
      'Prominent disclosure',
      'Allow all the time',
      'simulation',
      'NOT_EXECUTED_PHYSICAL_DEVICE',
    ]) {
      expect(VIDEO).toContain(phrase);
    }
  });

  it('match the in-app disclosure to the Play wording', () => {
    expect(APP_EN.tracking.disclosure.body).toContain('collects location data');
    expect(APP_EN.tracking.disclosure.body).toContain('even when the app is closed or not in use');
  });
});
