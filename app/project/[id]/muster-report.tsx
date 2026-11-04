import { useQueryClient } from '@tanstack/react-query';
import { randomUUID } from 'expo-crypto';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Share, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { errorMessageKey } from '../../../src/api/errors';
import { queryKeys, useMusterReport } from '../../../src/api/hooks';
import type { MusterReportView } from '../../../src/api/types';
import { AppButton } from '../../../src/components/AppButton';
import { Banner } from '../../../src/components/Banner';
import { Card } from '../../../src/components/Card';
import { ChipGroup } from '../../../src/components/ChipGroup';
import { QueryState } from '../../../src/components/QueryState';
import { Screen } from '../../../src/components/Screen';
import { StaffGate } from '../../../src/components/StaffGate';
import { TextField } from '../../../src/components/TextField';
import { Heading, Title } from '../../../src/components/Typography';
import { musterSummaryText, STATUS_ORDER } from '../../../src/muster/format';
import { MusterCounters, useSourceText } from '../../../src/muster/MusterBoardView';
import { formatInstant } from '../../../src/projects/format';
import { useApi } from '../../../src/state/auth';
import { colors, spacing } from '../../../src/theme';

export default function MusterReportRoute() {
  return (
    <StaffGate>
      <MusterReport />
    </StaffGate>
  );
}

/**
 * The immutable closing report (docs/spec/12 "Close-out and immutable report"): the frozen list,
 * every response with who and how, the people never accounted for, visitors and the alert
 * limits. It never changes; a correction is appended below it with the author and time.
 */
function MusterReport() {
  const { t, i18n } = useTranslation();
  const { id, musterId, closed } = useLocalSearchParams<{
    id: string;
    musterId: string;
    closed?: string;
  }>();
  const report = useMusterReport(id, musterId);
  const sourceText = useSourceText();
  const [shareError, setShareError] = useState<string | null>(null);
  const when = (iso: string) => formatInstant(iso, undefined, i18n.language);
  const data = report.data;

  const share = async (view: MusterReportView) => {
    setShareError(null);
    try {
      await Share.share({
        title: t('muster.report.title'),
        message: musterSummaryText(view, t, when),
      });
    } catch (error) {
      setShareError(t(errorMessageKey(error)));
    }
  };

  return (
    <Screen testID="muster-report-screen">
      <Title>{t('muster.report.title')}</Title>
      {closed === '1' ? (
        <Banner tone="success" text={t('muster.closed')} testID="muster-report-closed" />
      ) : null}
      <QueryState
        isLoading={report.isLoading}
        error={report.error}
        onRetry={() => void report.refetch()}
      />
      {data ? (
        <>
          <Banner tone="warning" text={t('muster.report.notice')} testID="muster-report-notice" />
          <Card testID="muster-report-summary">
            <Heading>{`${data.report.project_name} · ${data.report.incident_label}`}</Heading>
            <Text style={styles.line}>
              {t('muster.report.started', {
                time: when(data.report.started_at),
                who: data.report.started_by ?? t('muster.report.unknownPerson'),
              })}
            </Text>
            <Text style={styles.line}>
              {t('muster.report.ended', {
                time: when(data.report.ended_at),
                who: data.report.ended_by ?? t('muster.report.unknownPerson'),
              })}
            </Text>
            <Text style={styles.line} testID="muster-report-note">
              {t('muster.report.note', { note: data.report.closing_note })}
            </Text>
            <Text style={styles.hint}>
              {data.report.acknowledged_incomplete
                ? t('muster.report.incomplete')
                : t('muster.report.complete')}
            </Text>
            <Text style={styles.hint}>
              {t('muster.report.pushLimits', {
                sent: data.report.push.sent,
                failed: data.report.push.failed,
                noDevice: data.report.push.no_device,
                notAttempted: data.report.push.not_attempted,
              })}
            </Text>
            <Text style={styles.hint} testID="muster-report-digest">
              {t('muster.report.digest', { digest: data.digest.slice(0, 16) })}
            </Text>
          </Card>
          <MusterCounters counts={data.report.counts} />
          <Card testID="muster-report-members">
            <Heading>{t('muster.report.members')}</Heading>
            {[...data.report.members]
              .sort(
                (a, b) =>
                  STATUS_ORDER.indexOf(a.final_status) - STATUS_ORDER.indexOf(b.final_status) ||
                  a.name.localeCompare(b.name),
              )
              .map((member, index) => (
                <View key={`${member.name}-${index}`} style={styles.member}>
                  <Text style={styles.name}>
                    {t('muster.report.memberLine', {
                      name:
                        member.kind === 'VISITOR'
                          ? `${member.name} · ${t('muster.visitorTag')}`
                          : member.name,
                      group: member.company_name ?? member.organization ?? t('muster.noCompany'),
                      status: t(`muster.status.${member.final_status}`),
                    })}
                  </Text>
                  <Text style={styles.hint}>
                    {`${t('muster.report.initial', {
                      status: t(`muster.status.${member.initial_status}`),
                    })} · ${sourceText(member.source)}`}
                  </Text>
                  {member.responses.map((response, at) => (
                    <Text key={`${response.at}-${at}`} style={styles.hint}>
                      {t('muster.report.response', {
                        action: t(`muster.action.${response.action}`),
                        who: response.responder ?? t('muster.report.theWorker'),
                        channel: t(`muster.channel.${response.channel}`),
                        time: when(response.at),
                      })}
                    </Text>
                  ))}
                </View>
              ))}
          </Card>
          <Amendments view={data} projectId={id} musterId={musterId} />
          <AppButton
            label={t('muster.report.share')}
            onPress={() => void share(data)}
            testID="muster-report-share"
          />
          {shareError ? <Banner tone="danger" text={shareError} /> : null}
        </>
      ) : null}
      <AppButton
        variant="secondary"
        label={t('common.back')}
        onPress={() =>
          router.canGoBack()
            ? router.back()
            : router.replace({ pathname: '/project/[id]/muster', params: { id } })
        }
        testID="muster-report-back"
      />
    </Screen>
  );
}

