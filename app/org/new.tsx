import { randomUUID } from 'expo-crypto';
import { Redirect, router } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { errorMessageKey } from '../../src/api/errors';
import { canCreateOrganization } from '../../src/auth/routing';
import { LoadingScreen } from '../../src/components/LoadingScreen';
import { AppButton } from '../../src/components/AppButton';
import { Banner } from '../../src/components/Banner';
import { Screen } from '../../src/components/Screen';
import { TextField } from '../../src/components/TextField';
import { Body, Title } from '../../src/components/Typography';
import { useAuth } from '../../src/state/auth';

/** GC activation step: create the organization record (idempotent; caller becomes OWNER). */
export default function NewOrganizationScreen() {
  const { t } = useTranslation();
  const { state, api, refresh } = useAuth();
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [businessEmail, setBusinessEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [idempotencyKey] = useState(() => randomUUID());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (api && state.status === 'loading') return <LoadingScreen />;
  if (!api || !canCreateOrganization(state)) return <Redirect href="/" />;

  const submit = async () => {
    if (name.trim().length === 0) {
      setError(t('org.nameRequired'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.createOrganization({
        name: name.trim(),
        address: address.trim(),
        businessEmail: businessEmail.trim(),
        phone: phone.trim(),
        idempotencyKey,
      });
      await refresh();
      router.replace('/staff/projects');
    } catch (caught) {
      setError(t(errorMessageKey(caught)));
      setBusy(false);
    }
  };

  return (
    <Screen testID="org-new-screen">
      <Title>{t('org.newTitle')}</Title>
      <Body>{t('org.newBody')}</Body>
      <TextField
        label={t('org.name')}
        value={name}
        onChangeText={setName}
        maxLength={200}
        testID="org-name"
      />
      <TextField
        label={t('org.address')}
        value={address}
        onChangeText={setAddress}
        maxLength={300}
        testID="org-address"
      />
      <TextField
        label={t('org.businessEmail')}
        value={businessEmail}
        onChangeText={setBusinessEmail}
        keyboardType="email-address"
        autoComplete="email"
        maxLength={254}
        testID="org-email"
      />
      <TextField
        label={t('org.phone')}
        value={phone}
        onChangeText={setPhone}
        keyboardType="phone-pad"
        maxLength={32}
        testID="org-phone"
      />
      {error ? <Banner tone="danger" text={error} testID="org-error" /> : null}
      <AppButton
        label={busy ? t('common.saving') : t('org.create')}
        onPress={() => void submit()}
        disabled={busy}
        testID="org-create"
      />
      <AppButton
        variant="secondary"
        label={t('common.back')}
        onPress={() => router.replace('/')}
        testID="org-cancel"
      />
    </Screen>
  );
}
