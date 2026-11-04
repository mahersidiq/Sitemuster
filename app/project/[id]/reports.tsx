import { useQueryClient } from '@tanstack/react-query';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { errorMessageKey } from '../../../src/api/errors';
import { queryKeys, useProject, useReports } from '../../../src/api/hooks';
import { AppButton } from '../../../src/components/AppButton';
import { Banner } from '../../../src/components/Banner';
import { ChipGroup } from '../../../src/components/ChipGroup';
import { QueryState } from '../../../src/components/QueryState';
import { Screen } from '../../../src/components/Screen';
import { StaffGate } from '../../../src/components/StaffGate';
import { TextField } from '../../../src/components/TextField';
import { useNow } from '../../../src/components/useNow';
import { Body, Title } from '../../../src/components/Typography';
import { formatLocalDateLabel, recentLocalDates } from '../../../src/reports/format';
import { ReportCard } from '../../../src/reports/ReportCard';
import { useApi } from '../../../src/state/auth';
import { useLanguage } from '../../../src/state/language';

export default function ReportsRoute() {
  return (
    <StaffGate>
      <Reports />
    </StaffGate>
  );
}

/**
 * Daily company reports for one project-local day (docs/spec/04 "Report and confirmation
 * lifecycle"). Staff read every company; after an approved correction the owner, PM or
 * superintendent issues a new version — the earlier version and its answers stay visible.
 */
function Reports() {
  const { t } = useTranslation();
  const { activeLocale } = useLanguage();
  const { id } = useLocalSearchParams<{ id: string }>();
  const project = useProject(id);
  const zone = project.data?.project.iana_timezone ?? null;
  // The day list follows the clock (a minute is enough: dates change at midnight).
  const minute = useNow(60_000).getTime();
  const dates = useMemo(() => (zone ? recentLocalDates(zone, minute, 8) : []), [zone, minute]);
  const [picked, setPicked] = useState<string | null>(null);
  const date = picked ?? dates[1] ?? null; // yesterday by default (today is still open)
  const reports = useReports(id, date);
  const { refetch } = reports;
  useFocusEffect(
    useCallback(() => {
      if (date) void refetch();
    }, [refetch, date]),
  );
  const canReissue = project.data?.permissions.can_correct_attendance === true;
  const data = reports.data;
  return (
    <Screen testID="reports-screen">
      <Title>{t('reports.title')}</Title>
      <Banner tone="info" text={t('reports.estimateNotice')} testID="reports-notice" />
      {dates.length > 0 ? (
        <ChipGroup
          label={t('reports.date')}
          options={dates.map((value, index) => ({
            value,
            label: index === 0 ? t('reports.today') : formatLocalDateLabel(value, activeLocale),
          }))}
          selected={date ? [date] : []}
          onToggle={setPicked}
          testID="report-date"
        />
      ) : null}
      <QueryState
        isLoading={project.isLoading || reports.isLoading}
        error={project.error ?? reports.error}
        onRetry={() => void reports.refetch()}
      />
      {data?.day_open ? (
        <Banner tone="info" text={t('reports.dayOpen')} testID="reports-day-open" />
      ) : null}
      {data && !data.day_open && data.reports.length === 0 ? (
        <Body>{t('reports.none')}</Body>
      ) : null}
      {data?.reports.map((report) => (
        <ReportCard key={report.report_id} report={report}>
          {canReissue && date ? (
            <Reissue projectId={id} companyId={report.company_id} localDate={date} />
          ) : null}
        </ReportCard>
      ))}
      {canReissue ? (
        <AppButton
          variant="secondary"
          label={t('requests.open')}
          onPress={() => router.push({ pathname: '/project/[id]/requests', params: { id } })}
          testID="open-requests"
        />
      ) : null}
    </Screen>
  );
}

function Reissue({
  projectId,
  companyId,
  localDate,
}: {
  projectId: string;
  companyId: string;
  localDate: string;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!open) {
    return (
      <AppButton
        variant="secondary"
        label={t('reports.reissue')}
        onPress={() => setOpen(true)}
        testID={`reissue-${companyId}`}
      />
    );
  }
  const submit = async () => {
    if (reason.trim().length < 3) {
      setError(t('reports.reasonNeeded'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.reissueReport({ projectId, companyId, localDate, reason: reason.trim() });
      setOpen(false);
      setReason('');
      await queryClient.invalidateQueries({ queryKey: queryKeys.reports(projectId, localDate) });
    } catch (caught) {
      setError(t(errorMessageKey(caught)));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Body>{t('reports.reissueHelp')}</Body>
      <TextField
        label={t('reports.reissueReason')}
        value={reason}
        onChangeText={setReason}
        maxLength={1000}
        error={error}
        testID={`reissue-reason-${companyId}`}
      />
      <AppButton
        label={t('reports.reissueConfirm')}
        onPress={() => void submit()}
        disabled={busy}
        testID={`reissue-confirm-${companyId}`}
      />
    </>
  );
}
