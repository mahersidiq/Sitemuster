import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { errorCode } from '../api/errors';
import { useProjects } from '../api/hooks';
import { AppButton } from '../components/AppButton';
import { Banner } from '../components/Banner';
import { Card } from '../components/Card';
import { StatusPill } from '../components/StatusPill';
import { Body, Title } from '../components/Typography';
import { useNow } from '../components/useNow';
import type { LiveState } from '../realtime/live-sync';
import { useSelectedProject } from '../state/selected-project';
import { colors, spacing } from '../theme';

/**
 * The selected project for the staff tabs, with an explicit picker (docs/spec/01: explicit
 * project context). One project is picked automatically; a project the person can no longer
 * open is dropped and the picker shown.
 */
export function ProjectHeader({ testID = 'project-header' }: { testID?: string }) {
  const { t } = useTranslation();
  const projects = useProjects();
  const { projectId, ready, select } = useSelectedProject();
  const [picking, setPicking] = useState(false);
  const list = projects.data;
  const current = list?.find((p) => p.id === projectId) ?? null;

  useEffect(() => {
    if (!ready || !list) return;
    if (projectId && !list.some((p) => p.id === projectId)) select(null);
    else if (!projectId && list.length === 1 && list[0]) select(list[0].id);
  }, [ready, list, projectId, select]);

  if (!list) return null;
  if (list.length === 0) return <Banner tone="info" text={t('dashboard.noProjects')} />;
  if (!current || picking) {
    return (
      <View style={styles.stack} testID={`${testID}-picker`}>
        <Title>{t('dashboard.chooseProject')}</Title>
        <Body>{t('dashboard.pickHelp')}</Body>
        {list.map((project) => (
          <Card
            key={project.id}
            onPress={() => {
              select(project.id);
              setPicking(false);
            }}
            accessibilityLabel={project.name}
            testID={`pick-${project.id}`}
          >
            <Text style={styles.name}>{project.name}</Text>
            <StatusPill status={project.status} />
          </Card>
        ))}
      </View>
    );
  }
  return (
    <View style={styles.stack} testID={testID}>
      <Title>{current.name}</Title>
      {list.length > 1 ? (
        <AppButton
          variant="secondary"
          label={t('dashboard.changeProject')}
          onPress={() => setPicking(true)}
          testID="change-project"
        />
      ) : null}
    </View>
  );
}

/**
 * Freshness, always visible (docs/spec/01 "Availability & status UX"): live, paused (refreshing
 * every minute), offline with the time of the data shown, or stopped because access ended.
 */
export function LiveStatusLine({
  state,
  updatedAt,
  error,
  onRefresh,
}: {
  state: LiveState;
  updatedAt: number;
  error: unknown;
  onRefresh: () => void;
}) {
  const { t, i18n } = useTranslation();
  useNow(30_000); // keeps "updated" wording current
  const time =
    updatedAt > 0
      ? new Date(updatedAt).toLocaleTimeString(i18n.language, {
          hour: 'numeric',
          minute: '2-digit',
        })
      : t('live.never');
  const offline = errorCode(error) === 'NETWORK' && updatedAt > 0;
  return (
    <View style={styles.stack} testID="live-status">
      {offline ? (
        <Banner tone="warning" text={t('live.offline', { time })} testID="live-offline" />
      ) : null}
      <Banner
        tone={state === 'DENIED' ? 'danger' : state === 'LIVE' ? 'info' : 'warning'}
        text={t(`live.${state}`, { time })}
        testID={`live-${state}`}
      />
      <AppButton
        variant="secondary"
        label={t('live.refresh')}
        onPress={onRefresh}
        testID="live-refresh"
      />
    </View>
  );
}

/** One labelled number in a card. */
export function StatLine({ text, testID }: { text: string; testID?: string }) {
  return (
    <Text style={styles.line} testID={testID}>
      {text}
    </Text>
  );
}

export function Hint({ text }: { text: string }) {
  return <Text style={styles.hint}>{text}</Text>;
}

const styles = StyleSheet.create({
  stack: { gap: spacing.sm },
  name: { fontSize: 18, fontWeight: '600', color: colors.text },
  line: { fontSize: 16, color: colors.text, paddingVertical: 2 },
  hint: { fontSize: 14, color: colors.mutedText },
});
