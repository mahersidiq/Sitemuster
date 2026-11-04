import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { AppButton } from '../src/components/AppButton';
import { InfoScreen } from '../src/components/InfoScreen';

/** People holding both worker and staff roles pick an explicit context (spec 01 navigation). */
export default function ChooseContextScreen() {
  const { t } = useTranslation();
  return (
    <InfoScreen testID="choose-context-screen" title={t('access.chooseTitle')} body="">
      <AppButton
        label={t('access.asStaff')}
        onPress={() => router.replace('/staff/home')}
        testID="as-staff"
      />
      <AppButton
        variant="secondary"
        label={t('access.asWorker')}
        onPress={() => router.replace('/worker/home')}
        testID="as-worker"
      />
    </InfoScreen>
  );
}
