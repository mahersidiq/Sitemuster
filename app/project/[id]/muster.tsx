import { useQueryClient } from '@tanstack/react-query';
import { randomUUID } from 'expo-crypto';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { useTranslation } from 'react-i18next';

import type { MusterCounts } from '@sitemuster/shared';

import { errorMessageKey } from '../../../src/api/errors';
import { queryKeys, useMusterBoard, useProject, useProjectMusters } from '../../../src/api/hooks';
import type { ProjectMusters } from '../../../src/api/types';
import { AppButton } from '../../../src/components/AppButton';
import { Banner } from '../../../src/components/Banner';
import { Card } from '../../../src/components/Card';
import { ChipGroup } from '../../../src/components/ChipGroup';
import { QueryState } from '../../../src/components/QueryState';
import { Screen } from '../../../src/components/Screen';
import { StaffGate } from '../../../src/components/StaffGate';
import { TextField } from '../../../src/components/TextField';
import { ToggleRow } from '../../../src/components/ToggleRow';
import { Body, Heading, Title } from '../../../src/components/Typography';
import { pendingChecks, unresolvedCount } from '../../../src/muster/format';
import { MusterBoardView } from '../../../src/muster/MusterBoardView';
import { formatInstant } from '../../../src/projects/format';
import { useApi } from '../../../src/state/auth';
import { useOutbox } from '../../../src/state/outbox';
import { useSelectedProject } from '../../../src/state/selected-project';
import { colors } from '../../../src/theme';

export default function MusterRoute() {
  return (
    <StaffGate>
      <MusterConsole />
    </StaffGate>
  );
}

/**
 * Active Muster Mode for the safety team (docs/spec/12). A supplemental headcount tool, not a
 * certified life-safety system. Only the designated safety role (MFA) starts and closes a muster;
 * the server re-checks every action. Counts come from the server; this phone's unsynced checks are
 * shown separately as "waiting to sync".
 */
function MusterConsole() {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const project = useProject(id);
  const list = useProjectMusters(id);
  // The app's one live channel follows this project while its muster is open, so every
  // response refetches the board at once (decision #122); the 10-second refresh stays as backup.
  const { projectId: selected, ready, select } = useSelectedProject();
  useEffect(() => {
    if (ready && project.data && selected !== id) select(id);
  }, [ready, project.data, selected, id, select]);
  const [chosen, setChosen] = useState<string | null>(null);
  const musters = list.data?.musters ?? [];
  const active = musters.filter((muster) => muster.status === 'ACTIVE');
  const current =
    active.find((muster) => muster.muster_id === chosen)?.muster_id ?? active[0]?.muster_id ?? null;
  const canCommand = list.data?.can_command ?? false;
  return (
    <Screen testID="muster-screen">
      <Title>{t('muster.title')}</Title>
      {project.data ? <Body>{project.data.project.name}</Body> : null}
      <Banner tone="warning" text={t('muster.notLifeSafety')} testID="muster-disclaimer" />
      <QueryState
        isLoading={list.isLoading}
        error={list.error}
        onRetry={() => void list.refetch()}
      />
      {active.length > 1 ? (
        <ChipGroup
          label={t('muster.activeList')}
          options={active.map((muster) => ({
            value: muster.muster_id,
            label: muster.incident_label,
          }))}
          selected={current ? [current] : []}
          onToggle={setChosen}
          testID="muster-active-pick"
        />
      ) : null}
      {current ? (
        <ActiveMuster
          projectId={id}
          musterId={current}
          canCommand={canCommand}
          canScan={project.data?.permissions.can_operate_kiosk ?? false}
        />
      ) : null}
      {list.data && canCommand ? (
        <StartCard projectId={id} hasActive={active.length > 0} onStarted={setChosen} />
      ) : null}
      {list.data && !canCommand ? (
        <Text style={styles.hint} testID="muster-only-safety">
          {t('muster.onlySafety')}
        </Text>
      ) : null}
      {list.data ? <History projectId={id} musters={musters} /> : null}
      <AppButton
        variant="secondary"
        label={t('common.back')}
        onPress={() => router.back()}
        testID="muster-back"
      />
    </Screen>
  );
}

