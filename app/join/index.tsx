import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { AppButton } from '../../src/components/AppButton';
import { InfoScreen } from '../../src/components/InfoScreen';
import { useAuth } from '../../src/state/auth';

/** Signed-in worker without a project yet: join by scanning the supervisor's orientation QR. */
export default function JoinScreen() {
  const { t } = useTranslation();
  const { api } = useAuth();
  return (
    <InfoScreen testID="join-screen" title={t('access.joinTitle')} body={t('access.joinBody')}>
      {api ? (
        <>
          <AppButton
            label={t('join.scanCta')}
            onPress={() => router.push('/join/scan')}
            testID="join-scan"
          />
          <AppButton
            variant="secondary"
            label={t('join.typeCta')}
            onPress={() => router.push({ pathname: '/join/scan', params: { manual: '1' } })}
            testID="join-type"
          />
        </>
      ) : null}
    </InfoScreen>
  );
}
