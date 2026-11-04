import { useTranslation } from 'react-i18next';

import { Screen } from './Screen';
import { Body } from './Typography';

/** Neutral screen while the stored session is restored (no data shown, no redirect yet). */
export function LoadingScreen() {
  const { t } = useTranslation();
  return (
    <Screen testID="loading-screen">
      <Body>{t('common.loading')}</Body>
    </Screen>
  );
}
