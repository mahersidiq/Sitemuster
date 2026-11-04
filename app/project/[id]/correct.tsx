import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { errorMessageKey } from '../../../src/api/errors';
import { useCorrectableSessions, useProject } from '../../../src/api/hooks';
import { AppButton } from '../../../src/components/AppButton';
import { Banner } from '../../../src/components/Banner';
import { Card } from '../../../src/components/Card';
import { ChipGroup } from '../../../src/components/ChipGroup';
import { QueryState } from '../../../src/components/QueryState';
import { Screen } from '../../../src/components/Screen';
import { StaffGate } from '../../../src/components/StaffGate';
import { SyncStatusCard } from '../../../src/components/SyncStatusCard';
import { TextField } from '../../../src/components/TextField';
import { Body, Heading, Title } from '../../../src/components/Typography';
import { correctionTimes, localDateTime } from '../../../src/fallbacks/fallbacks';
import { OutcomeLine } from '../../../src/fallbacks/OutcomeLine';
import { useOutbox } from '../../../src/state/outbox';
import { colors, spacing } from '../../../src/theme';

export default function CorrectRoute() {
  return (
    <StaffGate>
      <Correct />
    </StaffGate>
  );
}

const MISSING = 'missing';

/**
 * Manual correction by the superintendent (docs/spec/04: reason, actor, history, proper role).
 * It changes the arrival or departure of one visit, or adds a missing visit; the original record
 * stays and the server refuses anything that would overlap another visit (decision #99).
 */
