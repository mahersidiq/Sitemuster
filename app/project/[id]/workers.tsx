import { useQueryClient } from '@tanstack/react-query';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { TRACKING_DEFAULTS } from '@sitemuster/shared';

import { errorMessageKey } from '../../../src/api/errors';
import { queryKeys, useProject, useRoster } from '../../../src/api/hooks';
import type { BulkResult, RosterEntry } from '../../../src/api/types';
import { AppButton } from '../../../src/components/AppButton';
import { Banner } from '../../../src/components/Banner';
import { Card } from '../../../src/components/Card';
import { QueryState } from '../../../src/components/QueryState';
import { Screen } from '../../../src/components/Screen';
import { StaffGate } from '../../../src/components/StaffGate';
import { TextField } from '../../../src/components/TextField';
import { ToggleRow } from '../../../src/components/ToggleRow';
import { Body, Heading, Title } from '../../../src/components/Typography';
import { useApi } from '../../../src/state/auth';
import { colors, spacing } from '../../../src/theme';

const MAX = TRACKING_DEFAULTS.orientation_bulk_approve_max;

export default function WorkersScreen() {
  return (
    <StaffGate>
      <Workers />
    </StaffGate>
  );
}

/**
 * Roster and approvals. Orientation alone never approves: staff approve (≤ 100 at a time, with a
 * result for every person) and confirm the employer as a separate step (decision #4).
 */
