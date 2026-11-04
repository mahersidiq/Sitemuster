import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { AppButton } from '../src/components/AppButton';
import { Screen } from '../src/components/Screen';
import { Body } from '../src/components/Typography';

export default function NotFound() {
  const { t } = useTranslation();
  return (
    <Screen testID="not-found">
      <Body>{t('errors.routeNotFound')}</Body>
      <AppButton label={t('errors.goHome')} onPress={() => router.replace('/')} />
    </Screen>
  );
}
