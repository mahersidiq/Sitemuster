import { router } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { errorMessageKey } from '../../src/auth/auth-errors';
import { AppButton } from '../../src/components/AppButton';
import { Screen } from '../../src/components/Screen';
import { TextField } from '../../src/components/TextField';
import { Body, Title } from '../../src/components/Typography';
import { useAuth } from '../../src/state/auth';

/** Staff second step on every sign-in: current authenticator code (aal1 → aal2). */
export default function MfaVerifyScreen() {
  const { t } = useTranslation();
  const { gateway, state, refresh, signOut } = useAuth();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const factorId = state.status === 'needs_mfa_verify' ? state.factorId : null;

  const confirm = async () => {
    if (!gateway || !factorId) return;
    setBusy(true);
    setError(null);
    const result = await gateway.verifyTotp(factorId, code);
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
    <Screen testID="mfa-verify-screen">
      <Title>{t('mfa.verifyTitle')}</Title>
      <Body>{t('mfa.verifyBody')}</Body>
      <TextField
        label={t('mfa.codeLabel')}
        value={code}
        onChangeText={(next) => setCode(next.replace(/\D/g, '').slice(0, 6))}
        keyboardType="number-pad"
        autoComplete="one-time-code"
        textContentType="oneTimeCode"
        maxLength={6}
        error={error}
        large
        testID="mfa-verify-input"
      />
      <AppButton
        label={busy ? t('auth.verifying') : t('mfa.confirm')}
        disabled={busy || !factorId || code.length !== 6}
        onPress={() => void confirm()}
        testID="mfa-verify-confirm"
      />
      <AppButton
        variant="secondary"
        label={t('mfa.lostDevice')}
        onPress={() => router.push('/auth/recovery')}
      />
      <AppButton
        variant="secondary"
        label={t('access.signOut')}
        onPress={() => void signOut().then(() => router.replace('/'))}
      />
    </Screen>
  );
}
