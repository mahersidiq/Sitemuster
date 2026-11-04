import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { AccountSection } from '../../src/components/AccountSection';
import { AppButton } from '../../src/components/AppButton';
import { LanguageSwitcher } from '../../src/components/LanguageSwitcher';
import { ShellScreen } from '../../src/components/ShellScreen';
import { useAuth } from '../../src/state/auth';

export default function StaffMoreScreen() {
  const { t } = useTranslation();
  const { api } = useAuth();
  return (
    <ShellScreen testID="staff-more" title={t('staff.more.title')} body={t('staff.more.body')}>
      {api ? (
        <AppButton
          variant="secondary"
          label={t('invitations.cta')}
          onPress={() => router.push('/invitations')}
          testID="more-invitations"
        />
      ) : null}
      <LanguageSwitcher />
      <AccountSection />
    </ShellScreen>
  );
}
