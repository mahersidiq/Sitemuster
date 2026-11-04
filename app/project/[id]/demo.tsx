import { useQueryClient } from '@tanstack/react-query';
import { randomUUID } from 'expo-crypto';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import type { DemoAction, DemoWorker } from '@sitemuster/shared';

import { errorMessageKey } from '../../../src/api/errors';
import { queryKeys, useDemoStatus, useDemoWorkers } from '../../../src/api/hooks';
import { AppButton } from '../../../src/components/AppButton';
import { Banner } from '../../../src/components/Banner';
import { Card } from '../../../src/components/Card';
import { QueryState } from '../../../src/components/QueryState';
import { Screen } from '../../../src/components/Screen';
import { StaffGate } from '../../../src/components/StaffGate';
import { Body, Heading, Title } from '../../../src/components/Typography';
import { useApi } from '../../../src/state/auth';
import { colors, spacing } from '../../../src/theme';

export default function DemoSimulationRoute() {
  return (
    <StaffGate>
      <DemoSimulation />
    </StaffGate>
  );
}

const ON_SITE = new Set([
  'ONSITE_ESTIMATED',
  'ARRIVING',
  'UNSCHEDULED_PENDING',
  'PRESENCE_UNKNOWN',
]);

/**
 * Reviewer demo (Milestone 13, decisions #140–#143): moves a SYNTHETIC person of the allowlisted
 * demo project on or off site. The server builds every record and runs them through the production
 * pipeline; nothing here is GPS, and the server refuses any other project or person.
 */
function DemoSimulation() {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const api = useApi();
  const queryClient = useQueryClient();
  const status = useDemoStatus(id);
  const workers = useDemoWorkers(id, status.demo && status.active);
  const { refetch } = workers;
  const [busy, setBusy] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<
    Record<string, { tone: 'success' | 'danger'; text: string }>
  >({});
  useFocusEffect(
    useCallback(() => {
      if (status.demo && status.active) void refetch();
    }, [status.demo, status.active, refetch]),
  );

  async function simulate(person: DemoWorker, action: DemoAction) {
    setBusy(person.worker_id);
    try {
      await api.demoSimulate({
        schema_version: 1,
        project_id: id,
        worker_id: person.worker_id,
        action,
        idempotency_key: randomUUID(),
      });
      setOutcome((current) => ({
        ...current,
        [person.worker_id]: {
          tone: 'success',
          text: t(action === 'ARRIVE' ? 'demo.arrived' : 'demo.left', { name: person.name }),
        },
      }));
      for (const key of [
        queryKeys.demoWorkers(id),
        queryKeys.dashboard(id),
        queryKeys.workforce(id),
        queryKeys.projectMap(id),
      ]) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
    } catch (error) {
      setOutcome((current) => ({
        ...current,
        [person.worker_id]: { tone: 'danger', text: t(errorMessageKey(error)) },
      }));
    } finally {
      setBusy(null);
    }
  }

  if (status.loading) {
    return (
      <Screen testID="demo-screen">
        <QueryState isLoading error={null} onRetry={() => undefined} />
      </Screen>
    );
  }
  if (!status.demo || !status.active) {
    return (
      <Screen testID="demo-screen">
        <Title>{t('demo.title')}</Title>
        <Banner tone="warning" text={t('demo.notDemo')} testID="demo-not-demo" />
        <AppButton variant="secondary" label={t('common.back')} onPress={() => router.back()} />
      </Screen>
    );
  }
  return (
    <Screen testID="demo-screen">
      <Title>{t('demo.title')}</Title>
      <Banner tone="info" text={t('demo.banner')} testID="demo-banner" />
      <Body>{t('demo.intro')}</Body>
      <QueryState
        isLoading={workers.isLoading}
        error={workers.data ? null : workers.error}
        onRetry={() => void refetch()}
      />
      {(workers.data ?? []).map((person) => {
        const here = person.presence !== null && ON_SITE.has(person.presence);
        const result = outcome[person.worker_id];
        return (
          <Card key={person.worker_id} testID={`demo-worker-${person.worker_id}`}>
            <Heading>{person.name}</Heading>
            {person.company_name ? <Text style={styles.hint}>{person.company_name}</Text> : null}
            <Text style={styles.state} testID={`demo-presence-${person.worker_id}`}>
              {t(`presence.${person.presence ?? 'NONE'}`)}
            </Text>
            <View style={styles.actions}>
              <AppButton
                label={t('demo.arrive')}
                disabled={busy !== null || here}
                onPress={() => void simulate(person, 'ARRIVE')}
                testID={`demo-arrive-${person.worker_id}`}
              />
              <AppButton
                variant="secondary"
                label={t('demo.leave')}
                disabled={busy !== null || !here}
                onPress={() => void simulate(person, 'LEAVE')}
                testID={`demo-leave-${person.worker_id}`}
              />
            </View>
            {result ? (
              <Banner
                tone={result.tone}
                text={result.text}
                testID={`demo-result-${person.worker_id}`}
              />
            ) : null}
          </Card>
        );
      })}
      <Text style={styles.hint}>{t('demo.footnote')}</Text>
      <AppButton variant="secondary" label={t('common.back')} onPress={() => router.back()} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  hint: { color: colors.mutedText, fontSize: 14 },
  state: { color: colors.text, fontSize: 16, fontWeight: '600' },
  actions: { gap: spacing.sm },
});
