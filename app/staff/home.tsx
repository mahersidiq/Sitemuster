import { useQueryClient } from '@tanstack/react-query';
import { router, useFocusEffect } from 'expo-router';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { queryKeys, useProjectDashboard } from '../../src/api/hooks';
import type { ProjectDashboard } from '../../src/api/types';
import { AppButton } from '../../src/components/AppButton';
import { Banner } from '../../src/components/Banner';
import { Card } from '../../src/components/Card';
import { QueryState } from '../../src/components/QueryState';
import { Screen } from '../../src/components/Screen';
import { ShellScreen } from '../../src/components/ShellScreen';
import { Heading } from '../../src/components/Typography';
import { Hint, LiveStatusLine, ProjectHeader, StatLine } from '../../src/dashboard/components';
import { SOURCES } from '../../src/dashboard/format';
import { useLiveState } from '../../src/realtime/ProjectLive';
import { useAuth } from '../../src/state/auth';
import { useSelectedProject } from '../../src/state/selected-project';

export default function StaffHomeScreen() {
  const { t } = useTranslation();
  const { api } = useAuth();
  // Development preview without a backend keeps the labelled wireframe (no fake counts).
  if (!api) {
    return (
      <ShellScreen testID="staff-home" title={t('staff.home.title')} body={t('staff.home.body')} />
    );
  }
  return <Dashboard />;
}

/**
 * The superintendent dashboard for the selected project (docs/spec/01 "Super mobile"). Every
 * number is an estimate from the database (decision #87); presence unknown is never "gone",
 * visitors are never workers, and the freshness line is always visible.
 */
function Dashboard() {
  const { projectId } = useSelectedProject();
  const live = useLiveState();
  const queryClient = useQueryClient();
  const dashboard = useProjectDashboard(projectId);
  const { refetch } = dashboard;
  useFocusEffect(
    useCallback(() => {
      if (projectId) void refetch();
    }, [projectId, refetch]),
  );
  const data = dashboard.data;
  return (
    <Screen testID="staff-home">
      <ProjectHeader />
      {projectId ? (
        <>
          <LiveStatusLine
            state={live}
            updatedAt={dashboard.dataUpdatedAt}
            error={dashboard.error ?? dashboard.failureReason}
            onRefresh={() =>
              void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(projectId) })
            }
          />
          <QueryState
            isLoading={dashboard.isLoading}
            error={data ? null : dashboard.error}
            onRetry={() => void refetch()}
          />
          {data ? <DashboardBody data={data} /> : null}
        </>
      ) : null}
    </Screen>
  );
}

function DashboardBody({ data }: { data: ProjectDashboard }) {
  const { t } = useTranslation();
  const { counts, today, approvals } = data;
  const projectId = data.project.id;
  return (
    <>
      {data.project.status !== 'ACTIVE' ? (
        <Banner
          text={t('dashboard.notActive', { status: t(`projectStatus.${data.project.status}`) })}
          testID="dash-not-active"
        />
      ) : null}
      <Card testID="dash-onsite">
        <Heading>{t('dashboard.estimatedOnsite')}</Heading>
        <StatLine text={String(counts.estimated_onsite)} testID="dash-onsite-count" />
        <Hint text={t('dashboard.estimateNote')} />
        <StatLine
          text={t('dashboard.witnessed', { count: counts.manually_verified })}
          testID="dash-witnessed"
        />
        <Heading>{t('dashboard.bySource')}</Heading>
        {SOURCES.map((source) => (
          <StatLine
            key={source}
            text={`${t(`source.${source}`)}: ${counts.onsite_by_source[source] ?? 0}`}
            testID={`dash-source-${source}`}
          />
        ))}
      </Card>
      {counts.approved_roster === 0 ? (
        <Banner tone="info" text={t('dashboard.noWorkers')} testID="dash-no-workers" />
      ) : null}
      <Card testID="dash-attention">
        <Heading>{t('dashboard.attention')}</Heading>
        <StatLine
          text={t('dashboard.presenceUnknown', { count: counts.presence_unknown })}
          testID="dash-unknown"
        />
        <Hint text={t('dashboard.presenceUnknownHelp')} />
        <StatLine text={t('dashboard.arriving', { count: counts.arriving })} />
        <StatLine text={t('dashboard.unscheduledPending', { count: counts.unscheduled_pending })} />
        <StatLine text={t('dashboard.departurePending', { count: counts.departure_pending })} />
        <StatLine
          text={t('dashboard.unresolved', { count: counts.unresolved_sessions })}
          testID="dash-unresolved"
        />
      </Card>
      <Card testID="dash-today">
        <Heading>{t('dashboard.today', { date: today.local_date })}</Heading>
        <StatLine text={t('dashboard.arrivals', { count: today.arrivals })} />
        <StatLine text={t('dashboard.departures', { count: today.departures })} />
        <StatLine text={t('dashboard.approvedRoster', { count: counts.approved_roster })} />
        <StatLine
          text={t('dashboard.visitorsOnsite', { count: counts.visitors_onsite })}
          testID="dash-visitors"
        />
      </Card>
      <Card testID="dash-companies">
        <Heading>{t('dashboard.companies')}</Heading>
        {data.companies.map((company) => (
          <StatLine
            key={company.company_id ?? 'none'}
            text={`${company.company_name ?? t('dashboard.noCompany')}: ${t(
              'dashboard.companyLine',
              {
                onsite: company.estimated_onsite,
                approved: company.approved,
              },
            )} · ${t('dashboard.companyExtra', {
              verified: company.manually_verified,
              unknown: company.presence_unknown,
            })}`}
            testID={`dash-company-${company.company_id ?? 'none'}`}
          />
        ))}
      </Card>
      <Card testID="dash-trades">
        <Heading>{t('dashboard.trades')}</Heading>
        {data.trades.map((trade) => (
          <StatLine
            key={trade.trade ?? 'none'}
            text={`${trade.trade ?? t('dashboard.noTrade')}: ${t('dashboard.tradeLine', {
              onsite: trade.estimated_onsite,
              approved: trade.approved,
            })}`}
          />
        ))}
      </Card>
      <Card testID="dash-approvals">
        <Heading>{t('dashboard.approvals')}</Heading>
        <StatLine
          text={t('dashboard.pendingEnrollments', { count: approvals.pending_enrollments })}
          testID="dash-pending"
        />
        <StatLine text={t('dashboard.employerPending', { count: approvals.employer_pending })} />
        <AppButton
          variant="secondary"
          label={t('dashboard.reviewApprovals')}
          onPress={() =>
            router.push({ pathname: '/project/[id]/workers', params: { id: projectId } })
          }
          testID="dash-review-approvals"
        />
      </Card>
      <AppButton
        label={t('dashboard.openWorkforce')}
        onPress={() => router.navigate('/staff/workforce')}
        testID="dash-open-workforce"
      />
      {data.can_view_map ? (
        <AppButton
          variant="secondary"
          label={t('dashboard.openMap')}
          onPress={() => router.navigate('/staff/map')}
          testID="dash-open-map"
        />
      ) : null}
    </>
  );
}
