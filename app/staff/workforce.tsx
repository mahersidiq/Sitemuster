import { useQueryClient } from '@tanstack/react-query';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { queryKeys, useProjectDashboard, useWorkforceRoster } from '../../src/api/hooks';
import type { WorkforceMember } from '../../src/api/types';
import { AppButton } from '../../src/components/AppButton';
import { Banner } from '../../src/components/Banner';
import { Card } from '../../src/components/Card';
import { ChipGroup } from '../../src/components/ChipGroup';
import { QueryState } from '../../src/components/QueryState';
import { Screen } from '../../src/components/Screen';
import { ShellScreen } from '../../src/components/ShellScreen';
import { Heading } from '../../src/components/Typography';
import { Hint, LiveStatusLine, ProjectHeader } from '../../src/dashboard/components';
import { ROSTER_GROUPS, rosterGroup, type RosterGroup } from '../../src/dashboard/format';
import { formatInstant } from '../../src/projects/format';
import { useLiveState } from '../../src/realtime/ProjectLive';
import { useAuth } from '../../src/state/auth';
import { useSelectedProject } from '../../src/state/selected-project';
import { colors, spacing } from '../../src/theme';

export default function StaffWorkforceScreen() {
  const { t } = useTranslation();
  const { api } = useAuth();
  if (!api) {
    return (
      <ShellScreen
        testID="staff-workforce"
        title={t('staff.workforce.title')}
        body={t('staff.workforce.body')}
      />
    );
  }
  return <Workforce />;
}

type Filter = 'ALL' | RosterGroup;

/**
 * The approved roster with live presence (docs/spec/01 "roster"; decision #87). Counted people
 * first; "presence unknown" is shown as unknown, never as gone; every row says how the worker
 * was recorded and whether the phone can still record attendance.
 */
function Workforce() {
  const { t } = useTranslation();
  const { projectId } = useSelectedProject();
  const live = useLiveState();
  const queryClient = useQueryClient();
  const roster = useWorkforceRoster(projectId);
  const dashboard = useProjectDashboard(projectId);
  const [filter, setFilter] = useState<Filter>('ALL');
  const { refetch } = roster;
  useFocusEffect(
    useCallback(() => {
      if (projectId) void refetch();
    }, [projectId, refetch]),
  );
  const members = roster.data;
  const counts = useMemo(() => {
    const by = new Map<Filter, number>([['ALL', members?.length ?? 0]]);
    for (const member of members ?? []) {
      const group = rosterGroup(member);
      by.set(group, (by.get(group) ?? 0) + 1);
    }
    return by;
  }, [members]);
  const shown = (members ?? []).filter((m) => filter === 'ALL' || rosterGroup(m) === filter);
  const timeZone = dashboard.data?.project.iana_timezone;
  const pending = dashboard.data?.approvals.pending_enrollments ?? 0;

  return (
    <Screen testID="staff-workforce">
      <ProjectHeader />
      {projectId ? (
        <>
          <LiveStatusLine
            state={live}
            updatedAt={roster.dataUpdatedAt}
            error={roster.error ?? roster.failureReason}
            onRefresh={() =>
              void queryClient.invalidateQueries({ queryKey: queryKeys.workforce(projectId) })
            }
          />
          {pending > 0 ? (
            <Card testID="roster-approvals">
              <Text style={styles.line}>{t('roster.pendingApprovals', { count: pending })}</Text>
              <AppButton
                variant="secondary"
                label={t('dashboard.reviewApprovals')}
                onPress={() =>
                  router.push({ pathname: '/project/[id]/workers', params: { id: projectId } })
                }
                testID="roster-review-approvals"
              />
            </Card>
          ) : null}
          <QueryState
            isLoading={roster.isLoading}
            error={members ? null : roster.error}
            onRetry={() => void refetch()}
          />
          {members ? (
            <>
              <Hint text={t('roster.estimateNote')} />
              <ChipGroup
                label={t('roster.filter')}
                options={(['ALL', ...ROSTER_GROUPS] as Filter[]).map((value) => ({
                  value,
                  label: t(`roster.group.${value}`, { count: counts.get(value) ?? 0 }),
                }))}
                selected={[filter]}
                onToggle={setFilter}
                testID="roster-filter"
              />
              {shown.length === 0 ? <Banner tone="info" text={t('roster.empty')} /> : null}
              {shown.map((member) => (
                <MemberRow key={member.worker_id} member={member} timeZone={timeZone} />
              ))}
            </>
          ) : null}
        </>
      ) : null}
    </Screen>
  );
}

function MemberRow({
  member,
  timeZone,
}: {
  member: WorkforceMember;
  timeZone: string | undefined;
}) {
  const { t, i18n } = useTranslation();
  const warnTracking =
    member.tracking === 'CREDENTIAL_EXPIRED' ||
    member.tracking === 'CREDENTIAL_EXPIRING' ||
    member.tracking === 'MONITORING_UNAVAILABLE';
  return (
    <Card testID={`member-${member.worker_id}`}>
      <Heading>{member.legal_name}</Heading>
      <Text style={styles.hint}>
        {[member.company_name, member.trade].filter(Boolean).join(' · ')}
      </Text>
      <Text
        style={[styles.line, member.counted ? styles.onsite : styles.other]}
        testID={`member-presence-${member.worker_id}`}
      >
        {t(`presence.${member.presence}`)}
        {member.source ? ` · ${t(`source.${member.source}`)}` : ''}
      </Text>
      <View style={styles.meta}>
        {member.arrived_at ? (
          <Text style={styles.hint}>
            {t('roster.arrived', {
              time: formatInstant(member.arrived_at, timeZone, i18n.language),
            })}
          </Text>
        ) : null}
        {member.last_seen_at && !member.witnessed ? (
          // An absolute time in the project's zone: a wrong phone clock cannot mislabel it.
          <Text style={styles.hint}>
            {t('roster.lastSignal', {
              time: formatInstant(member.last_seen_at, timeZone, i18n.language),
            })}
          </Text>
        ) : null}
        {member.witnessed ? <Text style={styles.hint}>{t('roster.witnessed')}</Text> : null}
      </View>
      <Text
        style={warnTracking ? styles.warn : styles.hint}
        testID={`member-tracking-${member.worker_id}`}
      >
        {t(`trackingHealth.${member.tracking}`)}
      </Text>
    </Card>
  );
}

const styles = StyleSheet.create({
  line: { fontSize: 16, color: colors.text },
  hint: { fontSize: 14, color: colors.mutedText },
  onsite: { color: colors.successText, fontWeight: '600' },
  other: { color: colors.text },
  warn: { fontSize: 14, color: colors.warningText, fontWeight: '600' },
  meta: { gap: spacing.xs },
});
