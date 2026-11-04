import { useQuery, useQueryClient } from '@tanstack/react-query';
import { randomUUID } from 'expo-crypto';
import { router, useLocalSearchParams } from 'expo-router';
import { useRef, useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { useTranslation } from 'react-i18next';

import {
  base64UrlDecode,
  rotatingOrientationCode,
  secondsUntilNextRotation,
  staticOrientationCode,
} from '@sitemuster/shared';

import { errorMessageKey } from '../../../src/api/errors';
import { queryKeys, hideOnAuthError } from '../../../src/api/hooks';
import type { OrientationSessionInfo } from '../../../src/api/types';
import { AppButton } from '../../../src/components/AppButton';
import { Banner } from '../../../src/components/Banner';
import { ChipGroup } from '../../../src/components/ChipGroup';
import { QrBlock } from '../../../src/components/QrBlock';
import { QueryState } from '../../../src/components/QueryState';
import { Screen } from '../../../src/components/Screen';
import { StaffGate } from '../../../src/components/StaffGate';
import { Body, Title } from '../../../src/components/Typography';
import { useNow } from '../../../src/components/useNow';
import { formatInstant } from '../../../src/projects/format';
import { sharePng } from '../../../src/sharing/share-png';
import { useApi } from '../../../src/state/auth';
import { useLanguage } from '../../../src/state/language';
import { colors } from '../../../src/theme';

export default function OrientationScreen() {
  return (
    <StaffGate>
      <Orientation />
    </StaffGate>
  );
}

/**
 * Orientation session (120 minutes). The rotating QR is computed on this phone every 60 seconds
 * (works without signal); the printable QR is valid only while the session is open. Neither one
 * approves anybody (decision #4).
 */
function Orientation() {
  const { t } = useTranslation();
  const api = useApi();
  const queryClient = useQueryClient();
  const { activeLocale } = useLanguage();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [mode, setMode] = useState<'ROTATING' | 'PRINTED'>('ROTATING');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pngRef = useRef<(() => Promise<string>) | null>(null);
  const now = useNow(1000);

  const session = hideOnAuthError(
    useQuery({
      queryKey: ['orientation-open', id],
      queryFn: async (): Promise<OrientationSessionInfo | null> => {
        const open = (await api.listOrientationSessions(id)).find((s) => s.open);
        return open ? api.getOrientationSession(open.session_id) : null;
      },
    }),
  );

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const started = await api.startOrientation(id, randomUUID());
      queryClient.setQueryData(['orientation-open', id], started);
      await queryClient.invalidateQueries({ queryKey: queryKeys.orientationSessions(id) });
    } catch (caught) {
      setError(t(errorMessageKey(caught)));
    } finally {
      setBusy(false);
    }
  };

  const close = async (sessionId: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.closeOrientation(id, sessionId);
      queryClient.setQueryData(['orientation-open', id], null);
    } catch (caught) {
      setError(t(errorMessageKey(caught)));
    } finally {
      setBusy(false);
    }
  };

  const data = session.data;
  const unix = Math.floor(now.getTime() / 1000);
  const expired = data ? new Date(data.expires_at).getTime() <= now.getTime() : false;
  return (
    <Screen testID="orientation-screen">
      <Title>{t('orientation.title')}</Title>
      <QueryState
        isLoading={session.isLoading}
        error={session.error}
        onRetry={() => void session.refetch()}
      />
      {data === null || expired ? (
        <>
          <Body>{t('orientation.intro')}</Body>
          {expired ? <Banner text={t('orientation.expired')} testID="orientation-expired" /> : null}
          <AppButton
            label={busy ? t('common.saving') : t('orientation.start')}
            onPress={() => void start()}
            disabled={busy}
            testID="orientation-start"
          />
        </>
      ) : null}
      {data && !expired ? (
        <>
          <Text style={styles.until} testID="orientation-until">
            {t('orientation.openUntil', {
              time: formatInstant(data.expires_at, undefined, activeLocale),
            })}
          </Text>
          <ChipGroup
            label={t('orientation.modeLabel')}
            options={[
              { value: 'ROTATING', label: t('orientation.rotatingTab') },
              { value: 'PRINTED', label: t('orientation.printedTab') },
            ]}
            selected={[mode]}
            onToggle={setMode}
            testID="orientation-mode"
          />
          {mode === 'ROTATING' ? (
            <>
              <QrBlock
                value={rotatingOrientationCode(
                  base64UrlDecode(data.rotating_secret),
                  data.session_id,
                  unix,
                )}
                caption={t('orientation.rotatesIn', { seconds: secondsUntilNextRotation(unix) })}
                testID="orientation-rotating-qr"
              />
              <Text style={styles.note}>{t('orientation.rotatingNote')}</Text>
            </>
          ) : (
            <>
              <QrBlock
                value={staticOrientationCode(data.session_id, data.static_code)}
                caption={t('orientation.printedCaption', {
                  time: formatInstant(data.expires_at, undefined, activeLocale),
                })}
                testID="orientation-printed-qr"
                pngRef={pngRef}
              />
              <Text style={styles.note}>{t('orientation.printedNote')}</Text>
              <AppButton
                variant="secondary"
                label={t('orientation.sharePrint')}
                onPress={() => {
                  const toPng = pngRef.current;
                  if (!toPng) return;
                  void toPng()
                    .then((png) => sharePng(png, 'sitemuster-orientation.png'))
                    .then((shared) => {
                      if (!shared) setError(t('orientation.shareUnavailable'));
                    })
                    .catch(() => setError(t('orientation.shareUnavailable')));
                }}
                testID="orientation-share"
              />
            </>
          )}
          <Banner tone="info" text={t('orientation.neverApproves')} />
          <AppButton
            variant="secondary"
            label={t('orientation.close')}
            onPress={() => void close(data.session_id)}
            disabled={busy}
            testID="orientation-close"
          />
        </>
      ) : null}
      {error ? <Banner tone="danger" text={error} testID="orientation-error" /> : null}
      <AppButton
        variant="secondary"
        label={t('orientation.toApprovals')}
        onPress={() => router.push({ pathname: '/project/[id]/workers', params: { id } })}
        testID="orientation-to-workers"
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  until: { fontSize: 17, fontWeight: '600', color: colors.text, textAlign: 'center' },
  note: { fontSize: 15, color: colors.mutedText, textAlign: 'center' },
});
