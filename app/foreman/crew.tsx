import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { TRACKING_DEFAULTS } from '@sitemuster/shared';

import { errorMessageKey } from '../../src/api/errors';
import { useCrew } from '../../src/api/hooks';
import { AppButton } from '../../src/components/AppButton';
import { Banner } from '../../src/components/Banner';
import { Card } from '../../src/components/Card';
import { ChipGroup } from '../../src/components/ChipGroup';
import { LoadingScreen } from '../../src/components/LoadingScreen';
import { QueryState } from '../../src/components/QueryState';
import { Screen } from '../../src/components/Screen';
import { SyncStatusCard } from '../../src/components/SyncStatusCard';
import { ToggleRow } from '../../src/components/ToggleRow';
import { Body, Heading, Title } from '../../src/components/Typography';
import { OutcomeLine, useReasonText } from '../../src/fallbacks/OutcomeLine';
import { useAuth } from '../../src/state/auth';
import { useOutbox } from '../../src/state/outbox';
import { colors, spacing } from '../../src/theme';

const MAX = TRACKING_DEFAULTS.foreman_bulk_max_workers;

export default function CrewRoute() {
  const { state, api } = useAuth();
  if (api && state.status === 'loading') return <LoadingScreen />;
  if (!api || state.status !== 'signed_in' || !state.access.worker_profile_id) {
    return <Redirect href="/" />;
  }
  return <Crew />;
}

type Direction = 'ENTRY' | 'EXIT';
type Method = 'PHYSICAL_CONFIRMATION' | 'FOREMAN_REPORT';

/**
 * Foreman crew sign-in/out (docs/spec/04): only approved workers of the foreman's own company on
 * this project, at most 100 at a time, one result per named worker. Offline it reads "waiting to
 * sync", never "confirmed"; a foreman record is estimated attendance, not payroll proof.
 */
