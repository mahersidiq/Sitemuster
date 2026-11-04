import { describe, expect, it } from 'vitest';

import enUS from '../../src/i18n/locales/en-US.json';
import esUS from '../../src/i18n/locales/es-US.json';
import { compareDictionaries, flatten, type Dictionary } from './parity';

/** Keys whose value is intentionally identical in both languages (proper nouns / endonyms). */
const SAME_IN_BOTH = new Set([
  'app.name',
  // Android foreground-service notification title: the product name.
  'tracking.notification.title',
  'language.english',
  'language.spanish',
  // Number-format example, language neutral.
  'auth.phonePlaceholder',
  // Unit/format patterns that are written the same way in US Spanish (symbols + placeholders).
  'schedule.shiftLine',
  'site.radiusDecrease',
  'site.radiusIncrease',
  'site.meters',
  'edit.minutes',
  'invitations.summary',
  'workerProjects.employerLine',
  'workers.resultLine',
  // Milestone 10: an hours unit and a "company, date: status." line (placeholders only).
  'reports.hours',
  'foremanReports.sent',
]);

describe('EN/ES UI dictionaries', () => {
  it('have exactly matching keys, placeholders and plural categories', () => {
    expect(
      compareDictionaries(
        { locale: 'en-US', dictionary: enUS as Dictionary },
        { locale: 'es-US', dictionary: esUS as Dictionary },
      ),
    ).toEqual([]);
  });

  it('translate every string (no English copied into the Spanish file)', () => {
    const en = flatten(enUS as Dictionary);
    const es = flatten(esUS as Dictionary);
    const untranslated = [...en.keys()].filter(
      (key) => !SAME_IN_BOTH.has(key) && en.get(key) === es.get(key),
    );
    expect(untranslated).toEqual([]);
  });

  it('contain a non-trivial number of keys', () => {
    expect(flatten(enUS as Dictionary).size).toBeGreaterThan(40);
  });
});
