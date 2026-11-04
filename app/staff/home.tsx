import { useTranslation } from 'react-i18next';

import { ShellScreen } from '../../src/components/ShellScreen';

export default function StaffHomeScreen() {
  const { t } = useTranslation();
  return (
    <ShellScreen testID="staff-home" title={t('staff.home.title')} body={t('staff.home.body')} />
  );
}
