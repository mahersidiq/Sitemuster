import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { SUPPORTED_LOCALES, type Locale } from '@sitemuster/shared';

import { AppButton } from '../src/components/AppButton';
import { Screen } from '../src/components/Screen';
import { Body, Title } from '../src/components/Typography';
import { useLanguage } from '../src/state/language';

const LABEL_KEYS: Record<Locale, 'language.english' | 'language.spanish'> = {
  'en-US': 'language.english',
  'es-US': 'language.spanish',
};

/** First-launch language choice (decision #2): explicit, never silently forced from the device. */
export default function LanguageScreen() {
  const { t } = useTranslation();
  const { suggestedLocale, chooseLocale } = useLanguage();

  const choose = async (locale: Locale) => {
    await chooseLocale(locale);
    router.replace('/sign-in');
  };

  return (
    <Screen testID="language-screen">
      <Title>{t('language.title')}</Title>
      <Body>{t('language.subtitle')}</Body>
      {SUPPORTED_LOCALES.map((locale) => (
        <AppButton
          key={locale}
          label={t(LABEL_KEYS[locale])}
          accessibilityLabel={t('language.a11ySelect', { language: t(LABEL_KEYS[locale]) })}
          accessibilityHint={locale === suggestedLocale ? t('language.suggested') : undefined}
          variant={locale === suggestedLocale ? 'primary' : 'secondary'}
          onPress={() => void choose(locale)}
          testID={`choose-${locale}`}
        />
      ))}
      <Body>{t('language.suggestedValue', { language: t(LABEL_KEYS[suggestedLocale]) })}</Body>
    </Screen>
  );
}
