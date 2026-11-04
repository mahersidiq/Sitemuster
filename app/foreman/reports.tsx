import type { ReportAction, ReportView } from '@sitemuster/shared';
import { useQueryClient } from '@tanstack/react-query';
import { randomUUID } from 'expo-crypto';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { errorMessageKey } from '../../src/api/errors';
import { queryKeys, usePendingReports } from '../../src/api/hooks';
import { AppButton } from '../../src/components/AppButton';
import { Banner } from '../../src/components/Banner';
import { ChipGroup } from '../../src/components/ChipGroup';
import { QueryState } from '../../src/components/QueryState';
import { Screen } from '../../src/components/Screen';
import { TextField } from '../../src/components/TextField';
import { Body, Heading, Title } from '../../src/components/Typography';
import { correctionTimes, localDateTime } from '../../src/fallbacks/fallbacks';
import { formatLocalDateLabel } from '../../src/reports/format';
import { ReportCard } from '../../src/reports/ReportCard';
import { useApi } from '../../src/state/auth';
import { useLanguage } from '../../src/state/language';
import { colors, spacing } from '../../src/theme';

/**
 * The foreman's daily company reports waiting for an answer (docs/spec/04): CONFIRM, DISPUTE or
 * SUBMIT_CORRECTION, due 12:00 on the next project workday. Without an answer the report becomes
 * NOT_CONFIRMED — never approved. An answer never changes the report; staff issue a new version.
 */
export default function ForemanReportsScreen() {
  const { t } = useTranslation();
  const pending = usePendingReports();
  const { refetch } = pending;
  useFocusEffect(
    useCallback(() => {
      void refetch();
    }, [refetch]),
  );
  const [done, setDone] = useState<string | null>(null);
  return (
    <Screen testID="foreman-reports">
      <Title>{t('foremanReports.title')}</Title>
      <Banner tone="info" text={t('reports.estimateNotice')} />
      {done ? <Banner tone="success" text={done} testID="answer-done" /> : null}
      <QueryState
        isLoading={pending.isLoading}
        error={pending.error}
        onRetry={() => void pending.refetch()}
      />
      {pending.data && pending.data.reports.length === 0 ? (
        <Body>{t('foremanReports.none')}</Body>
      ) : null}
      {pending.data?.reports.map((report) => (
        <ReportCard key={report.report_id} report={report}>
          <Answer report={report} onDone={setDone} />
        </ReportCard>
      ))}
      <AppButton
        variant="secondary"
        label={t('common.back')}
        onPress={() => router.back()}
        testID="foreman-reports-back"
      />
    </Screen>
  );
}

const NONE = '';

