import { useTranslation } from 'react-i18next';

import { Screen } from '../../src/components/Screen';
import { ShellScreen } from '../../src/components/ShellScreen';
import { TrackingStatusCard } from '../../src/components/TrackingStatusCard';
import { Body, Title } from '../../src/components/Typography';
import { WorkerProjects } from '../../src/components/WorkerProjects';
import { ForemanCard } from '../../src/fallbacks/ForemanCard';
import { useAuth } from '../../src/state/auth';

export default function WorkerHomeScreen() {
  const { t } = useTranslation();
  const { api } = useAuth();
  if (!api) {
    return (
      <ShellScreen
        testID="worker-home"
        title={t('worker.home.title')}
        body={t('worker.home.body')}
      />
    );
  }
  return (
    <Screen testID="worker-home">
      <Title>{t('worker.home.title')}</Title>
      <TrackingStatusCard />
      <ForemanCard />
      <Body>{t('workerProjects.homeIntro')}</Body>
      <WorkerProjects showJoin />
    </Screen>
  );
}
