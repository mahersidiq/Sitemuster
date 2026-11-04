import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { useCrew } from '../../src/api/hooks';
import { AppButton } from '../../src/components/AppButton';
import { LoadingScreen } from '../../src/components/LoadingScreen';
import { Screen } from '../../src/components/Screen';
import { Body, Title } from '../../src/components/Typography';
import { KioskConsole } from '../../src/fallbacks/KioskConsole';
import { useRefreshForUnknownWorkers } from '../../src/fallbacks/useKnownWorkers';
import { useAuth } from '../../src/state/auth';

export default function ForemanKioskRoute() {
  const { state, api } = useAuth();
  if (api && state.status === 'loading') return <LoadingScreen />;
  if (!api || state.status !== 'signed_in' || !state.access.worker_profile_id) {
    return <Redirect href="/" />;
  }
  return <ForemanKiosk />;
}

/** Crew kiosk for a foreman the GC granted kiosk use: own crew only (the server checks). */
function ForemanKiosk() {
  const { t } = useTranslation();
  const { projectId, companyId, projectName, musterId } = useLocalSearchParams<{
    projectId: string;
    companyId: string;
    projectName?: string;
    musterId?: string;
  }>();
  const crew = useCrew(projectId, companyId);
  const nameOf = (workerId: string) =>
    crew.data?.find((member) => member.worker_id === workerId)?.name ?? null;
  const known = useCallback(
    (workerId: string) => crew.data?.some((member) => member.worker_id === workerId) ?? false,
    [crew.data],
  );
  useRefreshForUnknownWorkers(known, crew.data !== undefined, crew.refetch);
  return (
    <Screen testID="foreman-kiosk-screen">
      <Title>{musterId ? t('muster.kioskTitle') : t('crew.kiosk')}</Title>
      {projectName ? <Body>{projectName}</Body> : null}
      <KioskConsole projectId={projectId} nameOf={nameOf} musterId={musterId} testID="kiosk" />
      <AppButton
        variant="secondary"
        label={t('common.back')}
        onPress={() => router.back()}
        testID="foreman-kiosk-back"
      />
    </Screen>
  );
}
