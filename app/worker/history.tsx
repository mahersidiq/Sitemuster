import {
  addDays,
  buildHoursCsv,
  parseLocalDate,
  workerHoursByDay,
  zonedToUtc,
  type WorkerDayHours,
} from '@sitemuster/shared';
import { useQueryClient } from '@tanstack/react-query';
import { randomUUID } from 'expo-crypto';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { errorMessageKey } from '../../src/api/errors';
import { useMyAttendance, useMyEnrollments } from '../../src/api/hooks';
import type { MyAttendance } from '../../src/api/types';
import { AppButton } from '../../src/components/AppButton';
import { Banner } from '../../src/components/Banner';
import { Card } from '../../src/components/Card';
import { ChipGroup } from '../../src/components/ChipGroup';
import { QueryState } from '../../src/components/QueryState';
import { Screen } from '../../src/components/Screen';
import { ShellScreen } from '../../src/components/ShellScreen';
import { TextField } from '../../src/components/TextField';
import { useNow } from '../../src/components/useNow';
import { Body, Heading, Title } from '../../src/components/Typography';
import { correctionTimes, localDateTime } from '../../src/fallbacks/fallbacks';
import {
  formatHours,
  formatLocalDateLabel,
  hoursCsvRows,
  weekStarts,
} from '../../src/reports/format';
import { shareCsv } from '../../src/sharing/share-csv';
import { useAuth } from '../../src/state/auth';
import { useLanguage } from '../../src/state/language';
import { colors, spacing } from '../../src/theme';

export default function WorkerHistoryScreen() {
  const { t } = useTranslation();
  const { api } = useAuth();
  if (!api) {
    return (
      <ShellScreen
        testID="worker-history"
        title={t('worker.history.title')}
        body={t('worker.history.body')}
      />
    );
  }
  return <History />;
}

/**
 * The worker's own estimated onsite time per project-local day and week (docs/spec/04: "own
 * per-project estimated duration and basic personal CSV through native share, own corrections and
 * status"). Only the worker's own sessions are ever read; hours are estimates, not payroll.
 */
function History() {
  const { t } = useTranslation();
  const enrollments = useMyEnrollments();
  const projects = (enrollments.data ?? []).filter((e) => e.enrollment_status === 'APPROVED');
  const [picked, setPicked] = useState<string | null>(null);
  const project = projects.find((p) => p.project_id === picked) ?? projects[0] ?? null;
  return (
    <Screen testID="worker-history">
      <Title>{t('worker.history.title')}</Title>
      {enrollments.data && projects.length === 0 ? (
        <Body>{t('hours.noProjects')}</Body>
      ) : (
        <Banner tone="info" text={t('hours.estimateNotice')} testID="hours-notice" />
      )}
      {projects.length > 1 ? (
        <ChipGroup
          label={t('hours.project')}
          options={projects.map((p) => ({ value: p.project_id, label: p.project_name }))}
          selected={project ? [project.project_id] : []}
          onToggle={setPicked}
          testID="hours-project"
        />
      ) : null}
      <QueryState
        isLoading={enrollments.isLoading}
        error={enrollments.error}
        onRetry={() => void enrollments.refetch()}
      />
      {project ? (
        <ProjectHours
          key={project.project_id}
          projectId={project.project_id}
          zone={project.iana_timezone}
        />
      ) : null}
    </Screen>
  );
}

/** The fetch window: a day wider than the week (the shared rules clip visits to local days). */
function rangeOf(from: string, zone: string): { from: string; to: string } {
  const start = parseLocalDate(from);
  return {
    from: new Date(zonedToUtc(addDays(start, -1), 0, zone)).toISOString(),
    to: new Date(zonedToUtc(addDays(start, 8), 0, zone)).toISOString(),
  };
}

