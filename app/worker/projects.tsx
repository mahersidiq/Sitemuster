import { useTranslation } from 'react-i18next';

import { ShellScreen } from '../../src/components/ShellScreen';

export default function WorkerProjectsScreen() {
  const { t } = useTranslation();
  return (
    <ShellScreen
      testID="worker-projects"
      title={t('worker.projects.title')}
      body={t('worker.projects.body')}
    />
  );
}
