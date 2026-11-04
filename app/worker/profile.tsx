import { useTranslation } from 'react-i18next';

import { LanguageSwitcher } from '../../src/components/LanguageSwitcher';
import { ShellScreen } from '../../src/components/ShellScreen';

export default function WorkerProfileScreen() {
  const { t } = useTranslation();
  return (
    <ShellScreen
      testID="worker-profile"
      title={t('worker.profile.title')}
      body={t('worker.profile.body')}
    >
      <LanguageSwitcher />
    </ShellScreen>
  );
}
