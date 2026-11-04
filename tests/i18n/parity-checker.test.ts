import { describe, expect, it } from 'vitest';

import { compareDictionaries, placeholders, requiredPluralCategories } from './parity';

describe('parity checker (self-test with synthetic dictionaries)', () => {
  it('knows English and Spanish plural categories from CLDR', () => {
    expect(requiredPluralCategories('en-US')).toEqual(['one', 'other']);
    expect(requiredPluralCategories('es-US')).toEqual(['many', 'one', 'other']);
  });

  it('extracts interpolation placeholders', () => {
    expect(placeholders('Hello {{name}}, {{ count }} items, {{date, datetime}}')).toEqual([
      'count',
      'date',
      'name',
    ]);
  });

  it('reports missing keys, placeholder drift, empty strings and wrong plural sets', () => {
    const problems = compareDictionaries(
      {
        locale: 'en-US',
        dictionary: {
          a: 'A',
          b: 'Hi {{name}}',
          c: { workers_one: '1 worker', workers_other: '{{count}} workers' },
        },
      },
      {
        locale: 'es-US',
        dictionary: {
          b: 'Hola {{nombre}}',
          d: '',
          c: { workers_one: '1 trabajador', workers_other: '{{count}} trabajadores' },
        },
      },
    );
    const text = problems.map((p) => `${p.key}: ${p.problem}`);
    expect(text).toContain('a: missing in es-US');
    expect(text).toContain('d: missing in en-US');
    expect(text).toContain('b: interpolation placeholders differ');
    expect(text).toContain('d: empty in es-US');
    expect(text.some((t) => t.startsWith('c.workers: es-US plural categories'))).toBe(true);
  });

  it('accepts correct EN one/other and ES one/many/other plural sets', () => {
    expect(
      compareDictionaries(
        { locale: 'en-US', dictionary: { w_one: '1 worker', w_other: '{{count}} workers' } },
        {
          locale: 'es-US',
          dictionary: {
            w_one: '1 trabajador',
            w_many: '{{count}} de trabajadores',
            w_other: '{{count}} trabajadores',
          },
        },
      ),
    ).toEqual([]);
  });
});
