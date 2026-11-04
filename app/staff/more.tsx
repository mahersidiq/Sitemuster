import { useTranslation } from 'react-i18next';

import { LanguageSwitcher } from '../../src/components/LanguageSwitcher';
import { ShellScreen } from '../../src/components/ShellScreen';

export default function StaffMoreScreen() {
  const { t } = useTranslation();
  return (
    <ShellScreen testID="staff-more" title={t('staff.more.title')} body={t('staff.more.body')}>
      <LanguageSwitcher />
    </ShellScreen>
  );
}
