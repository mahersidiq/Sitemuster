import { router } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { errorMessageKey } from '../../src/auth/auth-errors';
import { isValidEmail } from '../../src/auth/phone';
import { AppButton } from '../../src/components/AppButton';
import { Screen } from '../../src/components/Screen';
import { TextField } from '../../src/components/TextField';
import { Body, Title } from '../../src/components/Typography';
import { useAuth } from '../../src/state/auth';

/** Staff sign-in step 1: work email (passwordless code), followed by mandatory TOTP MFA. */
export default function EmailScreen() {
  const { t } = useTranslation();
  const { gateway } = useAuth();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const email = value.trim().toLowerCase();
    if (!isValidEmail(email)) {
      setError(t('auth.errors.invalidEmail'));
      return;
    }
    if (!gateway) return;
    setBusy(true);
    setError(null);
    const result = await gateway.requestEmailCode(email);
    setBusy(false);
    if (!result.ok && result.error !== 'RATE_LIMITED') {
      setError(t(errorMessageKey(result.error)));
      return;
    }
    const cooldown = result.ok ? 60 : (result.retryAfter ?? 60);
    router.push({
      pathname: '/auth/email-code',
      params: {
        email,
        sentAt: String(Date.now() - (60 - cooldown) * 1000),
        cooldown: String(cooldown),
      },
    });
  };

  return (
    <Screen testID="email-screen">
      <Title>{t('auth.emailTitle')}</Title>
      <Body>{t('auth.emailBody')}</Body>
      <TextField
        label={t('auth.emailLabel')}
        placeholder={t('auth.emailPlaceholder')}
        value={value}
        onChangeText={setValue}
        keyboardType="email-address"
        autoComplete="email"
        textContentType="emailAddress"
        error={error}
        testID="email-input"
        onSubmitEditing={() => void submit()}
      />
      <AppButton
        label={busy ? t('auth.sending') : t('auth.sendCode')}
        disabled={busy || value.trim().length === 0}
        onPress={() => void submit()}
        testID="send-email-code"
      />
    </Screen>
  );
}
