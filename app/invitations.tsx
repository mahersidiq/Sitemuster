import { useQueryClient } from '@tanstack/react-query';
import { Redirect, router } from 'expo-router';
import { useState } from 'react';
import { Text } from 'react-native';
import { useTranslation } from 'react-i18next';

import { errorMessageKey } from '../src/api/errors';
import { useMyInvitations } from '../src/api/hooks';
import type { MyInvitation } from '../src/api/types';
import { LoadingScreen } from '../src/components/LoadingScreen';
import { AppButton } from '../src/components/AppButton';
import { Banner } from '../src/components/Banner';
import { Card } from '../src/components/Card';
import { QueryState } from '../src/components/QueryState';
import { Screen } from '../src/components/Screen';
import { Body, Heading, Title } from '../src/components/Typography';
import { formatInstant } from '../src/projects/format';
import { useAuth } from '../src/state/auth';
import { useLanguage } from '../src/state/language';

/** Invitations addressed to the signed-in staff member's verified e-mail (accept needs MFA). */
export default function InvitationsScreen() {
  const { state, api } = useAuth();
  if (api && state.status === 'loading') return <LoadingScreen />;
  if (!api || state.status !== 'signed_in' || state.assurance.current !== 'aal2') {
    return <Redirect href="/" />;
  }
  return <InvitationsList />;
}

function InvitationsList() {
  const { t } = useTranslation();
  const { activeLocale } = useLanguage();
  const { api, refresh } = useAuth();
  const queryClient = useQueryClient();
  const invitations = useMyInvitations();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const accept = async (invitation: MyInvitation) => {
    if (!api) return;
    setBusyId(invitation.invitation_id);
    setError(null);
    try {
      await api.acceptInvitation(invitation.invitation_id);
      await queryClient.invalidateQueries();
      await refresh();
      router.replace('/');
    } catch (caught) {
      setError(t(errorMessageKey(caught)));
      setBusyId(null);
    }
  };

  const roleLabel = (invitation: MyInvitation) =>
    invitation.project_role
      ? t(`roles.${invitation.project_role}`)
      : t(`orgRoles.${invitation.org_role ?? 'ADMIN'}`);

  return (
    <Screen testID="invitations-screen">
      <Title>{t('invitations.title')}</Title>
      <Body>{t('invitations.body')}</Body>
      <QueryState
        isLoading={invitations.isLoading}
        error={invitations.error}
        onRetry={() => void invitations.refetch()}
      />
      {invitations.data && invitations.data.length === 0 ? (
        <Banner tone="info" text={t('invitations.empty')} testID="invitations-empty" />
      ) : null}
      {invitations.data?.map((invitation) => (
        <Card key={invitation.invitation_id} testID={`invitation-${invitation.invitation_id}`}>
          <Heading>{invitation.project_name ?? invitation.organization_name}</Heading>
          <Text>
            {t('invitations.summary', {
              organization: invitation.organization_name,
              role: roleLabel(invitation),
            })}
          </Text>
          <Text>
            {t('invitations.expires', {
              date: formatInstant(invitation.expires_at, undefined, activeLocale),
            })}
          </Text>
          <AppButton
            label={
              busyId === invitation.invitation_id ? t('common.saving') : t('invitations.accept')
            }
            onPress={() => void accept(invitation)}
            disabled={busyId !== null}
            testID={`accept-${invitation.invitation_id}`}
          />
        </Card>
      ))}
      {error ? <Banner tone="danger" text={error} testID="invitation-error" /> : null}
      <AppButton
        variant="secondary"
        label={t('common.back')}
        onPress={() => router.replace('/')}
        testID="invitations-back"
      />
    </Screen>
  );
}