function StartCard({
  projectId,
  hasActive,
  onStarted,
}: {
  projectId: string;
  hasActive: boolean;
  onStarted: (musterId: string) => void;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(!hasActive);
  const [label, setLabel] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  // One key per decision to start: a retry after a timeout can never create a second muster.
  const key = useRef<string | null>(null);

  const start = async () => {
    key.current ??= randomUUID();
    setBusy(true);
    setMessage(null);
    try {
      const out = await api.startMuster({
        projectId,
        label: label.trim(),
        idempotencyKey: key.current,
        separate: hasActive,
      });
      key.current = null;
      setConfirming(false);
      setLabel('');
      setOpen(false);
      onStarted(out.muster_id);
      // A retry of our own start (same key) is "started", not someone else's muster.
      const text =
        !out.created && !out.duplicate
          ? t('muster.alreadyActive')
          : out.push
            ? `${t('muster.started')} ${t('muster.pushSummary', {
                sent: out.push.sent,
                targets: out.push.targets,
                failed: out.push.failed,
              })}${out.push.provider === 'development-fake' ? ` ${t('muster.pushDev')}` : ''}`
            : t('muster.started');
      setMessage({ tone: 'success', text });
      await queryClient.invalidateQueries({ queryKey: queryKeys.musterOf(projectId) });
    } catch (error) {
      // The key is kept: trying again repeats the same request, never a second muster.
      setMessage({ tone: 'danger', text: t(errorMessageKey(error)) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card testID="muster-start">
      <Heading>{hasActive ? t('muster.startSeparateTitle') : t('muster.startTitle')}</Heading>
      {!open ? (
        <AppButton
          variant="secondary"
          label={t('muster.startSeparate')}
          onPress={() => setOpen(true)}
          testID="muster-start-separate"
        />
      ) : (
        <>
          <TextField
            label={t('muster.labelField')}
            value={label}
            onChangeText={(value) => {
              setLabel(value);
              setConfirming(false);
            }}
            maxLength={200}
            testID="muster-label"
          />
          {!confirming ? (
            <AppButton
              label={t('muster.start')}
              onPress={() => {
                if (label.trim() === '') {
                  setMessage({ tone: 'danger', text: t('muster.labelNeeded') });
                  return;
                }
                setMessage(null);
                setConfirming(true);
              }}
              testID="muster-start-button"
            />
          ) : (
            <Card testID="muster-start-confirm-card">
              <Banner tone="danger" text={t('muster.confirmBody')} />
              <AppButton
                label={t('muster.confirmStart')}
                onPress={() => void start()}
                disabled={busy}
                testID="muster-start-confirm"
              />
              <AppButton
                variant="secondary"
                label={t('common.cancel')}
                onPress={() => setConfirming(false)}
                testID="muster-start-cancel"
              />
            </Card>
          )}
        </>
      )}
      {message ? (
        <Banner tone={message.tone} text={message.text} testID="muster-start-message" />
      ) : null}
    </Card>
  );
}

function ActiveMuster({
  projectId,
  musterId,
  canCommand,
  canScan,
}: {
  projectId: string;
  musterId: string;
  canCommand: boolean;
  canScan: boolean;
}) {
  const { t } = useTranslation();
  const board = useMusterBoard(projectId, musterId);
  const data = board.data;
  return (
    <>
      <QueryState
        isLoading={board.isLoading}
        error={board.error}
        onRetry={() => void board.refetch()}
      />
      {data ? (
        <>
          <MusterBoardView
            board={data}
            projectId={projectId}
            canVerify={(member) =>
              canCommand || (member.kind === 'VISITOR' && data.can_verify_visitors === true)
            }
          />
          {canScan && data.status === 'ACTIVE' ? (
            <AppButton
              label={t('muster.scan')}
              onPress={() =>
                router.push({
                  pathname: '/project/[id]/kiosk',
                  params: { id: projectId, musterId },
                })
              }
              testID="muster-scan"
            />
          ) : null}
          {canCommand && data.status === 'ACTIVE' && data.counts ? (
            <CloseCard projectId={projectId} musterId={musterId} counts={data.counts} />
          ) : null}
        </>
      ) : null}
    </>
  );
}

function CloseCard({
  projectId,
  musterId,
  counts,
}: {
  projectId: string;
  musterId: string;
  counts: MusterCounts;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const outbox = useOutbox();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unresolved = unresolvedCount(counts);
  const pending = pendingChecks(outbox.entries, musterId);

  const close = async () => {
    if (note.trim().length < 3) {
      setError(t('muster.noteNeeded'));
      return;
    }
    if (unresolved > 0 && !acknowledged) {
      setError(t('muster.ackNeeded'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.closeMuster({ musterId, note: note.trim(), acknowledgeIncomplete: acknowledged });
      await queryClient.invalidateQueries({ queryKey: queryKeys.musterOf(projectId) });
      router.replace({
        pathname: '/project/[id]/muster-report',
        params: { id: projectId, musterId, closed: '1' },
      });
    } catch (caught) {
      setError(t(errorMessageKey(caught)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card testID="muster-close">
      <Heading>{t('muster.closeTitle')}</Heading>
      {!open ? (
        <AppButton
          variant="secondary"
          label={t('muster.close')}
          onPress={() => setOpen(true)}
          testID="muster-close-open"
        />
      ) : (
        <>
          <Banner
            tone={unresolved > 0 ? 'danger' : 'info'}
            text={
              unresolved > 0
                ? t('muster.closeUnresolved', { count: unresolved })
                : t('muster.closeAllResolved')
            }
            testID="muster-close-unresolved"
          />
          {counts.workers.self_reported > 0 ? (
            <Text style={styles.hint}>
              {t('muster.closeSelfOnly', { count: counts.workers.self_reported })}
            </Text>
          ) : null}
          {pending > 0 ? (
            <Banner
              tone="warning"
              text={t('muster.closePending', { count: pending })}
              testID="muster-close-pending"
            />
          ) : null}
          {unresolved > 0 ? (
            <ToggleRow
              label={t('muster.acknowledge')}
              value={acknowledged}
              onValueChange={setAcknowledged}
              testID="muster-close-ack"
            />
          ) : null}
          <TextField
            label={t('muster.closeNote')}
            value={note}
            onChangeText={setNote}
            maxLength={2000}
            testID="muster-close-note"
          />
          <AppButton
            label={t('muster.closeConfirm')}
            onPress={() => void close()}
            disabled={busy}
            testID="muster-close-confirm"
          />
          <AppButton
            variant="secondary"
            label={t('common.cancel')}
            onPress={() => {
              setOpen(false);
              setError(null);
            }}
            testID="muster-close-cancel"
          />
          {error ? <Banner tone="danger" text={error} testID="muster-close-error" /> : null}
        </>
      )}
    </Card>
  );
}

function History({
  projectId,
  musters,
}: {
  projectId: string;
  musters: ProjectMusters['musters'];
}) {
  const { t, i18n } = useTranslation();
  const closed = musters.filter((muster) => muster.status === 'CLOSED');
  return (
    <Card testID="muster-history">
      <Heading>{t('muster.history')}</Heading>
      {closed.length === 0 ? <Text style={styles.hint}>{t('muster.none')}</Text> : null}
      {closed.map((muster) => (
        <Card key={muster.muster_id}>
          <Text style={styles.line}>
            {t('muster.historyLine', {
              label: muster.incident_label,
              time: formatInstant(muster.started_at, undefined, i18n.language),
            })}
          </Text>
          <Text style={styles.hint}>
            {t('muster.historyCounts', {
              verified: muster.counts.workers.verified,
              self: muster.counts.workers.self_reported,
              open: unresolvedCount(muster.counts),
            })}
          </Text>
          <AppButton
            variant="secondary"
            label={t('muster.viewReport')}
            onPress={() =>
              router.push({
                pathname: '/project/[id]/muster-report',
                params: { id: projectId, musterId: muster.muster_id },
              })
            }
            testID={`muster-report-${muster.muster_id}`}
          />
        </Card>
      ))}
    </Card>
  );
}

const styles = StyleSheet.create({
  hint: { fontSize: 15, color: colors.mutedText },
  line: { fontSize: 16, color: colors.text },
});
