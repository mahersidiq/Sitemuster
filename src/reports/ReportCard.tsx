import type { ReportView } from '@sitemuster/shared';
import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Card } from '../components/Card';
import { Heading } from '../components/Typography';
import { localDateTime } from '../fallbacks/fallbacks';
import { formatInstant } from '../projects/format';
import { useLanguage } from '../state/language';
import { colors, spacing } from '../theme';
import { formatHours } from './format';

const STATUS_TONE: Record<ReportView['status'], { backgroundColor: string; color: string }> = {
  PENDING_CONFIRMATION: { backgroundColor: colors.warningBackground, color: colors.warningText },
  CONFIRMED: { backgroundColor: colors.successBackground, color: colors.successText },
  DISPUTED: { backgroundColor: colors.dangerBackground, color: colors.dangerText },
  CORRECTION_REQUESTED: { backgroundColor: colors.infoBackground, color: colors.infoText },
  NOT_CONFIRMED: { backgroundColor: colors.dangerBackground, color: colors.dangerText },
  SUPERSEDED: { backgroundColor: colors.surface, color: colors.mutedText },
};

export function ReportStatusPill({
  status,
  testID,
}: {
  status: ReportView['status'];
  testID?: string;
}) {
  const { t } = useTranslation();
  return (
    <Text style={[styles.pill, STATUS_TONE[status]]} testID={testID}>
      {t(`reportStatus.${status}`)}
    </Text>
  );
}

/**
 * One company's daily report as issued (an estimate of onsite time, never payroll): totals, every
 * worker with their visits and flags, earlier versions and every answer so far. Nothing here
 * edits the report; corrections create a new version.
 */
export function ReportCard({
  report,
  children,
}: {
  report: ReportView;
  children?: React.ReactNode;
}) {
  const { t } = useTranslation();
  const { activeLocale } = useLanguage();
  const zone = report.summary.time_zone;
  const totals = report.summary.totals;
  const hours = (seconds: number) => formatHours(seconds, activeLocale);
  return (
    <Card testID={`report-${report.company_id}`}>
      <View style={styles.header}>
        <Heading>{report.company_name}</Heading>
        <ReportStatusPill status={report.status} testID={`report-status-${report.company_id}`} />
      </View>
      <Text style={styles.meta}>
        {t('reports.version', { version: report.version })}
        {report.status === 'PENDING_CONFIRMATION'
          ? ` · ${t('reports.dueAt', { time: formatInstant(report.due_at, zone, activeLocale) })}`
          : ''}
      </Text>
      <Text style={styles.total} testID={`report-total-${report.company_id}`}>
        {t('reports.totals', {
          workers: totals.workers,
          hours: hours(totals.definite_seconds),
          peak: totals.peak_estimated_count,
        })}
      </Text>
      {totals.uncertain_seconds > 0 || totals.pending_approval_seconds > 0 ? (
        <Text style={styles.flag}>
          {t('reports.uncertainTotal', {
            uncertain: hours(totals.uncertain_seconds),
            pending: hours(totals.pending_approval_seconds),
          })}
        </Text>
      ) : null}
      {totals.sessions_needing_review > 0 ? (
        <Text style={styles.flag}>
          {t('reports.needsReview', { count: totals.sessions_needing_review })}
        </Text>
      ) : null}
      {report.summary.workers.map((worker) => (
        <View
          key={worker.worker_id}
          style={styles.worker}
          testID={`report-worker-${worker.worker_id}`}
        >
          <Text style={styles.workerName}>
            {`${report.worker_names[worker.worker_id] ?? t('reports.unknownWorker')} · ${t('reports.hours', { hours: hours(worker.definite_seconds) })}`}
          </Text>
          {worker.sessions.map((session) => {
            const from = localDateTime(session.start_at, zone);
            const end = session.end_at ?? session.end_latest_at;
            const to = end ? localDateTime(end, zone).time : t('correction.onSite');
            const notes = [
              t(`source.${session.start_source}`, { defaultValue: session.start_source }),
              session.end_at === null && session.end_latest_at ? t('reports.endUncertain') : null,
              session.witnessed ? t('reports.witnessed') : null,
              session.corrected ? t('reports.corrected') : null,
              session.needs_review ? t('reports.review') : null,
            ].filter(Boolean);
            return (
              <Text key={session.session_id} style={styles.session}>
                {`${from.time} – ${to} · ${notes.join(' · ')}`}
              </Text>
            );
          })}
        </View>
      ))}
      {report.earlier_versions.length > 0 ? (
        <Text style={styles.meta} testID={`report-earlier-${report.company_id}`}>
          {t('reports.earlier', {
            list: report.earlier_versions
              .map((v) => `v${v.version} ${t(`reportStatus.${v.status}`)}`)
              .join(', '),
          })}
        </Text>
      ) : null}
      {report.answers.map((answer) => (
        <Text key={`${answer.version}-${answer.created_at}`} style={styles.answer}>
          {t('reports.answerLine', {
            version: answer.version,
            action: t(`reportAction.${answer.action}`),
            comment: answer.comment ?? '',
          })}
        </Text>
      ))}
      {children}
    </Card>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.sm,
    flexWrap: 'wrap',
  },
  pill: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: 12,
    overflow: 'hidden',
    fontSize: 14,
    fontWeight: '600',
  },
  meta: { fontSize: 14, color: colors.mutedText },
  total: { fontSize: 17, fontWeight: '600', color: colors.text },
  flag: { fontSize: 15, color: colors.warningText },
  worker: {
    gap: spacing.xs,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  workerName: { fontSize: 16, fontWeight: '600', color: colors.text },
  session: { fontSize: 15, color: colors.mutedText },
  answer: { fontSize: 15, color: colors.text, fontStyle: 'italic' },
});
