import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { AppButton } from '../src/components/AppButton';
import { InfoScreen } from '../src/components/InfoScreen';
import { useAuth } from '../src/state/auth';

/** Session exists but access could not be confirmed offline and nothing is cached. */
export default function OfflineScreen() {
  const { t } = useTranslation();
  const { refresh } = useAuth();
  return (
    <InfoScreen
      testID="offline-screen"
      title={t('access.offlineTitle')}
      body={t('access.offlineBody')}
    >
      <AppButton
        label={t('access.retry')}
        onPress={() => void refresh().then(() => router.replace('/'))}
        testID="retry"
      />
    </InfoScreen>
  );
}
