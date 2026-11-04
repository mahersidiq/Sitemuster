import { router } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { AppButton } from '../src/components/AppButton';
import { Banner } from '../src/components/Banner';
import { Screen } from '../src/components/Screen';
import { Body, Heading, Title } from '../src/components/Typography';
import { useSession, type PreviewRole } from '../src/state/session';
import { colors, spacing } from '../src/theme';

/**
 * Sign-in wireframe (Milestone 01). Real worker SMS OTP and staff email + TOTP arrive in
 * Milestone 03; until then both actions are visibly disabled — no fake success.
 */
export default function SignInScreen() {
  const { t } = useTranslation();
  const { devPreviewAvailable, enterPreview } = useSession();

  const preview = (role: PreviewRole) => {
    enterPreview(role);
    router.replace(role === 'worker' ? '/worker/home' : '/staff/home');
  };

  return (
    <Screen testID="sign-in-screen">
      <Title>{t('signIn.title')}</Title>
      <Banner text={t('common.notAvailableYet')} />

      <View style={styles.card}>
        <Heading>{t('signIn.workerHeading')}</Heading>
        <Body>{t('signIn.workerBody')}</Body>
        <AppButton label={t('signIn.workerAction')} disabled testID="worker-sign-in" />
      </View>

      <View style={styles.card}>
        <Heading>{t('signIn.staffHeading')}</Heading>
        <Body>{t('signIn.staffBody')}</Body>
        <AppButton label={t('signIn.staffAction')} disabled testID="staff-sign-in" />
      </View>

      <View style={styles.card}>
        <Heading>{t('signIn.noPhoneHeading')}</Heading>
        <Body>{t('signIn.noPhoneBody')}</Body>
      </View>

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
