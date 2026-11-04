import { useTranslation } from 'react-i18next';

import { Screen } from '../../src/components/Screen';
import { ShellScreen } from '../../src/components/ShellScreen';
import { Title } from '../../src/components/Typography';
import { WorkerProjects } from '../../src/components/WorkerProjects';
import { useAuth } from '../../src/state/auth';

export default function WorkerProjectsScreen() {
  const { t } = useTranslation();
  const { api } = useAuth();
  if (!api) {
    return (
      <ShellScreen
        testID="worker-projects"
        title={t('worker.projects.title')}
        body={t('worker.projects.body')}
      />
    );
  }
  return (
    <Screen testID="worker-projects">
      <Title>{t('worker.projects.title')}</Title>
      <WorkerProjects showJoin={false} />
    </Screen>
  );
}
