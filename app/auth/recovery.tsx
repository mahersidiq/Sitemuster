import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { AppButton } from '../../src/components/AppButton';
import { Screen } from '../../src/components/Screen';
import { Body, Heading, Title } from '../../src/components/Typography';

/** Passwordless recovery guidance (no passwords exist; identity is re-proven, never bypassed). */
export default function RecoveryScreen() {
  const { t } = useTranslation();
  return (
    <Screen testID="recovery-screen">
      <Title>{t('recovery.title')}</Title>
      <Heading>{t('recovery.workerHeading')}</Heading>
      <Body>{t('recovery.workerNewPhone')}</Body>
      <Body>{t('recovery.workerNewNumber')}</Body>
      <Heading>{t('recovery.staffHeading')}</Heading>
      <Body>{t('recovery.staffEmail')}</Body>
      <Body>{t('recovery.staffAuthenticator')}</Body>
      <AppButton variant="secondary" label={t('recovery.back')} onPress={() => router.back()} />
    </Screen>
  );
}
