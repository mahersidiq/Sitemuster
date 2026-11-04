/**
 * EN/ES dictionary parity checker (docs/spec/08-i18n.md "Verification").
 * Compares key sets exactly, interpolation placeholders per key, and plural categories per
 * locale using Intl.PluralRules (en: one/other; es: one/many/other).
 */
export type Dictionary = { [key: string]: string | Dictionary };

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

export function flatten(dictionary: Dictionary, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(dictionary)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out.set(path, value);
    else for (const [k, v] of flatten(value, path)) out.set(k, v);
  }
  return out;
}

export function placeholders(text: string): string[] {
  return [...text.matchAll(/\{\{\s*([\w.]+)\s*(?:,[^}]*)?\}\}/g)].map((m) => m[1] ?? '').sort();
}

export function requiredPluralCategories(locale: string): string[] {
  return [...new Intl.PluralRules(locale).resolvedOptions().pluralCategories].sort();
}

export interface ParityProblem {
  key: string;
  problem: string;
}

export function compareDictionaries(
  base: { locale: string; dictionary: Dictionary },
  other: { locale: string; dictionary: Dictionary },
): ParityProblem[] {
  const problems: ParityProblem[] = [];
  const a = flatten(base.dictionary);
  const b = flatten(other.dictionary);

  const baseNonPlural = [...a.keys()].filter((k) => !PLURAL_SUFFIX.test(k));
  const otherNonPlural = [...b.keys()].filter((k) => !PLURAL_SUFFIX.test(k));
  for (const key of baseNonPlural) {
    if (!b.has(key)) problems.push({ key, problem: `missing in ${other.locale}` });
  }
  for (const key of otherNonPlural) {
    if (!a.has(key)) problems.push({ key, problem: `missing in ${base.locale}` });
  }

  const pluralBases = new Set(
    [...a.keys(), ...b.keys()]
      .filter((k) => PLURAL_SUFFIX.test(k))
      .map((k) => k.replace(PLURAL_SUFFIX, '')),
  );
  for (const pluralBase of pluralBases) {
    for (const { locale, map } of [
      { locale: base.locale, map: a },
      { locale: other.locale, map: b },
    ]) {
      const present = [...map.keys()]
        .filter((k) => k.replace(PLURAL_SUFFIX, '') === pluralBase && PLURAL_SUFFIX.test(k))
        .map((k) => k.match(PLURAL_SUFFIX)?.[1] ?? '')
        .sort();
      const required = requiredPluralCategories(locale);
      if (present.join(',') !== required.join(',')) {
        problems.push({
          key: pluralBase,
          problem: `${locale} plural categories [${present.join(',')}] != required [${required.join(',')}]`,
        });
      }
    }
  }

  const allKeys = new Set([...a.keys(), ...b.keys()]);
  for (const key of allKeys) {
    const left = a.get(key);
    const right = b.get(key);
    if (left !== undefined && left.trim() === '')
      problems.push({ key, problem: `empty in ${base.locale}` });
    if (right !== undefined && right.trim() === '')
      problems.push({ key, problem: `empty in ${other.locale}` });
    if (left === undefined || right === undefined) continue;
    if (PLURAL_SUFFIX.test(key)) continue;
    if (placeholders(left).join(',') !== placeholders(right).join(',')) {
      problems.push({ key, problem: 'interpolation placeholders differ' });
    }
  }
  return problems;
}
