import { Redirect, router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { useTranslation } from 'react-i18next';

import { errorCode, errorMessageKey } from '../../src/api/errors';
import { useLegalDocument } from '../../src/api/hooks';
import { errorMessageKey as authMessageKey } from '../../src/auth/auth-errors';
import { AppButton } from '../../src/components/AppButton';
import { Banner } from '../../src/components/Banner';
import { Card } from '../../src/components/Card';
import { LoadingScreen } from '../../src/components/LoadingScreen';
import { NoticeView } from '../../src/components/NoticeView';
import { QueryState } from '../../src/components/QueryState';
import { Screen } from '../../src/components/Screen';
import { TextField } from '../../src/components/TextField';
import { ToggleRow } from '../../src/components/ToggleRow';
import { Body, Heading, Title } from '../../src/components/Typography';
import { useApi, useAuth } from '../../src/state/auth';
import { useLanguage } from '../../src/state/language';
import { colors } from '../../src/theme';

export default function DeleteAccountRoute() {
  const { state, api } = useAuth();
  // Once started, the flow stays: signing in again (and the authenticator step) briefly changes
  // the access state, and the person must not be thrown out halfway.
  const signedIn = api !== null && state.status === 'signed_in';
  const [entered, setEntered] = useState(signedIn);
  if (signedIn && !entered) setEntered(true);
  if (entered || signedIn) return <DeleteAccount />;
  if (api && state.status === 'loading') return <LoadingScreen />;
  return <Redirect href="/" />;
}

type Step = 'explain' | 'verify' | 'mfa' | 'confirm' | 'done';

/**
 * In-app account deletion (spec 09, spec 11 `account-delete`). Read what happens, sign in again
 * with a fresh code (and the authenticator when one is set up), then confirm. Everything stops at
 * once; the identity is removed by the server within 30 days (normally a day).
 */
function DeleteAccount() {
  const { t } = useTranslation();
  const { activeLocale } = useLanguage();
  const { state, gateway, signOut } = useAuth();
  const api = useApi();
  const notice = useLegalDocument('ACCOUNT_DELETION_RETENTION', activeLocale);
  const [step, setStep] = useState<Step>('explain');
  const [understood, setUnderstood] = useState(false);
  const [contact, setContact] = useState<{ phone: string | null; email: string | null } | null>(
    null,
  );
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sendCode = async () => {
    if (!gateway) return;
    setBusy(true);
    setError(null);
    const who = await gateway.sessionContact();
    setContact(who);
    const result = who.phone
      ? await gateway.requestPhoneCode(who.phone)
      : who.email
        ? await gateway.requestEmailCode(who.email)
        : null;
    setBusy(false);
    if (!result) {
      setError(t('account.delete.noContact'));
      return;
    }
    if (!result.ok) {
      setError(t(authMessageKey(result.error)));
      return;
    }
    setCode('');
    setStep('verify');
  };

  const verify = async () => {
    if (!gateway || !contact) return;
    setBusy(true);
    setError(null);
    const result = contact.phone
      ? await gateway.verifyPhoneCode(contact.phone, code.trim())
      : await gateway.verifyEmailCode(contact.email ?? '', code.trim());
    if (!result.ok) {
      setBusy(false);
      setError(t(authMessageKey(result.error)));
      return;
    }
    const assurance = await gateway.assurance();
    setBusy(false);
    setCode('');
    setStep(assurance.next === 'aal2' && assurance.current !== 'aal2' ? 'mfa' : 'confirm');
  };

  const verifyAuthenticator = async () => {
    if (!gateway) return;
    setBusy(true);
    setError(null);
    const [factorId] = await gateway.verifiedTotpFactorIds();
    const result = factorId
      ? await gateway.verifyTotp(factorId, code.trim())
      : ({ ok: false, error: 'MFA_INVALID_CODE', retryAfter: null } as const);
    setBusy(false);
    if (!result.ok) {
      setError(t(authMessageKey(result.error)));
      return;
    }
    setCode('');
    setStep('confirm');
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.deleteAccount();
      setStep('done');
      // The server already signed this person out everywhere and revoked the phone. End the
      // session on this phone too, right now: tracking stops and its queue is dropped even if
      // the app goes to the background before "Done" is pressed (review on PR #12).
      await signOut();
    } catch (caught) {
      const kind = errorCode(caught);
      if (kind === 'REAUTHENTICATION_REQUIRED') setStep('explain');
      if (kind === 'MFA_REQUIRED') setStep('mfa');
      setError(t(errorMessageKey(caught)));
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    if (state.status === 'signed_in') await signOut();
    router.replace('/');
  };

  return (
    <Screen testID="delete-account-screen">
      <Title>{t('account.delete.title')}</Title>
      {step === 'explain' ? (
        <>
          <QueryState
            isLoading={notice.isLoading}
            error={notice.error}
            onRetry={() => void notice.refetch()}
          />
          {notice.data ? <NoticeView notice={notice.data} acceptable /> : null}
          <ToggleRow
            label={t('account.delete.understand')}
            value={understood}
            onValueChange={setUnderstood}
            testID="delete-understand"
          />
          <AppButton
            label={t('account.delete.continue')}
            onPress={() => void sendCode()}
            disabled={!understood || busy}
            testID="delete-continue"
          />
        </>
      ) : null}
      {step === 'verify' ? (
        <Card testID="delete-verify">
          <Heading>{t('account.delete.verifyTitle')}</Heading>
          <Body>
            {contact?.phone ? t('account.delete.codeSentPhone') : t('account.delete.codeSentEmail')}
          </Body>
          <TextField
            label={t('account.delete.code')}
            value={code}
            onChangeText={setCode}
            keyboardType="number-pad"
            maxLength={6}
            testID="delete-code"
          />
          <AppButton
            label={t('account.delete.verify')}
            onPress={() => void verify()}
            disabled={busy}
            testID="delete-verify-button"
          />
        </Card>
      ) : null}
      {step === 'mfa' ? (
        <Card testID="delete-mfa">
          <Heading>{t('account.delete.mfaTitle')}</Heading>
          <TextField
            label={t('account.delete.mfaCode')}
            value={code}
            onChangeText={setCode}
            keyboardType="number-pad"
            maxLength={6}
            testID="delete-mfa-code"
          />
          <AppButton
            label={t('account.delete.verify')}
            onPress={() => void verifyAuthenticator()}
            disabled={busy}
            testID="delete-mfa-button"
          />
        </Card>
      ) : null}
      {step === 'confirm' ? (
        <Card testID="delete-confirm">
          <Banner tone="danger" text={t('account.delete.final')} />
          <AppButton
            label={t('account.delete.now')}
            onPress={() => void remove()}
            disabled={busy}
            testID="delete-now"
          />
        </Card>
      ) : null}
      {step === 'done' ? (
        <Card testID="delete-done">
          <Banner tone="success" text={t('account.delete.done')} />
          <AppButton
            label={t('common.done')}
            onPress={() => void finish()}
            testID="delete-finish"
          />
        </Card>
      ) : null}
      {error ? <Banner tone="danger" text={error} testID="delete-error" /> : null}
      {step !== 'done' ? (
        <>
          <Text style={styles.hint}>{t('account.delete.keepHint')}</Text>
          <AppButton
            variant="secondary"
            label={t('common.cancel')}
            onPress={() => router.back()}
            testID="delete-cancel"
          />
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({ hint: { fontSize: 15, color: colors.mutedText } });
