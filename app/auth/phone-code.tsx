import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { errorMessageKey } from '../../src/auth/auth-errors';
import { maskPhone } from '../../src/auth/phone';
import { AppButton } from '../../src/components/AppButton';
import { Screen } from '../../src/components/Screen';
import { TextField } from '../../src/components/TextField';
import { Body, Title } from '../../src/components/Typography';
import { useCountdown } from '../../src/components/useCountdown';
import { useAuth } from '../../src/state/auth';

/** Worker sign-in step 2: 6-digit SMS code, 10-minute validity, 60-second resend cooldown. */
export default function PhoneCodeScreen() {
  const { t } = useTranslation();
  const { gateway, refresh } = useAuth();
  const params = useLocalSearchParams<{ phone: string; sentAt?: string; cooldown?: string }>();
  const phone = params.phone ?? '';
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [requestedAt, setRequestedAt] = useState(() => Number(params.sentAt ?? Date.now()));
  const countdown = useCountdown(Number(params.cooldown ?? 60));

  useEffect(() => {
    if (!phone) router.replace('/auth/phone');
  }, [phone]);

  const verify = async () => {
    if (!/^\d{6}$/.test(code)) {
      setError(t('auth.errors.invalidCode'));
      return;
    }
    if (!gateway) return;
    setBusy(true);
    setError(null);
    const result = await gateway.verifyPhoneCode(phone, code);
    if (!result.ok) {
      setBusy(false);
      setError(t(errorMessageKey(result.error, requestedAt)));
      return;
    }
    await refresh();
    setBusy(false);
    router.replace('/');
  };

  const resend = async () => {
    if (!gateway) return;
    setError(null);
    const result = await gateway.requestPhoneCode(phone);
    if (result.ok) {
      setRequestedAt(Date.now());
      countdown.restart(60);
    } else if (result.error === 'RATE_LIMITED') {
      countdown.restart(result.retryAfter ?? 60);
    } else {
      setError(t(errorMessageKey(result.error)));
    }
  };

  return (
    <Screen testID="phone-code-screen">
      <Title>{t('auth.codeTitle')}</Title>
      <Body>{t('auth.codeSentTo', { destination: maskPhone(phone) })}</Body>
      <TextField
        label={t('auth.codeLabel')}
        value={code}
        onChangeText={(next) => setCode(next.replace(/\D/g, '').slice(0, 6))}
        keyboardType="number-pad"
        autoComplete="sms-otp"
        textContentType="oneTimeCode"
        maxLength={6}
        error={error}
        large
        testID="code-input"
        onSubmitEditing={() => void verify()}
      />
      <AppButton
        label={busy ? t('auth.verifying') : t('auth.verify')}
        disabled={busy || code.length !== 6}
        onPress={() => void verify()}
        testID="verify-code"
      />
      <AppButton
        variant="secondary"
        label={
          countdown.remaining > 0
            ? t('auth.resendIn', { seconds: countdown.remaining })
            : t('auth.resend')
        }
        disabled={countdown.remaining > 0}
        onPress={() => void resend()}
        testID="resend-code"
      />
      <AppButton
        variant="secondary"
        label={t('auth.changeNumber')}
        onPress={() => router.replace('/auth/phone')}
      />
    </Screen>
  );
}
