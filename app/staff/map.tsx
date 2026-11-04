import { useTranslation } from 'react-i18next';

import { ShellScreen } from '../../src/components/ShellScreen';

export default function StaffMapScreen() {
  const { t } = useTranslation();
  return <ShellScreen testID="staff-map" title={t('staff.map.title')} body={t('staff.map.body')} />;
}
