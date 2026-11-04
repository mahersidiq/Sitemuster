import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, StyleSheet, Text, View } from 'react-native';

import { AppButton } from '../../src/components/AppButton';
import { Banner } from '../../src/components/Banner';
import { Card } from '../../src/components/Card';
import { Screen } from '../../src/components/Screen';
import { TRACKING_PHASE_TONE } from '../../src/components/TrackingStatusCard';
import { Body, Title } from '../../src/components/Typography';
import { useTracking } from '../../src/state/tracking';
import { colors, spacing } from '../../src/theme';

/**
 * Automatic attendance: status, permission checklist, connection key, sync status and monitored
 * sites (docs/tasks/milestone-07.md "device permission state UX"). Every state is shown, never
 * hidden: limited mode, missing permission, expired key, unmonitored sites, queued records.
 */
export default function TrackingScreen() {
  const { t, i18n } = useTranslation();
  const { status, requestPermission, syncNow } = useTracking();
  const [busy, setBusy] = useState(false);
  if (!status) {
    return (
      <Screen testID="tracking-screen">
        <Title>{t('tracking.title')}</Title>
        <Banner tone="warning" text={t('tracking.phase.UNAVAILABLE')} />
      </Screen>
    );
  }
  const run = (action: () => Promise<void>) => async () => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };
  const date = (iso: string | null) =>
    iso ? new Date(iso).toLocaleDateString(i18n.language, { dateStyle: 'medium' }) : '';
  const permission = status.permission;
  const checks = permission
    ? [
        { key: 'location', ok: permission.location === 'ALWAYS' },
        { key: 'precise', ok: permission.precise },
        { key: 'services', ok: permission.servicesEnabled },
      ]
    : [];

  return (
    <Screen testID="tracking-screen">
      <Title>{t('tracking.title')}</Title>
      <Banner
        tone={TRACKING_PHASE_TONE[status.phase]}
        text={t(`tracking.phase.${status.phase}`)}
        testID="tracking-phase"
      />
      <View testID="tracking-mode">
        <Body>{t(`tracking.mode.${status.mode}`)}</Body>
      </View>
      <Body>{t('tracking.estimateNote')}</Body>

      {checks.length > 0 ? (
        <Card testID="tracking-permissions">
          <Title>{t('tracking.permissions.title')}</Title>
          {checks.map((check) => (
            <View key={check.key} style={styles.row}>
              <Text style={styles.label}>{t(`tracking.permissions.${check.key}`)}</Text>
              <Text
                style={check.ok ? styles.ok : styles.missing}
                testID={`tracking-permission-${check.key}`}
              >
                {check.ok ? t('tracking.permissions.ok') : t('tracking.permissions.missing')}
              </Text>
            </View>
          ))}
          {checks.some((check) => !check.ok) ? (
            <>
              <Body>
                {Platform.OS === 'android'
                  ? t('tracking.permissions.androidHelp')
                  : t('tracking.permissions.iosHelp')}
              </Body>
              <AppButton
                label={t('tracking.permissions.allow')}
                onPress={run(requestPermission)}
                disabled={busy}
                testID="tracking-allow"
              />
            </>
          ) : null}
        </Card>
      ) : null}

      <Card testID="tracking-credential">
        <Title>{t('tracking.credential.title')}</Title>
        <Body>
          {t(`tracking.credential.${status.credential}`, {
            date: date(status.credentialExpiresAt),
          })}
        </Body>
      </Card>

      <Card testID="tracking-sync">
        <Title>{t('tracking.sync.title')}</Title>
        <View testID="tracking-queue">
          <Body>{t('tracking.sync.locationQueue', { count: status.queued })}</Body>
        </View>
        <Body>{t('tracking.sync.operationsQueue')}</Body>
        {status.planStale ? <Banner tone="info" text={t('tracking.sync.planStale')} /> : null}
        {status.lastHttpStatus === 401 ? (
          <Banner tone="danger" text={t('tracking.sync.lastRefused')} testID="tracking-refused" />
        ) : null}
        <AppButton
          label={t('tracking.sync.syncNow')}
          variant="secondary"
          onPress={run(syncNow)}
          disabled={busy}
          testID="tracking-sync-now"
        />
      </Card>

      {status.monitored.length > 0 ? (
        <Card testID="tracking-monitored">
          <Title>{t('tracking.sites.monitored')}</Title>
          {status.monitored.map((site) => (
            <Body key={site.id}>{site.name}</Body>
          ))}
        </Card>
      ) : null}
      {status.notMonitored.length > 0 ? (
        <Card testID="tracking-not-monitored">
          <Title>{t('tracking.sites.notMonitored')}</Title>
          {status.notMonitored.map((site) => (
            <Body
              key={site.id}
            >{`${site.name}: ${t(`tracking.sites.reason.${site.reason}`)}`}</Body>
          ))}
        </Card>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: spacing.xs },
  label: { color: colors.text, fontSize: 16, flexShrink: 1 },
  ok: { color: colors.successText, fontSize: 16, fontWeight: '700' },
  missing: { color: colors.dangerText, fontSize: 16, fontWeight: '700' },
});
