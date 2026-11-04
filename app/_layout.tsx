import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { I18nextProvider, useTranslation } from 'react-i18next';
import { getLocales } from 'expo-localization';

import { suggestLocale } from '@sitemuster/shared';

import { Banner } from '../src/components/Banner';
import { Screen } from '../src/components/Screen';
import { Title } from '../src/components/Typography';
import { readRuntimeEnv } from '../src/config/env';
import { createI18n } from '../src/i18n';
import { initMonitoring } from '../src/monitoring/sentry';
import { AppProviders } from '../src/state/AppProviders';
import { colors, spacing } from '../src/theme';

// Initialise privacy-scrubbed crash monitoring as early as possible.
const bootEnv = readRuntimeEnv();
if (bootEnv.ok) initMonitoring(bootEnv.env);

/** Blocking screen shown when a staging/production build lacks required configuration. */
function ConfigurationError() {
  const i18n = useMemo(
    () => createI18n(suggestLocale(getLocales()[0]?.languageTag), 'production'),
    [],
  );
  return (
    <I18nextProvider i18n={i18n}>
      <ConfigurationErrorBody />
    </I18nextProvider>
  );
}

function ConfigurationErrorBody() {
  const { t } = useTranslation();
  return (
    <Screen testID="configuration-error">
      <Title>{t('errors.configTitle')}</Title>
      <Banner tone="danger" text={t('errors.configBody')} />
    </Screen>
  );
}

/** Development builds show a persistent strip so screenshots/devices are never mistaken for production. */
function DevelopmentStrip() {
  const { t } = useTranslation();
  return (
    <View style={styles.devStrip} testID="development-strip">
      <Text style={styles.devStripText}>{t('common.developmentWarning')}</Text>
    </View>
  );
}

export default function RootLayout() {
  const runtimeEnv = useMemo(() => readRuntimeEnv(), []);
  if (!runtimeEnv.ok) return <ConfigurationError />;
  const env = runtimeEnv.env;
  return (
    <AppProviders env={env}>
      <StatusBar style="dark" />
      <View style={styles.root}>
        {env.appEnv === 'development' ? <DevelopmentStrip /> : null}
        <View style={styles.root}>
          <Stack screenOptions={{ headerShown: false }} />
        </View>
      </View>
    </AppProviders>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  devStrip: {
    backgroundColor: colors.warningBackground,
    paddingTop: spacing.xl,
    paddingBottom: spacing.xs,
    alignItems: 'center',
  },
  devStripText: { color: colors.warningText, fontSize: 13, fontWeight: '600' },
});