function Correct() {
  const { t } = useTranslation();
  const { id, workerId, name, requestId, sessionId, proposedStart, proposedEnd } =
    useLocalSearchParams<{
      id: string;
      workerId: string;
      name?: string;
      /** Approving a worker or foreman correction request (Milestone 10). */
      requestId?: string;
      sessionId?: string;
      proposedStart?: string;
      proposedEnd?: string;
    }>();
  const project = useProject(id);
  const sessions = useCorrectableSessions(id, workerId);
  const outbox = useOutbox();
  const zone = project.data?.project.iana_timezone ?? 'UTC';
  const [target, setTarget] = useState<string>(sessionId ? sessionId : MISSING);
  // null = not edited yet: a request's proposal fills the form (in the project time zone).
  const [dateInput, setDate] = useState<string | null>(null);
  const [startInput, setStart] = useState<string | null>(null);
  const [endInput, setEnd] = useState<string | null>(null);
  const proposal = useMemo(() => {
    if (!requestId || !project.data) return { date: '', start: '', end: '' };
    const from = proposedStart ? localDateTime(proposedStart, zone) : null;
    const to = proposedEnd ? localDateTime(proposedEnd, zone) : null;
    return { date: (from ?? to)?.date ?? '', start: from?.time ?? '', end: to?.time ?? '' };
  }, [requestId, project.data, proposedStart, proposedEnd, zone]);
  const date = dateInput ?? proposal.date;
  const start = startInput ?? proposal.start;
  const end = endInput ?? proposal.end;
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const chosen = sessions.data?.find((s) => s.session_id === target) ?? null;
  const line = (startAt: string, endAt: string | null) => {
    const from = localDateTime(startAt, zone);
    const to = endAt ? localDateTime(endAt, zone).time : t('correction.onSite');
    return `${from.date} ${from.time} – ${to}`;
  };
  const mine = useMemo(
    () =>
      outbox.entries
        .filter(
          (entry) =>
            entry.event.project_id === id &&
            entry.event.operation_type === 'MANUAL_ATTENDANCE_CORRECTION' &&
            entry.event.payload.worker_id === workerId,
        )
        .reverse(),
    [outbox.entries, id, workerId],
  );

  const choose = (value: string) => {
    setTarget(value);
    const session = sessions.data?.find((s) => s.session_id === value);
    if (session) {
      const from = localDateTime(session.start_at, zone);
      setDate(from.date);
      setStart(from.time);
      setEnd(session.end_at ? localDateTime(session.end_at, zone).time : '');
    } else {
      setStart('');
      setEnd('');
    }
  };

  const submit = async () => {
    setError(null);
    const times = correctionTimes({ date, start, end, timeZone: zone });
    // A missing visit needs both ends; a correction changes at least one.
    if (
      !times ||
      reason.trim().length < 3 ||
      (target === MISSING && (!times.startAt || !times.endAt))
    ) {
      setError(t('correction.invalid'));
      return;
    }
    try {
      await outbox.enqueue(
        {
          project_id: id,
          operation_type: 'MANUAL_ATTENDANCE_CORRECTION',
          observed_at: new Date().toISOString(),
          payload: {
            worker_id: workerId,
            ...(chosen ? { session_id: chosen.session_id } : {}),
            ...(times.startAt ? { corrected_start_at: times.startAt } : {}),
            ...(times.endAt ? { corrected_end_at: times.endAt } : {}),
            reason: reason.trim(),
            ...(requestId ? { request_id: requestId } : {}),
          },
        },
        { title: name ?? workerId },
      );
      setReason('');
    } catch (caught) {
      setError(t(errorMessageKey(caught)));
    }
  };

  return (
    <Screen testID="correct-screen">
      <Title>{t('correction.title')}</Title>
      <Body>{t('correction.worker', { name: name ?? workerId })}</Body>
      {requestId ? (
        <Banner tone="info" text={t('correction.fromRequest')} testID="correct-from-request" />
      ) : null}
      <QueryState
        isLoading={sessions.isLoading}
        error={sessions.error}
        onRetry={() => void sessions.refetch()}
      />
      <Card testID="correct-sessions">
        <Heading>{t('correction.pickSession')}</Heading>
        {sessions.data && sessions.data.length === 0 ? (
          <Text style={styles.hint}>{t('correction.none')}</Text>
        ) : null}
        <ChipGroup
          label={t('correction.pickSession')}
          options={[
            ...(sessions.data ?? []).map((session) => ({
              value: session.session_id,
              label: line(session.start_at, session.end_at),
            })),
            { value: MISSING, label: t('correction.noSession') },
          ]}
          selected={[target]}
          onToggle={choose}
          testID="correct-target"
        />
      </Card>
      <Card testID="correct-form">
        <Text style={styles.hint}>{t('correction.zone', { zone })}</Text>
        <TextField
          label={t('correction.date')}
          value={date}
          onChangeText={setDate}
          maxLength={10}
          testID="correct-date"
        />
        <View style={styles.times}>
          <View style={styles.time}>
            <TextField
              label={t('correction.start')}
              value={start}
              onChangeText={setStart}
              maxLength={5}
              testID="correct-start"
            />
          </View>
          <View style={styles.time}>
            <TextField
              label={t('correction.end')}
              value={end}
              onChangeText={setEnd}
              maxLength={5}
              testID="correct-end"
            />
          </View>
        </View>
        <TextField
          label={t('correction.reason')}
          value={reason}
          onChangeText={setReason}
          maxLength={1000}
          testID="correct-reason"
        />
        <Text style={styles.hint}>{t('correction.audit')}</Text>
        <AppButton
          label={t('correction.submit')}
          onPress={() => void submit()}
          testID="correct-submit"
        />
      </Card>
      {error ? <Banner tone="danger" text={error} testID="correct-error" /> : null}
      {mine.map((entry) => (
        <Card key={entry.event.event_uuid} testID="correct-result">
          <OutcomeLine entry={entry} />
        </Card>
      ))}
      <SyncStatusCard />
      <AppButton
        variant="secondary"
        label={t('common.back')}
        onPress={() => router.back()}
        testID="correct-back"
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  hint: { fontSize: 15, color: colors.mutedText },
  times: { flexDirection: 'row', gap: spacing.sm },
  time: { flex: 1 },
});
