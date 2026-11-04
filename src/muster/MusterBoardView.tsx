import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import type { MusterCounts } from '@sitemuster/shared';

import { errorMessageKey } from '../api/errors';
import { queryKeys } from '../api/hooks';
import type { MusterBoard, MusterMemberRow, MusterMemberStatus } from '../api/types';
import { AppButton } from '../components/AppButton';
import { Banner } from '../components/Banner';
import { Card } from '../components/Card';
import { ChipGroup } from '../components/ChipGroup';
import { SyncStatusCard } from '../components/SyncStatusCard';
import { Heading } from '../components/Typography';
import { OutcomeLine } from '../fallbacks/OutcomeLine';
import { effectiveOutcome } from '../outbox/outbox';
import { useOutbox } from '../state/outbox';
import { colors, spacing } from '../theme';
import {
  filterMembers,
  latestCheckFor,
  type MemberFilter,
  musterEntries,
  pendingChecks,
} from './format';

/**
 * Refetches the muster reads when one of this phone's checks gets its server answer, so the row
 * shows the server status next to "recorded" instead of waiting for the next refresh.
 */
export function useRefetchOnSettled(musterId: string, keys: readonly (readonly unknown[])[]) {
  const outbox = useOutbox();
  const queryClient = useQueryClient();
  const settled = musterEntries(outbox.entries, musterId).filter(
    (entry) => effectiveOutcome(entry) !== 'PENDING',
  ).length;
  const seen = useRef(settled);
  useEffect(() => {
    if (settled > seen.current) {
      for (const queryKey of keys) void queryClient.invalidateQueries({ queryKey });
    }
    seen.current = settled;
  }, [settled, keys, queryClient]);
}

/** Time of day on this phone (the commander is on site; the report carries full instants). */
export function useMusterTime(): (iso: string) => string {
  const { i18n } = useTranslation();
  return (iso) =>
    new Date(iso).toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' });
}

/** Where a person was when the muster started, in words. */
export function useSourceText(): (source: string) => string {
  const { t, i18n } = useTranslation();
  return (source) => {
    if (source.startsWith('ONSITE_')) {
      const method = source.slice('ONSITE_'.length);
      const how = i18n.exists(`source.${method}`)
        ? t(`source.${method}`)
        : t('muster.source.estimated');
      return t('muster.source.onsite', { how });
    }
    if (i18n.exists(`muster.source.${source}`)) return t(`muster.source.${source}`);
    if (i18n.exists(`presence.${source}`)) return t(`presence.${source}`);
    return t('muster.source.other');
  };
}

const STATUS_STYLE: Record<MusterMemberStatus, { color: string }> = {
  VERIFIED_ACCOUNTED: { color: colors.successText },
  SELF_REPORTED_SAFE: { color: colors.warningText },
  STATUS_UNKNOWN: { color: colors.warningText },
  UNACCOUNTED: { color: colors.dangerText },
};

function CountLine({
  label,
  value,
  tone,
  testID,
}: {
  label: string;
  value: number;
  tone?: 'success' | 'warning' | 'danger';
  testID: string;
}) {
  const color =
    tone === 'success'
      ? colors.successText
      : tone === 'warning'
        ? colors.warningText
        : tone === 'danger'
          ? colors.dangerText
          : colors.text;
  return (
    <Text style={[styles.count, { color }]} testID={testID}>
      {`${label}: ${value}`}
    </Text>
  );
}

/**
 * Server counts, kept apart by kind of evidence: seen at the assembly point (physical check),
 * said safe in the app (NOT a physical check), unknown and not accounted for; visitors separately.
 */
