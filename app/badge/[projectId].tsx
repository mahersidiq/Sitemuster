import Constants from 'expo-constants';
import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { useTranslation } from 'react-i18next';

import { base64UrlDecode, buildBadgePayload, BADGE_STEP_SECONDS } from '@sitemuster/shared';

import { errorMessageKey } from '../../src/api/errors';
import { AppButton } from '../../src/components/AppButton';
import { Banner } from '../../src/components/Banner';
import { LoadingScreen } from '../../src/components/LoadingScreen';
import { QrBlock } from '../../src/components/QrBlock';
import { Screen } from '../../src/components/Screen';
import { Body, Title } from '../../src/components/Typography';
import { useNow } from '../../src/components/useNow';
import { activateThisDevice, loadDevice, type StoredDevice } from '../../src/device/device-store';
import { useAuth } from '../../src/state/auth';
import { colors } from '../../src/theme';

/**
 * Offline worker badge (decision #43): a 30-second code computed on this phone from its own badge
 * secret — no network needed once the phone is activated. The kiosk records it; the server
 * verifies it later and accepts each 30-second code once.
 */
export default function BadgeScreen() {
  const { state, api } = useAuth();
  if (api && state.status === 'loading') return <LoadingScreen />;
  if (!api || state.status !== 'signed_in' || !state.access.worker_profile_id)
    return <Redirect href="/" />;
  return <Badge userId={state.access.user_id} />;
}

function Badge({ userId }: { userId: string }) {
  const { t } = useTranslation();
  const { api } = useAuth();
  const { projectId, name } = useLocalSearchParams<{ projectId: string; name?: string }>();
  const [device, setDevice] = useState<StoredDevice | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const now = useNow(1000);

  useEffect(() => {
    void loadDevice(userId).then(setDevice);
  }, [userId]);

  const activate = async () => {
    if (!api) return;
    setBusy(true);
    setError(null);
    try {
      setDevice(await activateThisDevice(api, userId, Constants.expoConfig?.version ?? '0.0.0'));
    } catch (caught) {
      setError(t(errorMessageKey(caught)));
    } finally {
      setBusy(false);
    }
  };

  const unix = Math.floor(now.getTime() / 1000);
  const secondsLeft = BADGE_STEP_SECONDS - (unix % BADGE_STEP_SECONDS);
  return (
    <Screen testID="badge-screen">
      <Title>{t('badge.title')}</Title>
      {name ? <Body>{name}</Body> : null}
      {device === undefined ? <Body>{t('common.loading')}</Body> : null}
      {device === null ? (
        <>
          <Banner tone="info" text={t('badge.activateIntro')} />
          <AppButton
            label={busy ? t('common.saving') : t('badge.activate')}
            onPress={() => void activate()}
            disabled={busy}
            testID="badge-activate"
          />
        </>
      ) : null}
      {device ? (
        <>
          <QrBlock
            value={buildBadgePayload(
              base64UrlDecode(device.badgeSecret),
              device.deviceId,
              projectId,
              unix,
            )}
            caption={t('badge.changesIn', { seconds: secondsLeft })}
            testID="badge-qr"
          />
          <Text style={styles.note}>{t('badge.offlineNote')}</Text>
          <Text style={styles.note}>{t('badge.oneUse')}</Text>
        </>
      ) : null}
      {error ? <Banner tone="danger" text={error} testID="badge-error" /> : null}
      <AppButton
        variant="secondary"
        label={t('common.back')}
        onPress={() => router.back()}
        testID="badge-back"
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  note: { fontSize: 15, color: colors.mutedText, textAlign: 'center' },
});