function Workers() {
  const { t } = useTranslation();
  const api = useApi();
  const queryClient = useQueryClient();
  const { id } = useLocalSearchParams<{ id: string }>();
  const project = useProject(id);
  const roster = useRoster(id);
  const { refetch } = roster;
  useFocusEffect(
    useCallback(() => {
      void refetch();
    }, [refetch]),
  );
  const [selected, setSelected] = useState<string[]>([]);
  const [results, setResults] = useState<BulkResult[] | null>(null);
  const [rejecting, setRejecting] = useState<RosterEntry | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canApprove = project.data?.permissions.can_run_orientation ?? false;

  const groups = useMemo(() => {
    const rows = roster.data ?? [];
    return {
      pending: rows.filter((r) => r.enrollment_status === 'PENDING'),
      approved: rows.filter((r) => r.enrollment_status === 'APPROVED'),
      inactive: rows.filter(
        (r) => r.enrollment_status === 'REJECTED' || r.enrollment_status === 'REVOKED',
      ),
    };
  }, [roster.data]);
  const selectableCount =
    groups.pending.length + groups.approved.filter((r) => r.employer_status !== 'VERIFIED').length;
  const nameOf = (enrollmentId: string) =>
    roster.data?.find((r) => r.enrollment_id === enrollmentId)?.legal_name ?? enrollmentId;

  const toggle = (enrollmentId: string, on: boolean) => {
    setSelected((current) => {
      if (!on) return current.filter((x) => x !== enrollmentId);
      if (current.length >= MAX) {
        setError(t('workers.maxSelected', { max: MAX }));
        return current;
      }
      return [...current, enrollmentId];
    });
  };

  const run = async (action: () => Promise<BulkResult[] | void>) => {
    setBusy(true);
    setError(null);
    try {
      const out = await action();
      if (out) setResults(out);
      setSelected([]);
      await queryClient.invalidateQueries({ queryKey: queryKeys.roster(id) });
    } catch (caught) {
      setError(t(errorMessageKey(caught)));
    } finally {
      setBusy(false);
    }
  };

  const row = (entry: RosterEntry, selectable: boolean) => (
    <Card key={entry.enrollment_id} testID={`roster-${entry.enrollment_id}`}>
      {selectable && canApprove ? (
        <ToggleRow
          label={entry.legal_name}
          value={selected.includes(entry.enrollment_id)}
          onValueChange={(on) => toggle(entry.enrollment_id, on)}
          testID={`select-${entry.enrollment_id}`}
        />
      ) : (
        <Heading>{entry.legal_name}</Heading>
      )}
      <Text style={styles.line}>
        {[entry.company_name, entry.trade].filter(Boolean).join(' · ')}
      </Text>
      <Text style={styles.line}>
        {t(`enrollmentStatus.${entry.enrollment_status}`)} ·{' '}
        {t(`employerStatus.${entry.employer_status}`)}
      </Text>
      <Text style={styles.hint}>
        {entry.managed_identity ? t('workers.noPhone') : t('workers.appUser')}
        {entry.consent_method ? ` · ${t(`workers.consent.${entry.consent_method}`)}` : ''}
        {entry.printed_badge_active ? ` · ${t('workers.printedBadge')}` : ''}
      </Text>
      <View style={styles.actions}>
        {entry.enrollment_status === 'PENDING' && canApprove ? (
          <AppButton
            variant="secondary"
            label={t('workers.reject')}
            onPress={() => {
              setRejecting(entry);
              setReason('');
            }}
            testID={`reject-${entry.enrollment_id}`}
          />
        ) : null}
        {entry.enrollment_status === 'APPROVED' ? (
          <AppButton
            variant="secondary"
            label={t('workers.printedBadgeAction')}
            onPress={() =>
              router.push({
                pathname: '/project/[id]/printed-badge',
                params: { id, workerId: entry.worker_id, name: entry.legal_name },
              })
            }
            testID={`printed-${entry.enrollment_id}`}
          />
        ) : null}
      </View>
    </Card>
  );

  return (
    <Screen testID="workers-screen">
      <Title>{t('workers.title')}</Title>
      {project.data ? <Body>{project.data.project.name}</Body> : null}
      <AppButton
        variant="secondary"
        label={t('workers.addNoPhone')}
        onPress={() => router.push({ pathname: '/project/[id]/add-worker', params: { id } })}
        testID="add-no-phone"
      />
      <QueryState
        isLoading={roster.isLoading}
        error={roster.error}
        onRetry={() => void refetch()}
      />

      {rejecting ? (
        <Card testID="reject-panel">
          <Heading>{t('workers.rejectTitle', { name: rejecting.legal_name })}</Heading>
          <TextField
            label={t('workers.rejectReason')}
            value={reason}
            onChangeText={setReason}
            maxLength={500}
            testID="reject-reason"
          />
          <AppButton
            label={t('workers.confirmReject')}
            onPress={() =>
              void run(async () => {
                await api.decideEnrollment(rejecting.enrollment_id, 'REJECTED', reason.trim());
                setRejecting(null);
              })
            }
            disabled={busy}
            testID="confirm-reject"
          />
          <AppButton
            variant="secondary"
            label={t('common.cancel')}
            onPress={() => setRejecting(null)}
          />
        </Card>
      ) : null}

      {canApprove && selectableCount > 0 ? (
        <View style={styles.actions}>
          {groups.pending.length > 0 ? (
            <AppButton
              variant="secondary"
              label={t('workers.selectAll', { max: MAX })}
              onPress={() => setSelected(groups.pending.slice(0, MAX).map((r) => r.enrollment_id))}
              testID="select-all"
            />
          ) : null}
          <AppButton
            label={t('workers.approveSelected', { count: selected.length })}
            onPress={() => void run(() => api.bulkApprove(id, selected))}
            disabled={busy || selected.length === 0}
            testID="approve-selected"
          />
          <AppButton
            variant="secondary"
            label={t('workers.confirmEmployerSelected', { count: selected.length })}
            onPress={() => void run(() => api.confirmEmployer(id, selected, 'VERIFIED'))}
            disabled={busy || selected.length === 0}
            testID="confirm-employer-selected"
          />
        </View>
      ) : null}
      <Heading>{t('workers.pendingTitle', { count: groups.pending.length })}</Heading>
      {groups.pending.length === 0 ? (
        <Text style={styles.hint}>{t('workers.nonePending')}</Text>
      ) : null}
      {groups.pending.map((entry) => row(entry, true))}

      {results ? (
        <Card testID="bulk-results">
          <Heading>{t('workers.resultsTitle')}</Heading>
          {results.map((r) => (
            <Text key={r.enrollment_id} style={styles.line} testID={`result-${r.enrollment_id}`}>
              {t('workers.resultLine', {
                name: nameOf(r.enrollment_id),
                result: t(`bulkResult.${r.result}`, { defaultValue: r.result }),
              })}
            </Text>
          ))}
        </Card>
      ) : null}

      <Heading>{t('workers.approvedTitle', { count: groups.approved.length })}</Heading>
      {canApprove && groups.approved.some((r) => r.employer_status !== 'VERIFIED') ? (
        <Text style={styles.hint}>{t('workers.employerHint')}</Text>
      ) : null}
      {groups.approved.map((entry) => row(entry, entry.employer_status !== 'VERIFIED'))}
      {groups.inactive.length > 0 ? <Heading>{t('workers.inactiveTitle')}</Heading> : null}
      {groups.inactive.map((entry) => row(entry, false))}
      {error ? <Banner tone="danger" text={error} testID="workers-error" /> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  line: { fontSize: 16, color: colors.text },
  hint: { fontSize: 15, color: colors.mutedText },
  actions: { gap: spacing.sm },
});
