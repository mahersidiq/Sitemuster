import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { useOutbox } from '../state/outbox';
import { useTracking } from '../state/tracking';
import { colors, spacing } from '../theme';
import { AppButton } from './AppButton';
import { Banner } from './Banner';
import { Card } from './Card';
import { Heading } from './Typography';

const PROBLEMS = new Set([
  'NETWORK',
  'UNAUTHENTICATED',
  'RATE_LIMITED',
  'TEMPORARILY_UNAVAILABLE',
  'CONFIGURATION_ERROR',
]);

/**
 * Combined sync status (Milestone 08): the operational outbox (kiosk, crew, corrections,
 * visitors) and, for a worker's own phone, the native location queue. Both queues are separate
 * by design (decision #23); this card only shows them side by side. Nothing waiting is ever
 * shown as confirmed.
 */
export function SyncStatusCard({ testID = 'sync-status' }: { testID?: string }) {
  const { t, i18n } = useTranslation();
  const outbox = useOutbox();
  const tracking = useTracking();
  const [busy, setBusy] = useState(false);
  const status = outbox.status;
  if (!status) return null;
  const time = (ms: number) =>
    new Date(ms).toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' });
  const problem = status.lastError
    ? t(`outbox.problem.${PROBLEMS.has(status.lastError) ? status.lastError : 'other'}`)
    : null;
  const syncNow = async () => {
    setBusy(true);
    try {
      await Promise.all([outbox.syncNow(), tracking.status ? tracking.syncNow() : undefined]);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card testID={testID}>
      <Heading>{t('outbox.title')}</Heading>
      <Text style={styles.line} testID={`${testID}-pending`}>
        {status.pending > 0 ? t('outbox.pending', { count: status.pending }) : t('outbox.allSent')}
      </Text>
      {tracking.status ? (
        <Text style={styles.line} testID={`${testID}-location`}>
          {t('outbox.locationQueued', { count: tracking.status.queued })}
        </Text>
      ) : null}
      {status.rejected > 0 ? (
        <Text style={styles.line} testID={`${testID}-rejected`}>
          {t('outbox.rejected', { count: status.rejected })}
        </Text>
      ) : null}
      <Text style={styles.hint}>
        {status.syncing
          ? t('outbox.syncing')
          : status.lastSyncAt
            ? t('outbox.lastSync', { time: time(status.lastSyncAt) })
            : t('outbox.neverSynced')}
      </Text>
      {problem && status.pending > 0 ? (
        <Banner tone="info" text={problem} testID={`${testID}-problem`} />
      ) : null}
      <View>
        <AppButton
          variant="secondary"
          label={t('outbox.syncNow')}
          onPress={() => void syncNow()}
          disabled={busy || status.syncing}
          testID={`${testID}-now`}
        />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  line: { fontSize: 16, color: colors.text },
  hint: { fontSize: 14, color: colors.mutedText, marginTop: spacing.xs },
});
