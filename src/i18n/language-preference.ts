import * as SecureStore from 'expo-secure-store';

import { isLocale, type Locale } from '@sitemuster/shared';

/**
 * The chosen UI language is stored on-device (SecureStore, AFTER_FIRST_UNLOCK) so the first-launch
 * choice persists before sign-in. After sign-in it is also saved to the profile (Milestone 03).
 */
const STORAGE_KEY = 'sitemuster.locale.v1';

export async function loadLanguagePreference(): Promise<Locale | null> {
  const stored = await SecureStore.getItemAsync(STORAGE_KEY, {
    keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
  });
  return isLocale(stored) ? stored : null;
}

export async function saveLanguagePreference(locale: Locale): Promise<void> {
  await SecureStore.setItemAsync(STORAGE_KEY, locale, {
    keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
  });
}
