import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { useTranslation } from 'react-i18next';

import { errorMessageKey } from '../../src/auth/auth-errors';
import type { TotpEnrollment } from '../../src/auth/gateway';
import { AppButton } from '../../src/components/AppButton';
import { Banner } from '../../src/components/Banner';
import { Screen } from '../../src/components/Screen';
import { TextField } from '../../src/components/TextField';
import { Body, Title } from '../../src/components/Typography';
import { useAuth } from '../../src/state/auth';
import { colors, spacing } from '../../src/theme';

/** Mandatory TOTP enrollment for staff (decision #3). The secret is shown once, never stored by the app. */
export default function MfaEnrollScreen() {
  const { t } = useTranslation();
  const { gateway, refresh, signOut } = useAuth();
  const [enrollment, setEnrollment] = useState<TotpEnrollment | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    if (!gateway) return undefined;
    void gateway.enrollTotp().then((result) => {
      if (!active) return;
      if ('error' in result) setError(t(errorMessageKey(result.error)));
      else setEnrollment(result);
    });
    return () => {
      active = false;
    };
  }, [gateway, t]);

  const confirm = async () => {
    if (!gateway || !enrollment) return;
    setBusy(true);
    setError(null);
    const result = await gateway.verifyTotp(enrollment.factorId, code);
    if (!result.ok) {
      setBusy(false);
      setError(
        t(
          errorMessageKey(
            result.error === 'INVALID_OR_EXPIRED_CODE' ? 'MFA_INVALID_CODE' : result.error,
          ),
        ),
      );
      return;
    }
    await refresh();
    setBusy(false);
    router.replace('/');
  };

  return (
    <Screen testID="mfa-enroll-screen">
      <Title>{t('mfa.enrollTitle')}</Title>
      <Body>{t('mfa.enrollBody')}</Body>
      {enrollment ? (
        <View style={styles.qrBox} accessibilityLabel={t('mfa.qrLabel')} accessible testID="mfa-qr">
          <QRCode value={enrollment.uri} size={200} />
        </View>
      ) : (
        <Body>{t('mfa.preparing')}</Body>
      )}
      {enrollment ? (
        <View style={styles.secretBox}>
          <Body>{t('mfa.secretLabel')}</Body>
          <Text selectable style={styles.secret} testID="mfa-secret">
            {enrollment.secret.replace(/(.{4})/g, '$1 ').trim()}
          </Text>
        </View>
      ) : null}
      {error && !enrollment ? <Banner tone="danger" text={error} /> : null}
      <TextField
        label={t('mfa.codeLabel')}
        value={code}
        onChangeText={(next) => setCode(next.replace(/\D/g, '').slice(0, 6))}
        keyboardType="number-pad"
        autoComplete="one-time-code"
        textContentType="oneTimeCode"
        maxLength={6}
        error={enrollment ? error : null}
        large
        testID="mfa-code-input"
      />
      <AppButton
        label={busy ? t('auth.verifying') : t('mfa.confirm')}
        disabled={busy || !enrollment || code.length !== 6}
        onPress={() => void confirm()}
        testID="mfa-confirm"
      />
      <AppButton
        variant="secondary"
        label={t('access.signOut')}
        onPress={() => void signOut().then(() => router.replace('/'))}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  qrBox: { alignSelf: 'center', padding: spacing.md, backgroundColor: colors.background },
  secretBox: { gap: spacing.xs },
  secret: { fontSize: 18, fontFamily: 'monospace', color: colors.text, letterSpacing: 1 },
});
