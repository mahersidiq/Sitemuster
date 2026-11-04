import { router, useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { useProject, useRoster } from '../../../src/api/hooks';
import { AppButton } from '../../../src/components/AppButton';
import { QueryState } from '../../../src/components/QueryState';
import { Screen } from '../../../src/components/Screen';
import { StaffGate } from '../../../src/components/StaffGate';
import { Body, Title } from '../../../src/components/Typography';
import { KioskConsole } from '../../../src/fallbacks/KioskConsole';

export default function KioskRoute() {
  return (
    <StaffGate>
      <Kiosk />
    </StaffGate>
  );
}

/** Staff kiosk (assigned attendant with MFA): workers by badge, visitors at the desk. */
function Kiosk() {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const project = useProject(id);
  const roster = useRoster(id);
  const nameOf = (workerId: string) =>
    roster.data?.find((entry) => entry.worker_id === workerId)?.legal_name ?? null;
  return (
    <Screen testID="kiosk-screen">
      <Title>{t('kiosk.title')}</Title>
      {project.data ? <Body>{project.data.project.name}</Body> : null}
      <QueryState
        isLoading={project.isLoading}
        error={project.error}
        onRetry={() => void project.refetch()}
      />
      <KioskConsole projectId={id} nameOf={nameOf} />
      {project.data?.permissions.can_run_visitor_desk ? (
        <AppButton
          variant="secondary"
          label={t('kiosk.visitors')}
          onPress={() => router.push({ pathname: '/project/[id]/visitors', params: { id } })}
          testID="kiosk-visitors"
        />
      ) : null}
      <AppButton
        variant="secondary"
        label={t('common.back')}
        onPress={() => router.back()}
        testID="kiosk-back"
      />
    </Screen>
  );
}
