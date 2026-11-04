import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { AccountSection } from '../../src/components/AccountSection';
import { AppButton } from '../../src/components/AppButton';
import { EmergencyContactSection } from '../../src/components/EmergencyContactSection';
import { LanguageSwitcher } from '../../src/components/LanguageSwitcher';
import { ShellScreen } from '../../src/components/ShellScreen';
import { useAuth } from '../../src/state/auth';

export default function WorkerProfileScreen() {
  const { t } = useTranslation();
  const { api, state } = useAuth();
  const isWorker =
    api !== null && state.status === 'signed_in' && state.access.worker_profile_id !== null;
  return (
    <ShellScreen
      testID="worker-profile"
      preview={api === null}
      title={t('worker.profile.title')}
      body={t('worker.profile.body')}
    >
      {isWorker ? <EmergencyContactSection /> : null}
      {isWorker ? (
        <AppButton
          variant="secondary"
          label={t('privacy.open')}
          onPress={() => router.push('/privacy')}
          testID="open-privacy"
        />
      ) : null}
      <LanguageSwitcher />
      <AccountSection />
    </ShellScreen>
  );
}
