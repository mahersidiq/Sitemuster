import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { useForemanMuster, useForemanProjects } from '../../src/api/hooks';
import { AppButton } from '../../src/components/AppButton';
import { Banner } from '../../src/components/Banner';
import { LoadingScreen } from '../../src/components/LoadingScreen';
import { QueryState } from '../../src/components/QueryState';
import { Screen } from '../../src/components/Screen';
import { Body, Title } from '../../src/components/Typography';
import { MusterBoardView } from '../../src/muster/MusterBoardView';
import { useAuth } from '../../src/state/auth';

export default function ForemanMusterRoute() {
  const { state, api } = useAuth();
  if (api && state.status === 'loading') return <LoadingScreen />;
  if (!api || state.status !== 'signed_in' || !state.access.worker_profile_id) {
    return <Redirect href="/" />;
  }
  return <ForemanMuster />;
}

/**
 * A verified foreman's muster check (docs/spec/12): only their own company's workers on the
 * frozen list. A tap means "I see this person at the assembly point" and waits in the outbox until
 * the server answers; the server refuses anyone outside the foreman's company.
 */
function ForemanMuster() {
  const { t } = useTranslation();
  const { musterId, projectId } = useLocalSearchParams<{ musterId: string; projectId: string }>();
  const board = useForemanMuster(musterId);
  const projects = useForemanProjects();
  const kioskGrant = projects.data?.find(
    (entry) => entry.project_id === projectId && entry.kiosk_grant,
  );
  const data = board.data;
  return (
    <Screen testID="foreman-muster-screen">
      <Title>{t('muster.foreman.title')}</Title>
      {data ? <Body>{data.project_name}</Body> : null}
      <Banner tone="warning" text={t('muster.notLifeSafety')} />
      <Body>{t('muster.foreman.help')}</Body>
      <QueryState
        isLoading={board.isLoading}
        error={board.error}
        onRetry={() => void board.refetch()}
      />
      {data && data.members.length === 0 ? <Body>{t('muster.foreman.none')}</Body> : null}
      {data ? (
        <MusterBoardView
          board={data}
          projectId={projectId}
          canVerify={(member) => member.kind === 'WORKER'}
          testID="foreman-muster"
        />
      ) : null}
      {kioskGrant && data?.status === 'ACTIVE' ? (
        <AppButton
          label={t('muster.scan')}
          onPress={() =>
            router.push({
              pathname: '/foreman/kiosk',
              params: {
                projectId,
                companyId: kioskGrant.company_id,
                projectName: kioskGrant.project_name,
                musterId,
              },
            })
          }
          testID="foreman-muster-scan"
        />
      ) : null}
      <AppButton
        variant="secondary"
        label={t('common.back')}
        onPress={() => router.back()}
        testID="foreman-muster-back"
      />
    </Screen>
  );
}