function Crew() {
  const { t } = useTranslation();
  const reasonText = useReasonText();
  const { projectId, companyId, projectName, companyName } = useLocalSearchParams<{
    projectId: string;
    companyId: string;
    projectName?: string;
    companyName?: string;
  }>();
  const crew = useCrew(projectId, companyId);
  const outbox = useOutbox();
  const [selected, setSelected] = useState<string[]>([]);
  const [direction, setDirection] = useState<Direction>('ENTRY');
  const [method, setMethod] = useState<Method>('PHYSICAL_CONFIRMATION');
  const [error, setError] = useState<string | null>(null);
  const members = crew.data ?? [];
  const nameOf = (workerId: string) =>
    members.find((member) => member.worker_id === workerId)?.name ?? workerId.slice(0, 8);

  const batches = useMemo(
    () =>
      outbox.entries
        .filter(
          (entry) =>
            entry.event.project_id === projectId &&
            (entry.event.operation_type === 'FOREMAN_BULK_ENTRY' ||
              entry.event.operation_type === 'FOREMAN_BULK_EXIT'),
        )
        .reverse()
        .slice(0, 5),
    [outbox.entries, projectId],
  );

  const toggle = (workerId: string, on: boolean) => {
    setError(null);
    setSelected((current) => {
      if (!on) return current.filter((id) => id !== workerId);
      if (current.length >= MAX) {
        setError(t('crew.max', { max: MAX }));
        return current;
      }
      return [...current, workerId];
    });
  };

  const submit = async () => {
    setError(null);
    if (selected.length === 0) {
      setError(t('crew.nothingSelected'));
      return;
    }
    try {
      await outbox.enqueue(
        {
          project_id: projectId,
          operation_type: direction === 'ENTRY' ? 'FOREMAN_BULK_ENTRY' : 'FOREMAN_BULK_EXIT',
          observed_at: new Date().toISOString(),
          payload: {
            subcontractor_id: companyId,
            worker_ids: selected,
            direction,
            verification_method: method,
          },
        },
        { title: `${t(`crew.${direction}`)} · ${selected.length}` },
      );
      setSelected([]);
    } catch (caught) {
      setError(t(errorMessageKey(caught)));
    }
  };

  return (
    <Screen testID="crew-screen">
      <Title>{t('crew.title')}</Title>
      <Body>{[companyName, projectName].filter(Boolean).join(' · ')}</Body>
      <Text style={styles.hint}>{t('crew.help')}</Text>
      <QueryState
        isLoading={crew.isLoading}
        error={crew.error}
        onRetry={() => void crew.refetch()}
      />
      {crew.data && members.length === 0 ? <Body>{t('crew.none')}</Body> : null}
      {members.length > 0 ? (
        <Card testID="crew-list">
          <AppButton
            variant="secondary"
            label={t('crew.selectAll')}
            onPress={() => setSelected(members.slice(0, MAX).map((member) => member.worker_id))}
            testID="crew-select-all"
          />
          <Text style={styles.hint}>{t('crew.selected', { count: selected.length })}</Text>
          {members.map((member) => (
            <ToggleRow
              key={member.worker_id}
              label={[member.name, member.trade].filter(Boolean).join(' · ')}
              value={selected.includes(member.worker_id)}
              onValueChange={(on) => toggle(member.worker_id, on)}
              testID={`crew-${member.worker_id}`}
            />
          ))}
        </Card>
      ) : null}
      <Card testID="crew-options">
        <Text style={styles.label}>{t('crew.direction')}</Text>
        <ChipGroup
          label={t('crew.direction')}
          options={[
            { value: 'ENTRY' as const, label: t('crew.ENTRY') },
            { value: 'EXIT' as const, label: t('crew.EXIT') },
          ]}
          selected={[direction]}
          onToggle={setDirection}
          testID="crew-direction"
        />
        <Text style={styles.label}>{t('crew.method')}</Text>
        <ChipGroup
          label={t('crew.method')}
          options={[
            { value: 'PHYSICAL_CONFIRMATION' as const, label: t('crew.PHYSICAL_CONFIRMATION') },
            { value: 'FOREMAN_REPORT' as const, label: t('crew.FOREMAN_REPORT') },
          ]}
          selected={[method]}
          onToggle={setMethod}
          testID="crew-method"
        />
        <AppButton label={t('crew.submit')} onPress={() => void submit()} testID="crew-submit" />
        <Text style={styles.hint}>{t('crew.estimateNote')}</Text>
      </Card>
      {error ? <Banner tone="danger" text={error} testID="crew-error" /> : null}
      {batches.length > 0 ? (
        <Card testID="crew-results">
          <Heading>{t('crew.results')}</Heading>
          {batches.map((entry) => (
            <View key={entry.event.event_uuid} style={styles.batch} testID="crew-batch">
              <Text style={styles.line}>{entry.label.title}</Text>
              <OutcomeLine entry={entry} />
              {(entry.result?.children ?? []).map((child) => (
                <Text
                  key={child.child_event_uuid}
                  style={[styles.child, child.status === 'rejected' && styles.childRejected]}
                  testID={`crew-child-${child.worker_id}`}
                >
                  {child.status === 'rejected'
                    ? `${nameOf(child.worker_id)}: ${reasonText(child.reason)}`
                    : t('outbox.acceptedFor', { name: nameOf(child.worker_id) })}
                </Text>
              ))}
            </View>
          ))}
        </Card>
      ) : null}
      <SyncStatusCard />
      <AppButton
        variant="secondary"
        label={t('common.back')}
        onPress={() => router.back()}
        testID="crew-back"
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  label: { fontSize: 16, fontWeight: '600', color: colors.text },
  line: { fontSize: 16, color: colors.text },
  hint: { fontSize: 15, color: colors.mutedText },
  batch: { paddingVertical: spacing.xs, gap: 2 },
  child: { fontSize: 15, color: colors.successText },
  childRejected: { color: colors.dangerText },
});