function Answer({ report, onDone }: { report: ReportView; onDone: (text: string) => void }) {
  const { t } = useTranslation();
  const { activeLocale } = useLanguage();
  const api = useApi();
  const queryClient = useQueryClient();
  const zone = report.summary.time_zone;
  const [mode, setMode] = useState<ReportAction | null>(null);
  // One id per answer: a retry after a lost reply is recognized as the same answer.
  const [eventUuid, setEventUuid] = useState(() => randomUUID());
  const [reason, setReason] = useState('');
  const [sessionKey, setSessionKey] = useState(NONE);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const options = report.summary.workers.flatMap((worker) =>
    worker.sessions.map((session) => {
      const from = localDateTime(session.start_at, zone);
      const to = session.end_at ? localDateTime(session.end_at, zone).time : t('correction.onSite');
      return {
        value: `${worker.worker_id}|${session.session_id}`,
        label: `${report.worker_names[worker.worker_id] ?? ''} ${from.time}–${to}`,
        date: from.date,
      };
    }),
  );

  const send = async (action: ReportAction) => {
    setError(null);
    let proposed: {
      worker_id: string;
      session_id: string | null;
      proposed_start_at: string | null;
      proposed_end_at: string | null;
      note: string | null;
    }[] = [];
    if (action !== 'CONFIRM' && reason.trim().length < 3) {
      setError(t('foremanReports.reasonNeeded'));
      return;
    }
    if (action === 'SUBMIT_CORRECTION') {
      const chosen = options.find((option) => option.value === sessionKey);
      const times = chosen
        ? correctionTimes({ date: chosen.date, start, end, timeZone: zone })
        : null;
      if (!chosen || !times) {
        setError(t('foremanReports.proposalNeeded'));
        return;
      }
      const [workerId, sessionId] = chosen.value.split('|');
      proposed = [
        {
          worker_id: workerId ?? '',
          session_id: sessionId ?? null,
          proposed_start_at: times.startAt?.replace('.000Z', 'Z') ?? null,
          proposed_end_at: times.endAt?.replace('.000Z', 'Z') ?? null,
          note: null,
        },
      ];
    }
    setBusy(true);
    try {
      const result = await api.answerReport({
        schema_version: 1,
        report_id: report.report_id,
        version: report.version,
        action,
        reason: action === 'CONFIRM' ? null : reason.trim(),
        proposed,
        event_uuid: eventUuid,
      });
      onDone(
        t('foremanReports.sent', {
          company: report.company_name,
          date: formatLocalDateLabel(report.local_date, activeLocale),
          status: t(`reportStatus.${result.status}`),
        }),
      );
      setEventUuid(randomUUID());
      await queryClient.invalidateQueries({ queryKey: queryKeys.pendingReports });
    } catch (caught) {
      setError(t(errorMessageKey(caught)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.answer}>
      <Heading>{t('foremanReports.answerTitle')}</Heading>
      <Text style={styles.hint}>{t('foremanReports.answerHelp')}</Text>
      <AppButton
        label={t('foremanReports.confirm')}
        onPress={() => void send('CONFIRM')}
        disabled={busy}
        testID={`confirm-${report.report_id}`}
      />
      <ChipGroup
        label={t('foremanReports.other')}
        options={[
          { value: 'DISPUTE' as const, label: t('reportAction.DISPUTE') },
          { value: 'SUBMIT_CORRECTION' as const, label: t('reportAction.SUBMIT_CORRECTION') },
        ]}
        selected={mode && mode !== 'CONFIRM' ? [mode] : []}
        onToggle={(value) => setMode(value)}
        testID={`answer-mode-${report.report_id}`}
      />
      {mode === 'SUBMIT_CORRECTION' ? (
        <>
          <ChipGroup
            label={t('foremanReports.pickVisit')}
            options={options.map(({ value, label }) => ({ value, label }))}
            selected={sessionKey ? [sessionKey] : []}
            onToggle={setSessionKey}
            testID={`answer-visit-${report.report_id}`}
          />
          <Text style={styles.hint}>{t('correction.zone', { zone })}</Text>
          <View style={styles.times}>
            <View style={styles.time}>
              <TextField
                label={t('foremanReports.arrival')}
                value={start}
                onChangeText={setStart}
                maxLength={5}
                testID={`answer-start-${report.report_id}`}
              />
            </View>
            <View style={styles.time}>
              <TextField
                label={t('foremanReports.departure')}
                value={end}
                onChangeText={setEnd}
                maxLength={5}
                testID={`answer-end-${report.report_id}`}
              />
            </View>
          </View>
        </>
      ) : null}
      {mode === 'DISPUTE' || mode === 'SUBMIT_CORRECTION' ? (
        <>
          <TextField
            label={t('foremanReports.reason')}
            value={reason}
            onChangeText={setReason}
            maxLength={2000}
            testID={`answer-reason-${report.report_id}`}
          />
          <AppButton
            label={
              mode === 'DISPUTE'
                ? t('foremanReports.sendDispute')
                : t('foremanReports.sendCorrection')
            }
            onPress={() => void send(mode)}
            disabled={busy}
            testID={`answer-send-${report.report_id}`}
          />
        </>
      ) : null}
      {error ? (
        <Banner tone="danger" text={error} testID={`answer-error-${report.report_id}`} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  answer: {
    gap: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  hint: { fontSize: 15, color: colors.mutedText },
  times: { flexDirection: 'row', gap: spacing.sm },
  time: { flex: 1 },
});
