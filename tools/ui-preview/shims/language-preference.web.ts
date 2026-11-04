import { isLocale, type Locale } from '@sitemuster/shared';

/**
 * UI-preview shim (web render only): in-memory stand-in for the secure-store-backed preference.
 * Never shipped: the native app uses src/i18n/language-preference.ts.
 */
let stored: Locale | null = null;

export async function loadLanguagePreference(): Promise<Locale | null> {
  return isLocale(stored) ? stored : null;
}

export async function saveLanguagePreference(locale: Locale): Promise<void> {
  stored = locale;
}
