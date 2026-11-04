import { describe, expect, it } from 'vitest';

import { isLocale, suggestLocale, SUPPORTED_LOCALES } from './locale.ts';

describe('locale', () => {
  it('supports exactly en-US and es-US at launch', () => {
    expect([...SUPPORTED_LOCALES]).toEqual(['en-US', 'es-US']);
    expect(isLocale('es-US')).toBe(true);
    expect(isLocale('es')).toBe(false);
    expect(isLocale(undefined)).toBe(false);
  });

  it.each([
    ['es-MX', 'es-US'],
    ['es', 'es-US'],
    ['es_US', 'es-US'],
    ['en-GB', 'en-US'],
    ['fr-FR', 'en-US'],
    [undefined, 'en-US'],
    ['', 'en-US'],
  ])('suggests %j -> %j (a suggestion only; the user still chooses)', (tag, expected) => {
    expect(suggestLocale(tag)).toBe(expected);
  });
});
