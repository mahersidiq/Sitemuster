/** Supported launch locales (docs/spec/08-i18n.md). */
export const SUPPORTED_LOCALES = ['en-US', 'es-US'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en-US';

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/**
 * Suggest (never force) a launch locale from a device language tag such as `es-MX` or `en`.
 * The first-launch screen still asks the user to choose explicitly.
 */
export function suggestLocale(languageTag: string | null | undefined): Locale {
  const primary = (languageTag ?? '').trim().toLowerCase().split(/[-_]/)[0];
  return primary === 'es' ? 'es-US' : 'en-US';
}
