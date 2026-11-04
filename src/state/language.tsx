import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { I18nextProvider } from 'react-i18next';
import { getLocales } from 'expo-localization';

import { suggestLocale, type Locale } from '@sitemuster/shared';

import type { AppEnv } from '../config/runtime-env';
import { createI18n } from '../i18n';
import { loadLanguagePreference, saveLanguagePreference } from '../i18n/language-preference';

interface LanguageState {
  /** null until the user has made an explicit first-launch choice. */
  chosenLocale: Locale | null;
  /** Locale used for rendering (chosen, else the device suggestion). */
  activeLocale: Locale;
  suggestedLocale: Locale;
  ready: boolean;
  chooseLocale: (locale: Locale) => Promise<void>;
}

const LanguageContext = createContext<LanguageState | null>(null);

export function LanguageProvider({ appEnv, children }: { appEnv: AppEnv; children: ReactNode }) {
  const suggestedLocale = useMemo(() => suggestLocale(getLocales()[0]?.languageTag), []);
  const [chosenLocale, setChosenLocale] = useState<Locale | null>(null);
  const [ready, setReady] = useState(false);
  const activeLocale = chosenLocale ?? suggestedLocale;
  const i18n = useMemo(() => createI18n(activeLocale, appEnv), [activeLocale, appEnv]);

  useEffect(() => {
    let cancelled = false;
    loadLanguagePreference()
      .then((stored) => {
        if (!cancelled) setChosenLocale(stored);
      })
      .catch(() => {
        // Unreadable preference (e.g. before first unlock): ask again rather than guess.
        if (!cancelled) setChosenLocale(null);
      })
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const chooseLocale = useCallback(async (locale: Locale) => {
    await saveLanguagePreference(locale);
    setChosenLocale(locale);
  }, []);

  const value = useMemo(
    () => ({ chosenLocale, activeLocale, suggestedLocale, ready, chooseLocale }),
    [chosenLocale, activeLocale, suggestedLocale, ready, chooseLocale],
  );

  return (
    <LanguageContext.Provider value={value}>
      <I18nextProvider i18n={i18n}>{children}</I18nextProvider>
    </LanguageContext.Provider>
  );
}

export function useLanguage(): LanguageState {
  const value = useContext(LanguageContext);
  if (!value) throw new Error('useLanguage must be used inside LanguageProvider');
  return value;
}
