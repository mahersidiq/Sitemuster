import { router } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { useAuth } from '../state/auth';
import { useSession } from '../state/session';
import { spacing } from '../theme';
import { AppButton } from './AppButton';
import { Banner } from './Banner';

/** Account actions for Profile (worker) and More (staff): stale-access notice and sign out. */
export function AccountSection() {
  const { t } = useTranslation();
  const { state, signOut, refresh } = useAuth();
  const { previewRole, exitPreview } = useSession();
  if (previewRole) {
    return (
      <AppButton
        variant="secondary"
        label={t('access.signOut')}
        onPress={() => {
          exitPreview();
          router.replace('/');
        }}
        testID="exit-preview"
      />
    );
  }
  if (state.status !== 'signed_in') return null;
  return (
    <View style={styles.container}>
      {state.accessIsStale ? (
        <>
          <Banner text={t('access.staleNotice')} testID="stale-access" />
          <AppButton
            variant="secondary"
            label={t('access.retry')}
            onPress={() => void refresh()}
            testID="refresh-access"
          />
        </>
      ) : null}
      <AppButton
        variant="secondary"
        label={t('access.signOut')}
        onPress={() => void signOut().then(() => router.replace('/'))}
        testID="sign-out"
      />
    </View>
  );
}

const styles = StyleSheet.create({ container: { gap: spacing.sm } });
