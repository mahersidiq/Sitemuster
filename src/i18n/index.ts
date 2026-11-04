import { createInstance, type i18n as I18n } from 'i18next';
import { initReactI18next } from 'react-i18next';

import { SUPPORTED_LOCALES, type Locale } from '@sitemuster/shared';

import type { AppEnv } from '../config/runtime-env';
import { resources } from './resources';

/**
 * Creates the i18next instance. English fallback is enabled ONLY in development builds (with a
 * visible warning in the dev banner); staging/production never silently fall back, and CI fails
 * on any missing translation key (tests/i18n).
 */
export function createI18n(locale: Locale, appEnv: AppEnv): I18n {
  const instance = createInstance();
  void instance.use(initReactI18next).init({
    resources,
    lng: locale,
    supportedLngs: [...SUPPORTED_LOCALES],
    nonExplicitSupportedLngs: false,
    load: 'currentOnly',
    fallbackLng: appEnv === 'development' ? 'en-US' : false,
    interpolation: { escapeValue: false },
    returnNull: false,
    initAsync: false,
  });
  return instance;
}
