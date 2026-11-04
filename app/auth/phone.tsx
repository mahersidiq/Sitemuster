import { router } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { errorMessageKey } from '../../src/auth/auth-errors';
import { normalizePhone } from '../../src/auth/phone';
import { AppButton } from '../../src/components/AppButton';
import { Screen } from '../../src/components/Screen';
import { TextField } from '../../src/components/TextField';
import { Body, Title } from '../../src/components/Typography';
import { useAuth } from '../../src/state/auth';

/** Worker sign-in step 1: mobile number (decision #3). */
export default function PhoneScreen() {
  const { t } = useTranslation();
  const { gateway } = useAuth();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const parsed = normalizePhone(value);
    if (!parsed.ok) {
      setError(t('auth.errors.invalidPhone'));
      return;
    }
    if (!gateway) return;
    setBusy(true);
    setError(null);
    const result = await gateway.requestPhoneCode(parsed.e164);
    setBusy(false);
    if (!result.ok && result.error !== 'RATE_LIMITED') {
      setError(t(errorMessageKey(result.error)));
      return;
    }
    // RATE_LIMITED means a code was already sent less than 60 s ago: continue with that code.
    const cooldown = result.ok ? 60 : (result.retryAfter ?? 60);
    router.push({
      pathname: '/auth/phone-code',
      params: {
        phone: parsed.e164,
        sentAt: String(Date.now() - (60 - cooldown) * 1000),
        cooldown: String(cooldown),
      },
    });
  };

  return (
    <Screen testID="phone-screen">
      <Title>{t('auth.phoneTitle')}</Title>
      <Body>{t('auth.phoneBody')}</Body>
      <TextField
        label={t('auth.phoneLabel')}
        placeholder={t('auth.phonePlaceholder')}
        value={value}
        onChangeText={setValue}
        keyboardType="phone-pad"
        autoComplete="tel"
        textContentType="telephoneNumber"
        error={error}
        testID="phone-input"
        onSubmitEditing={() => void submit()}
      />
      <AppButton
        label={busy ? t('auth.sending') : t('auth.sendCode')}
        disabled={busy || value.trim().length === 0}
        onPress={() => void submit()}
        testID="send-code"
      />
      <Body>{t('auth.noPhoneHint')}</Body>
    </Screen>
  );
}
