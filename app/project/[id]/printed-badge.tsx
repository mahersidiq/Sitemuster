import { useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useRef, useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { useTranslation } from 'react-i18next';

import { errorMessageKey } from '../../../src/api/errors';
import { queryKeys } from '../../../src/api/hooks';
import type { PrintedBadge } from '../../../src/api/types';
import { AppButton } from '../../../src/components/AppButton';
import { Banner } from '../../../src/components/Banner';
import { QrBlock } from '../../../src/components/QrBlock';
import { Screen } from '../../../src/components/Screen';
import { StaffGate } from '../../../src/components/StaffGate';
import { TextField } from '../../../src/components/TextField';
import { Body, Title } from '../../../src/components/Typography';
import { sharePng } from '../../../src/sharing/share-png';
import { useApi } from '../../../src/state/auth';
import { colors } from '../../../src/theme';

export default function PrintedBadgeScreen() {
  return (
    <StaffGate>
      <PrintedBadgeIssue />
    </StaffGate>
  );
}

/**
 * Attended issuance of a printed badge: an opaque code with no personal data, shown once (only
 * its hash is stored). Kiosk scans of printed badges are weaker evidence and need a name/face
 * check by the attendant (decision #43, amendment B).
 */
function PrintedBadgeIssue() {
  const { t } = useTranslation();
  const api = useApi();
  const queryClient = useQueryClient();
  const { id, workerId, name } = useLocalSearchParams<{
    id: string;
    workerId: string;
    name?: string;
  }>();
  const [badge, setBadge] = useState<PrintedBadge | null>(null);
  const pngRef = useRef<(() => Promise<string>) | null>(null);
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const issue = async () => {
    setBusy(true);
    setMessage(null);
    try {
      setBadge(await api.issuePrintedBadge(id, workerId));
      await queryClient.invalidateQueries({ queryKey: queryKeys.roster(id) });
    } catch (caught) {
      setMessage({ tone: 'danger', text: t(errorMessageKey(caught)) });
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    if (!badge) return;
    setBusy(true);
    try {
      await api.revokePrintedBadge(id, badge.badge_id, reason.trim());
      setBadge(null);
      setMessage({ tone: 'success', text: t('printedBadge.revoked') });
      await queryClient.invalidateQueries({ queryKey: queryKeys.roster(id) });
    } catch (caught) {
      setMessage({ tone: 'danger', text: t(errorMessageKey(caught)) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen testID="printed-badge-screen">
      <Title>{t('printedBadge.title')}</Title>
      {name ? <Body>{name}</Body> : null}
      <Body>{t('printedBadge.intro')}</Body>
      {badge ? (
        <>
          <QrBlock
            value={badge.code}
            caption={t('printedBadge.caption')}
            testID="printed-badge-qr"
            pngRef={pngRef}
          />
          <Text style={styles.note}>{t('printedBadge.custody')}</Text>
          <AppButton
            variant="secondary"
            label={t('printedBadge.sharePrint')}
            onPress={() => {
              const toPng = pngRef.current;
              if (!toPng) return;
              void toPng()
                .then((png) => sharePng(png, 'sitemuster-badge.png'))
                .catch(() =>
                  setMessage({ tone: 'danger', text: t('orientation.shareUnavailable') }),
                );
            }}
            testID="printed-badge-share"
          />
          <TextField
            label={t('printedBadge.revokeReason')}
            value={reason}
            onChangeText={setReason}
            maxLength={500}
            testID="printed-badge-reason"
          />
          <AppButton
            variant="secondary"
            label={t('printedBadge.revoke')}
            onPress={() => void revoke()}
            disabled={busy}
            testID="printed-badge-revoke"
          />
        </>
      ) : (
        <AppButton
          label={busy ? t('common.saving') : t('printedBadge.issue')}
          onPress={() => void issue()}
          disabled={busy}
          testID="printed-badge-issue"
        />
      )}
      {message ? (
        <Banner tone={message.tone} text={message.text} testID="printed-badge-message" />
      ) : null}
      <AppButton
        variant="secondary"
        label={t('common.done')}
        onPress={() => router.back()}
        testID="printed-badge-done"
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  note: { fontSize: 15, color: colors.mutedText, textAlign: 'center' },
});
