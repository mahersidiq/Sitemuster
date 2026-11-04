import { router } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { AppButton } from '../src/components/AppButton';
import { Banner } from '../src/components/Banner';
import { Screen } from '../src/components/Screen';
import { Body, Heading, Title } from '../src/components/Typography';
import { useAuth } from '../src/state/auth';
import { useSession, type PreviewRole } from '../src/state/session';
import { colors, spacing } from '../src/theme';

/**
 * Sign-in choice: workers use an SMS code; staff use an email code plus an authenticator app.
 * Without a configured backend (development only) both actions stay disabled — no fake success.
 */
export default function SignInScreen() {
  const { t } = useTranslation();
  const { devPreviewAvailable, enterPreview } = useSession();
  const { state } = useAuth();
  const backendAvailable = state.status !== 'unavailable';

  const preview = (role: PreviewRole) => {
    enterPreview(role);
    router.replace(role === 'worker' ? '/worker/home' : '/staff/home');
  };

  return (
    <Screen testID="sign-in-screen">
      <Title>{t('signIn.title')}</Title>
      {backendAvailable ? null : (
        <Banner text={t('signIn.backendUnavailable')} testID="backend-unavailable" />
      )}

      <View style={styles.card}>
        <Heading>{t('signIn.workerHeading')}</Heading>
        <Body>{t('signIn.workerBody')}</Body>
        <AppButton
          label={t('signIn.workerAction')}
          disabled={!backendAvailable}
          onPress={() => router.push('/auth/phone')}
          testID="worker-sign-in"
        />
      </View>

      <View style={styles.card}>
        <Heading>{t('signIn.staffHeading')}</Heading>
        <Body>{t('signIn.staffBody')}</Body>
        <AppButton
          label={t('signIn.staffAction')}
          disabled={!backendAvailable}
          onPress={() => router.push('/auth/email')}
          testID="staff-sign-in"
        />
      </View>

      <View style={styles.card}>
        <Heading>{t('signIn.noPhoneHeading')}</Heading>
        <Body>{t('signIn.noPhoneBody')}</Body>
      </View>

      <AppButton
        variant="secondary"
        label={t('signIn.recoveryLink')}
        onPress={() => router.push('/auth/recovery')}
        testID="recovery-link"
      />

      {devPreviewAvailable ? (
        <View style={styles.card} testID="dev-preview">
          <Heading>{t('signIn.devPreviewHeading')}</Heading>
          <AppButton
            variant="secondary"
            label={t('signIn.devPreviewWorker')}
            onPress={() => preview('worker')}
            testID="preview-worker"
          />
          <AppButton
            variant="secondary"
            label={t('signIn.devPreviewStaff')}
            onPress={() => preview('staff')}
            testID="preview-staff"
          />
        </View>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
  },
});
