import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { useAuth } from '../state/auth';
import { useOutbox } from '../state/outbox';
import { spacing } from '../theme';
import { AppButton } from './AppButton';
import { Banner } from './Banner';
import { Card } from './Card';
import { Heading } from './Typography';

/**
 * Sign out without silently losing work (Milestone 08): records that have not reached the server
 * belong to this person's session and cannot be sent after sign-out, so leaving with some still
 * waiting needs an explicit choice — send them now, or discard them knowingly.
 */
export function SignOutButton({ testID = 'sign-out' }: { testID?: string }) {
  const { t } = useTranslation();
  const { signOut } = useAuth();
  const outbox = useOutbox();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const pending = outbox.status?.pending ?? 0;

  const leave = async () => {
    await signOut();
    router.replace('/');
  };
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };

  if (asking && pending > 0) {
    return (
      <Card testID={`${testID}-guard`}>
        <Heading>{t('signOutGuard.title')}</Heading>
        <Banner tone="danger" text={t('signOutGuard.body', { count: pending })} />
        <View style={styles.actions}>
          <AppButton
            label={t('signOutGuard.sync')}
            onPress={() => void run(() => outbox.syncNow())}
            disabled={busy}
            testID={`${testID}-guard-sync`}
          />
          <AppButton
            variant="secondary"
            label={t('signOutGuard.discard')}
            onPress={() =>
              void run(async () => {
                await outbox.discardAll();
                await leave();
              })
            }
            disabled={busy}
            testID={`${testID}-guard-discard`}
          />
          <AppButton
            variant="secondary"
            label={t('signOutGuard.cancel')}
            onPress={() => setAsking(false)}
            disabled={busy}
            testID={`${testID}-guard-cancel`}
          />
        </View>
      </Card>
    );
  }
  return (
    <AppButton
      variant="secondary"
      label={t('access.signOut')}
      onPress={() => (pending > 0 ? setAsking(true) : void run(leave))}
      disabled={busy}
      testID={testID}
    />
  );
}

const styles = StyleSheet.create({ actions: { gap: spacing.sm } });
