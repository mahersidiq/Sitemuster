import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { SUPPORTED_LOCALES, type Locale } from '@sitemuster/shared';

import { useLanguage } from '../state/language';
import { spacing } from '../theme';
import { AppButton } from './AppButton';
import { Body, Heading } from './Typography';

const LABEL_KEYS: Record<Locale, 'language.english' | 'language.spanish'> = {
  'en-US': 'language.english',
  'es-US': 'language.spanish',
};

/** Persistent language switch available from Profile (worker) and More (staff). */
export function LanguageSwitcher() {
  const { t } = useTranslation();
  const { activeLocale, chooseLocale } = useLanguage();
  return (
    <View style={styles.container}>
      <Heading>{t('language.changeTitle')}</Heading>
      <Body>{t('language.currentValue', { language: t(LABEL_KEYS[activeLocale]) })}</Body>
      <View style={styles.row}>
        {SUPPORTED_LOCALES.map((locale) => (
          <View key={locale} style={styles.cell}>
            <AppButton
              label={t(LABEL_KEYS[locale])}
              accessibilityLabel={t('language.a11ySelect', { language: t(LABEL_KEYS[locale]) })}
              variant={locale === activeLocale ? 'primary' : 'secondary'}
              onPress={() => void chooseLocale(locale)}
              testID={`language-switch-${locale}`}
            />
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.sm },
  row: { flexDirection: 'row', gap: spacing.sm },
  cell: { flex: 1 },
});
