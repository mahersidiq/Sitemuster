import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Linking, StyleSheet, Text } from 'react-native';
import { useTranslation } from 'react-i18next';

import { errorMessageKey } from '../api/errors';
import { queryKeys, useMyMusters } from '../api/hooks';
import type { MyMuster } from '../api/types';
import { AppButton } from '../components/AppButton';
import { Banner } from '../components/Banner';
import { Card } from '../components/Card';
import { SyncStatusCard } from '../components/SyncStatusCard';
import { Heading } from '../components/Typography';
import { OutcomeLine } from '../fallbacks/OutcomeLine';
import {
  musterAlertPermission,
  type MusterAlertPermission,
  type MusterAlertRegistration,
  registerMusterAlerts,
  requestMusterAlertPermission,
} from '../notifications/muster-alerts';
import { effectiveOutcome } from '../outbox/outbox';
import { useAuth } from '../state/auth';
import { useOutbox } from '../state/outbox';
import { colors } from '../theme';
import { latestSelfReport, pendingChecks } from './format';
import { useRefetchOnSettled } from './MusterBoardView';

const MY_MUSTER_KEYS = [queryKeys.myMusters] as const;

function OneMuster({ muster }: { muster: MyMuster }) {
  const { t } = useTranslation();
  const outbox = useOutbox();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const entry = latestSelfReport(outbox.entries, muster.muster_id);
  useRefetchOnSettled(muster.muster_id, MY_MUSTER_KEYS);
  const verified = muster.status === 'VERIFIED_ACCOUNTED';
  const answered =
    muster.self_reported ||
    muster.status === 'SELF_REPORTED_SAFE' ||
    (entry !== null && effectiveOutcome(entry) !== 'REJECTED');

  const imSafe = async () => {
    setBusy(true);
    setError(null);
    try {
      await outbox.enqueue(
        {
          project_id: muster.project_id,
          operation_type: 'MUSTER_SELF_REPORT',
          observed_at: new Date().toISOString(),
          payload: { muster_id: muster.muster_id, action: 'SELF_REPORT', channel: 'APP' },
        },
        { title: t('muster.worker.imSafe') },
      );
    } catch (caught) {
      setError(t(errorMessageKey(caught)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card testID={`muster-alert-${muster.muster_id}`}>
      <Banner
        tone="danger"
        text={t('muster.worker.alert', {
          project: muster.project_name,
          label: muster.incident_label,
        })}
      />
      {verified ? (
        <Banner tone="success" text={t('muster.worker.verified')} testID="muster-worker-verified" />
      ) : (
        <Text style={styles.line}>{t('muster.worker.instructions')}</Text>
      )}
      {!verified && !answered ? (
        <AppButton
          label={t('muster.worker.imSafe')}
          onPress={() => void imSafe()}
          disabled={busy}
          testID="muster-im-safe"
        />
      ) : null}
      {!verified && answered ? (
        <Banner tone="warning" text={t('muster.worker.selfNote')} testID="muster-self-note" />
      ) : null}
      {entry ? <OutcomeLine entry={entry} testID="muster-im-safe-outcome" /> : null}
      {error ? <Banner tone="danger" text={error} testID="muster-im-safe-error" /> : null}
    </Card>
  );
}

/**
 * Worker home during an active muster (docs/spec/12): the in-app I'M SAFE button always works,
 * with or without the alert. It is a self-report, never a physical check: the card says so and
 * tells the worker to go to the assembly point. Offline, the answer waits in the outbox.
 */
export function WorkerMusterAlerts() {
  const musters = useMyMusters();
  const outbox = useOutbox();
  const { refetch } = musters;
  useFocusEffect(
    useCallback(() => {
      void refetch();
    }, [refetch]),
  );
  if (!musters.data || musters.data.length === 0) return null;
  // An answer still on the phone: show the sync state and "Sync now" (spotty signal outdoors).
  const waiting = musters.data.some(
    (muster) => pendingChecks(outbox.entries, muster.muster_id) > 0,
  );
  return (
    <>
      {musters.data.map((muster) => (
        <OneMuster key={muster.muster_id} muster={muster} />
      ))}
      {waiting ? <SyncStatusCard /> : null}
    </>
  );
}

/** A permission read that fails is treated (and shown) as "off", and logged. */
function permissionUnreadable(error: unknown): MusterAlertPermission {
  console.warn(
    'muster alerts: permission unreadable',
    error instanceof Error ? error.message.slice(0, 120) : 'unknown',
  );
  return 'denied';
}

/**
 * Asks for notification permission only after explaining why (muster alerts), then registers
 * this phone's push token for the signed-in worker. Without permission or without push set up in
 * this build, it says so; musters still show in the app.
 */
export function MusterAlertsSetup() {
  const { t } = useTranslation();
  const { api, state } = useAuth();
  const userId = state.status === 'signed_in' ? state.access.user_id : null;
  const [permission, setPermission] = useState<MusterAlertPermission | null>(null);
  const [registration, setRegistration] = useState<MusterAlertRegistration | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const current = await musterAlertPermission().catch(permissionUnreadable);
      if (cancelled) return;
      setPermission(current);
      if (current === 'granted' && api && userId) {
        const result = await registerMusterAlerts(api, userId);
        if (!cancelled) setRegistration(result);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, userId]);

  const turnOn = async () => {
    const result = await requestMusterAlertPermission().catch(permissionUnreadable);
    setPermission(result);
    if (result === 'granted' && api && userId) {
      setRegistration(await registerMusterAlerts(api, userId));
    }
  };

  if (permission === 'undetermined') {
    return (
      <Card testID="muster-alerts-setup">
        <Heading>{t('muster.push.setupTitle')}</Heading>
        <Text style={styles.line}>{t('muster.push.setupBody')}</Text>
        <AppButton
          label={t('muster.push.turnOn')}
          onPress={() => void turnOn()}
          testID="muster-alerts-turn-on"
        />
      </Card>
    );
  }
  if (permission === 'denied') {
    return (
      <Card testID="muster-alerts-denied">
        <Banner tone="warning" text={t('muster.push.denied')} />
        <AppButton
          variant="secondary"
          label={t('muster.push.openSettings')}
          onPress={() => void Linking.openSettings()}
          testID="muster-alerts-settings"
        />
      </Card>
    );
  }
  if (registration === 'NOT_CONFIGURED') {
    return (
      <Banner
        tone="info"
        text={t('muster.push.notConfigured')}
        testID="muster-alerts-not-configured"
      />
    );
  }
  return null;
}

const styles = StyleSheet.create({ line: { fontSize: 16, color: colors.text } });
