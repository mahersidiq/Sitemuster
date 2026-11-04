import { useTranslation } from 'react-i18next';

import { ShellScreen } from '../../src/components/ShellScreen';

export default function StaffProjectsScreen() {
  const { t } = useTranslation();
  return (
    <ShellScreen
      testID="staff-projects"
      title={t('staff.projects.title')}
      body={t('staff.projects.body')}
    />
  );
}