function Amendments({
  view,
  projectId,
  musterId,
}: {
  view: MusterReportView;
  projectId: string;
  musterId: string;
}) {
  const { t, i18n } = useTranslation();
  const api = useApi();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [member, setMember] = useState<string>('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  // One event id per correction being written: a retry is never appended twice.
  const [eventUuid, setEventUuid] = useState(() => randomUUID());
  const when = (iso: string) => formatInstant(iso, undefined, i18n.language);
  const members = useMembersForAmendment(view);

  const send = async () => {
    if (note.trim().length < 3) {
      setMessage({ tone: 'danger', text: t('muster.noteNeeded') });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await api.amendMuster({
        musterId,
        memberId: member === '' ? null : member,
        note: note.trim(),
        eventUuid,
      });
      setEventUuid(randomUUID());
      setNote('');
      setMember('');
      setOpen(false);
      setMessage({ tone: 'success', text: t('muster.report.amended') });
      await queryClient.invalidateQueries({
        queryKey: queryKeys.musterReport(projectId, musterId),
      });
    } catch (error) {
      setMessage({ tone: 'danger', text: t(errorMessageKey(error)) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card testID="muster-amendments">
      <Heading>{t('muster.report.amendments')}</Heading>
      {view.amendments.length === 0 ? (
        <Text style={styles.hint}>{t('muster.report.noAmendments')}</Text>
      ) : null}
      {view.amendments.map((amendment) => (
        <View key={amendment.digest} style={styles.member} testID="muster-amendment">
          <Text style={styles.name}>
            {t('muster.report.amendmentLine', {
              kind:
                amendment.kind === 'LATE_RESPONSE'
                  ? t('muster.report.late')
                  : t('muster.report.correction'),
              time: when(amendment.observed_at),
              who: amendment.actor ?? t('muster.report.unknownPerson'),
            })}
          </Text>
          {amendment.member_name ? <Text style={styles.line}>{amendment.member_name}</Text> : null}
          {amendment.action ? (
            <Text style={styles.hint}>{t(`muster.action.${amendment.action}`)}</Text>
          ) : null}
          {amendment.note ? <Text style={styles.line}>{amendment.note}</Text> : null}
        </View>
      ))}
      {view.can_amend && !open ? (
        <AppButton
          variant="secondary"
          label={t('muster.report.amendTitle')}
          onPress={() => setOpen(true)}
          testID="muster-amend-open"
        />
      ) : null}
      {view.can_amend && open ? (
        <>
          <Text style={styles.hint}>{t('muster.report.amendHelp')}</Text>
          <ChipGroup
            label={t('muster.report.amendPerson')}
            options={[{ value: '', label: t('muster.report.amendNobody') }, ...members]}
            selected={[member]}
            onToggle={setMember}
            testID="muster-amend-person"
          />
          <TextField
            label={t('muster.report.amendNote')}
            value={note}
            onChangeText={setNote}
            maxLength={2000}
            testID="muster-amend-note"
          />
          <AppButton
            label={t('muster.report.amendSend')}
            onPress={() => void send()}
            disabled={busy}
            testID="muster-amend-send"
          />
          <AppButton
            variant="secondary"
            label={t('common.cancel')}
            onPress={() => setOpen(false)}
            testID="muster-amend-cancel"
          />
        </>
      ) : null}
      {message ? (
        <Banner tone={message.tone} text={message.text} testID="muster-amend-message" />
      ) : null}
    </Card>
  );
}

/** People a correction can be about: everyone on the frozen list. */
function useMembersForAmendment(view: MusterReportView): { value: string; label: string }[] {
  return view.report.members.map((member) => ({ value: member.member_id, label: member.name }));
}

const styles = StyleSheet.create({
  line: { fontSize: 16, color: colors.text },
  hint: { fontSize: 15, color: colors.mutedText },
  member: {
    paddingVertical: spacing.sm,
    gap: 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  name: { fontSize: 16, fontWeight: '600', color: colors.text },
});