export function MusterCounters({ counts }: { counts: MusterCounts }) {
  const { t } = useTranslation();
  return (
    <Card testID="muster-counts">
      <Heading>{t('muster.workers')}</Heading>
      <CountLine
        label={t('muster.counts.verified')}
        value={counts.workers.verified}
        tone="success"
        testID="muster-count-verified"
      />
      <CountLine
        label={t('muster.counts.selfReported')}
        value={counts.workers.self_reported}
        tone="warning"
        testID="muster-count-self"
      />
      <CountLine
        label={t('muster.counts.unknown')}
        value={counts.workers.unknown}
        tone="warning"
        testID="muster-count-unknown"
      />
      <CountLine
        label={t('muster.counts.unaccounted')}
        value={counts.workers.unaccounted}
        tone="danger"
        testID="muster-count-unaccounted"
      />
      <CountLine
        label={t('muster.counts.total')}
        value={counts.workers.total}
        testID="muster-count-total"
      />
      <Text style={styles.hint}>
        {t('muster.counts.detectedAtStart', { count: counts.workers.detected_at_start })}
      </Text>
      <Heading>{t('muster.visitors')}</Heading>
      <CountLine
        label={t('muster.counts.visitorsVerified')}
        value={counts.visitors.verified}
        tone="success"
        testID="muster-count-visitors-verified"
      />
      <CountLine
        label={t('muster.counts.visitorsUnaccounted')}
        value={counts.visitors.unaccounted}
        tone="danger"
        testID="muster-count-visitors-unaccounted"
      />
    </Card>
  );
}

function MemberRow({
  member,
  musterActive,
  canVerify,
  onVerify,
  musterId,
}: {
  member: MusterMemberRow;
  musterActive: boolean;
  canVerify: boolean;
  onVerify: (member: MusterMemberRow) => void;
  musterId: string;
}) {
  const { t } = useTranslation();
  const outbox = useOutbox();
  const time = useMusterTime();
  const sourceText = useSourceText();
  const entry = latestCheckFor(outbox.entries, musterId, member.member_id);
  const waitingOrDone = entry !== null && effectiveOutcome(entry) !== 'REJECTED';
  const group = member.company_name ?? member.organization ?? t('muster.noCompany');
  return (
    <View style={styles.member} testID={`muster-member-${member.member_id}`}>
      <Text style={styles.name}>
        {member.kind === 'VISITOR' ? `${member.name} · ${t('muster.visitorTag')}` : member.name}
      </Text>
      <Text style={styles.hint}>{group}</Text>
      <Text
        style={[styles.status, STATUS_STYLE[member.status]]}
        testID={`muster-status-${member.member_id}`}
      >
        {t(`muster.status.${member.status}`)}
      </Text>
      <Text style={styles.hint}>
        {member.kind === 'VISITOR' && member.last_detection_at
          ? t('muster.visitorSince', { time: time(member.last_detection_at) })
          : sourceText(member.source)}
      </Text>
      {member.kind === 'WORKER' && member.last_detection_at ? (
        <Text style={styles.hint}>
          {t('muster.lastSeen', { time: time(member.last_detection_at) })}
        </Text>
      ) : null}
      {member.push ? <Text style={styles.hint}>{t(`muster.push.${member.push}`)}</Text> : null}
      {member.last_response ? (
        <Text style={styles.hint}>
          {t('muster.lastResponse', {
            action: t(`muster.action.${member.last_response.action}`),
            channel: t(`muster.channel.${member.last_response.channel}`),
            time: time(member.last_response.at),
          })}
        </Text>
      ) : null}
      {entry ? <OutcomeLine entry={entry} testID={`muster-outcome-${member.member_id}`} /> : null}
      {musterActive && canVerify && member.status !== 'VERIFIED_ACCOUNTED' && !waitingOrDone ? (
        <AppButton
          variant="secondary"
          label={t('muster.markSeen')}
          accessibilityHint={t('muster.markSeenHelp')}
          onPress={() => onVerify(member)}
          testID={`muster-seen-${member.member_id}`}
        />
      ) : null}
    </View>
  );
}

/**
 * The live muster board for the safety team (all people) or a foreman (own company only). A
 * "seen at the assembly point" tap goes through the offline outbox and reads "waiting to sync"
 * (PENDING_SYNC) until the server answers; it is never added into the server counts locally.
 */
