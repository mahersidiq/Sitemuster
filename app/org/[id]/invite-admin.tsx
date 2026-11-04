import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { errorMessageKey } from '../../../src/api/errors';
import { ownedOrganizationIds } from '../../../src/auth/routing';
import { AppButton } from '../../../src/components/AppButton';
import { Banner } from '../../../src/components/Banner';
import { Screen } from '../../../src/components/Screen';
import { StaffGate } from '../../../src/components/StaffGate';
import { TextField } from '../../../src/components/TextField';
import { Body, Title } from '../../../src/components/Typography';
import { useApi, useAuth } from '../../../src/state/auth';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export default function InviteOrgAdminScreen() {
  return (
    <StaffGate>
      <InviteOrgAdminForm />
    </StaffGate>
  );
}

/** Only an organization OWNER may invite organization admins (spec 02; server-enforced). */
function InviteOrgAdminForm() {
  const { t } = useTranslation();
  const api = useApi();
  const { state } = useAuth();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isOwner = ownedOrganizationIds(state).includes(id);

  const submit = async () => {
    const normalized = email.trim().toLowerCase();
    if (!EMAIL.test(normalized)) {
      setError(t('apiErrors.INVALID_EMAIL'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.inviteOrgAdmin(id, normalized);
      setSentTo(normalized);
      setEmail('');
    } catch (caught) {
      setError(t(errorMessageKey(caught)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen testID="invite-admin-screen">
      <Title>{t('org.inviteAdmin')}</Title>
      <Body>{t('org.inviteAdminBody')}</Body>
      {isOwner ? null : <Banner tone="danger" text={t('apiErrors.FORBIDDEN')} />}
      {sentTo ? (
        <Banner tone="success" text={t('invite.sent', { email: sentTo })} testID="invite-sent" />
      ) : null}
      <TextField
        label={t('invite.email')}
        value={email}
        onChangeText={setEmail}
        keyboardType="email-address"
        autoComplete="email"
        maxLength={254}
        testID="admin-email"
      />
      {error ? <Banner tone="danger" text={error} testID="admin-error" /> : null}
      <AppButton
        label={busy ? t('common.saving') : t('invite.send')}
        onPress={() => void submit()}
        disabled={busy || !isOwner}
        testID="admin-send"
      />
      <AppButton
        variant="secondary"
        label={t('common.done')}
        onPress={() => router.back()}
        testID="admin-done"
      />
    </Screen>
  );
}
