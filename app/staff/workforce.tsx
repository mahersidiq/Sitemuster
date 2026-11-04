import { useTranslation } from 'react-i18next';

import { ShellScreen } from '../../src/components/ShellScreen';

export default function StaffWorkforceScreen() {
  const { t } = useTranslation();
  return (
    <ShellScreen
      testID="staff-workforce"
      title={t('staff.workforce.title')}
      body={t('staff.workforce.body')}
    />
  );
}
