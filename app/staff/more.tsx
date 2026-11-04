import { useTranslation } from 'react-i18next';

import { AccountSection } from '../../src/components/AccountSection';
import { LanguageSwitcher } from '../../src/components/LanguageSwitcher';
import { ShellScreen } from '../../src/components/ShellScreen';

export default function StaffMoreScreen() {
  const { t } = useTranslation();
  return (
    <ShellScreen testID="staff-more" title={t('staff.more.title')} body={t('staff.more.body')}>
      <LanguageSwitcher />
      <AccountSection />
    </ShellScreen>
  );
}