export function MusterBoardView({
  board,
  projectId,
  canVerify,
  testID = 'muster-board',
}: {
  board: MusterBoard;
  projectId: string;
  canVerify: (member: MusterMemberRow) => boolean;
  testID?: string;
}) {
  const { t } = useTranslation();
  const outbox = useOutbox();
  const time = useMusterTime();
  const [filter, setFilter] = useState<MemberFilter>('OPEN');
  const [message, setMessage] = useState<{ tone: 'info' | 'danger'; text: string } | null>(null);
  const pending = pendingChecks(outbox.entries, board.muster_id);
  const members = filterMembers(board.members, filter);
  const [refetchKeys] = useState(() => [
    queryKeys.musterOf(projectId),
    queryKeys.foremanMuster(board.muster_id),
  ]);
  useRefetchOnSettled(board.muster_id, refetchKeys);
  const hasVisitors = board.members.some((member) => member.kind === 'VISITOR');

  const verify = async (member: MusterMemberRow) => {
    try {
      await outbox.enqueue(
        {
          project_id: projectId,
          operation_type: 'MUSTER_PHYSICAL_VERIFY',
          observed_at: new Date().toISOString(),
          payload: {
            muster_id: board.muster_id,
            snapshot_member_id: member.member_id,
            action: 'PHYSICAL_VERIFICATION',
          },
        },
        { title: member.name },
      );
      setMessage({ tone: 'info', text: t('muster.queued') });
    } catch (error) {
      setMessage({ tone: 'danger', text: t(errorMessageKey(error)) });
    }
  };

  return (
    <View style={styles.stack} testID={testID}>
      <Heading>{board.incident_label}</Heading>
      <Text style={styles.hint}>{t('muster.startedAt', { time: time(board.started_at) })}</Text>
      <Text style={styles.hint} testID={`${testID}-evaluated`}>
        {t('muster.updatedAt', { time: time(board.evaluated_at) })}
      </Text>
      {board.counts ? <MusterCounters counts={board.counts} /> : null}
      {pending > 0 ? (
        <Banner
          tone="warning"
          text={t('muster.localPending', { count: pending })}
          testID={`${testID}-pending`}
        />
      ) : null}
      {board.push ? (
        <Card testID={`${testID}-push`}>
          <Heading>{t('muster.pushTitle')}</Heading>
          <Text style={styles.line} testID={`${testID}-push-line`}>
            {t('muster.pushLine', {
              sent: board.push.sent,
              failed: board.push.failed,
              noDevice: board.push.no_device,
            })}
          </Text>
          <Text style={styles.hint}>{t('muster.pushNote')}</Text>
        </Card>
      ) : null}
      {board.companies && board.companies.length > 0 ? (
        <Card testID={`${testID}-companies`}>
          <Heading>{t('muster.companies')}</Heading>
          {board.companies.map((company) => (
            <Text key={company.company_id ?? 'none'} style={styles.line}>
              {t('muster.companyLine', {
                company: company.company_name ?? t('muster.noCompany'),
                verified: company.verified,
                self: company.self_reported,
                unknown: company.unknown,
                unaccounted: company.unaccounted,
                total: company.total,
              })}
            </Text>
          ))}
        </Card>
      ) : null}
      <Card testID={`${testID}-people`}>
        <Heading>{t('muster.people')}</Heading>
        <ChipGroup
          label={t('muster.filter')}
          options={[
            { value: 'OPEN' as const, label: t('muster.filterOpen') },
            { value: 'ALL' as const, label: t('muster.filterAll') },
            ...(hasVisitors
              ? [{ value: 'VISITORS' as const, label: t('muster.filterVisitors') }]
              : []),
          ]}
          selected={[filter]}
          onToggle={setFilter}
          testID={`${testID}-filter`}
        />
        {members.length === 0 ? <Text style={styles.hint}>{t('muster.nobody')}</Text> : null}
        {members.map((member) => (
          <MemberRow
            key={member.member_id}
            member={member}
            musterActive={board.status === 'ACTIVE'}
            canVerify={canVerify(member)}
            onVerify={(row) => void verify(row)}
            musterId={board.muster_id}
          />
        ))}
      </Card>
      {message ? (
        <Banner tone={message.tone} text={message.text} testID={`${testID}-message`} />
      ) : null}
      <SyncStatusCard />
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: spacing.sm },
  count: { fontSize: 18, fontWeight: '700' },
  hint: { fontSize: 15, color: colors.mutedText },
  line: { fontSize: 16, color: colors.text },
  member: {
    paddingVertical: spacing.sm,
    gap: 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  name: { fontSize: 17, fontWeight: '600', color: colors.text },
  status: { fontSize: 16, fontWeight: '700' },
});