function ProjectHours({ projectId, zone }: { projectId: string; zone: string }) {
  const { t } = useTranslation();
  const { activeLocale } = useLanguage();
  const now = useNow(60_000).getTime();
  const [week, setWeek] = useState<'current' | 'previous'>('current');
  const from = weekStarts(zone, now)[week];
  const range = rangeOf(from, zone);
  const attendance = useMyAttendance(projectId, range.from, range.to);
  const { refetch } = attendance;
  useFocusEffect(
    useCallback(() => {
      void refetch();
    }, [refetch]),
  );
  const data = attendance.data;
  const days = data ? hoursOf(data, from, now) : [];
  const total = days.reduce((sum, day) => sum + day.definite_seconds, 0);
  return (
    <>
      <ChipGroup
        label={t('hours.week')}
        options={[
          { value: 'current' as const, label: t('hours.thisWeek') },
          { value: 'previous' as const, label: t('hours.lastWeek') },
        ]}
        selected={[week]}
        onToggle={setWeek}
        testID="hours-week"
      />
      <QueryState
        isLoading={attendance.isLoading}
        error={attendance.error}
        onRetry={() => void attendance.refetch()}
      />
      {data ? (
        <Card testID="hours-week-card">
          <Heading>{data.project.name}</Heading>
          {days.map((day) => (
            <View key={day.local_date} style={styles.day} testID={`hours-day-${day.local_date}`}>
              <Text style={styles.dayLabel}>
                {formatLocalDateLabel(day.local_date, activeLocale)}
              </Text>
              <Text style={styles.dayHours}>
                {t('reports.hours', { hours: formatHours(day.definite_seconds, activeLocale) })}
                {day.needs_review ? ` · ${t('hours.review')}` : ''}
              </Text>
            </View>
          ))}
          <Text style={styles.total} testID="hours-total">
            {t('hours.weekTotal', { hours: formatHours(total, activeLocale) })}
          </Text>
          <ShareButton days={days} data={data} />
        </Card>
      ) : null}
      {data ? <RequestForm data={data} days={days} /> : null}
      {data && data.requests.length > 0 ? (
        <Card testID="hours-requests">
          <Heading>{t('hours.myRequests')}</Heading>
          {data.requests.map((request) => (
            <Text
              key={request.request_id}
              style={styles.request}
              testID={`my-request-${request.request_id}`}
            >
              {`${t(`hours.requestStatus.${request.status}`)} · ${request.reason}`}
              {request.decision_reason ? ` · ${request.decision_reason}` : ''}
            </Text>
          ))}
        </Card>
      ) : null}
    </>
  );
}

function hoursOf(data: MyAttendance, from: string, now: number): WorkerDayHours[] {
  const unknown = new Map(
    data.configs.map((c) => [c.config_version_id, c.presence_unknown_seconds]),
  );
  return workerHoursByDay(
    data.sessions,
    from,
    7,
    data.project.time_zone,
    new Date(now).toISOString(),
    (id) => unknown.get(id) ?? 1200,
  );
}

function ShareButton({ days, data }: { days: WorkerDayHours[]; data: MyAttendance }) {
  const { t } = useTranslation();
  const [message, setMessage] = useState<string | null>(null);
  const share = async () => {
    setMessage(null);
    const csv = buildHoursCsv(
      {
        date: t('hours.csv.date'),
        project: t('hours.csv.project'),
        arrival: t('hours.csv.arrival'),
        departure: t('hours.csv.departure'),
        estimatedHours: t('hours.csv.estimatedHours'),
        status: t('hours.csv.status'),
      },
      hoursCsvRows(
        days,
        data.project.name,
        data.project.time_zone,
        (status, review) =>
          review
            ? t('hours.csv.needsReview')
            : t(`hours.csv.statusValue.${status}`, { defaultValue: status }),
        t('correction.onSite'),
      ),
    );
    try {
      const shared = await shareCsv(csv, `sitemuster-hours-${days[0]?.local_date ?? 'week'}.csv`);
      if (!shared) setMessage(t('hours.shareUnavailable'));
    } catch {
      setMessage(t('hours.shareFailed'));
    }
  };
  return (
    <>
      <AppButton
        variant="secondary"
        label={t('hours.share')}
        onPress={() => void share()}
        testID="hours-share"
      />
      {message ? <Banner tone="warning" text={message} testID="hours-share-message" /> : null}
    </>
  );
}

const MISSING = 'missing';

