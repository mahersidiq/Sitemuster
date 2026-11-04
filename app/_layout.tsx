import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useMemo } from 'react';
import { I18nextProvider, useTranslation } from 'react-i18next';
import { getLocales } from 'expo-localization';

import { suggestLocale } from '@sitemuster/shared';

import { Banner } from '../src/components/Banner';
import { Screen } from '../src/components/Screen';
import { Body, Title } from '../src/components/Typography';
import { readRuntimeEnv } from '../src/config/env';
import { createI18n } from '../src/i18n';
import { initMonitoring } from '../src/monitoring/sentry';
import { AppProviders } from '../src/state/AppProviders';

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

function DevelopmentBanner() {
  const { t } = useTranslation();
  return <Body>{t('common.developmentWarning')}</Body>;
}

export default function RootLayout() {
  const runtimeEnv = useMemo(() => readRuntimeEnv(), []);
  if (!runtimeEnv.ok) return <ConfigurationError />;
  const env = runtimeEnv.env;
  return (
    <AppProviders env={env}>
      <StatusBar style="dark" />
      <Stack screenOptions={{ headerShown: false }} />
      {env.appEnv === 'development' ? <DevelopmentBanner /> : null}
    </AppProviders>
  );
}