function RequestForm({ data, days }: { data: MyAttendance; days: WorkerDayHours[] }) {
  const { t } = useTranslation();
  const { api } = useAuth();
  const queryClient = useQueryClient();
  const zone = data.project.time_zone;
  const sessions = days.flatMap((day) => day.sessions);
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<string>(MISSING);
  const [date, setDate] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [reason, setReason] = useState('');
  const [eventUuid, setEventUuid] = useState(() => randomUUID());
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  if (!open) {
    return (
      <>
        {sent ? (
          <Banner tone="success" text={t('hours.requestSent')} testID="hours-request-sent" />
        ) : null}
        <AppButton
          variant="secondary"
          label={t('hours.requestCorrection')}
          onPress={() => {
            setOpen(true);
            setSent(false);
          }}
          testID="hours-request-open"
        />
      </>
    );
  }
  const choose = (value: string) => {
    setTarget(value);
    const session = sessions.find((s) => s.session_id === value);
    if (session) setDate(localDateTime(session.start_at, zone).date);
  };
  const submit = async () => {
    setError(null);
    const times = correctionTimes({ date, start, end, timeZone: zone });
    if (
      !times ||
      reason.trim().length < 3 ||
      (target === MISSING && (!times.startAt || !times.endAt))
    ) {
      setError(t('hours.requestInvalid'));
      return;
    }
    try {
      await api?.requestCorrection({
        projectId: data.project.id,
        sessionId: target === MISSING ? null : target,
        proposedStartAt: times.startAt,
        proposedEndAt: times.endAt,
        reason: reason.trim(),
        eventUuid,
      });
      setOpen(false);
      setSent(true);
      setReason('');
      setStart('');
      setEnd('');
      setEventUuid(randomUUID());
      await queryClient.invalidateQueries({ queryKey: ['my-attendance', data.project.id] });
    } catch (caught) {
      setError(t(errorMessageKey(caught)));
    }
  };
  return (
    <Card testID="hours-request-form">
      <Heading>{t('hours.requestCorrection')}</Heading>
      <Body>{t('hours.requestHelp')}</Body>
      <ChipGroup
        label={t('hours.whichVisit')}
        options={[
          ...sessions.map((session) => {
            const from = localDateTime(session.start_at, zone);
            const to = session.end_at
              ? localDateTime(session.end_at, zone).time
              : t('correction.onSite');
            return { value: session.session_id, label: `${from.date} ${from.time}–${to}` };
          }),
          { value: MISSING, label: t('hours.missingVisit') },
        ]}
        selected={[target]}
        onToggle={choose}
        testID="hours-request-target"
      />
      <Text style={styles.hint}>{t('correction.zone', { zone })}</Text>
      <TextField
        label={t('correction.date')}
        value={date}
        onChangeText={setDate}
        maxLength={10}
        testID="hours-request-date"
      />
      <View style={styles.times}>
        <View style={styles.time}>
          <TextField
            label={t('correction.start')}
            value={start}
            onChangeText={setStart}
            maxLength={5}
            testID="hours-request-start"
          />
        </View>
        <View style={styles.time}>
          <TextField
            label={t('correction.end')}
            value={end}
            onChangeText={setEnd}
            maxLength={5}
            testID="hours-request-end"
          />
        </View>
      </View>
      <TextField
        label={t('hours.requestReason')}
        value={reason}
        onChangeText={setReason}
        maxLength={1000}
        testID="hours-request-reason"
      />
      {error ? <Banner tone="danger" text={error} testID="hours-request-error" /> : null}
      <AppButton
        label={t('hours.requestSend')}
        onPress={() => void submit()}
        testID="hours-request-send"
      />
      <AppButton
        variant="secondary"
        label={t('common.cancel')}
        onPress={() => setOpen(false)}
        testID="hours-request-cancel"
      />
    </Card>
  );
}

const styles = StyleSheet.create({
  day: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.sm, flexWrap: 'wrap' },
  dayLabel: { fontSize: 16, color: colors.text },
  dayHours: { fontSize: 16, color: colors.text, fontWeight: '600' },
  total: { fontSize: 18, fontWeight: '700', color: colors.text, paddingTop: spacing.sm },
  request: { fontSize: 15, color: colors.text },
  hint: { fontSize: 15, color: colors.mutedText },
  times: { flexDirection: 'row', gap: spacing.sm },
  time: { flex: 1 },
});
