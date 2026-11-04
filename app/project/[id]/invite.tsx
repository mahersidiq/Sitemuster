import { useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { PROJECT_STAFF_ROLES, type ProjectStaffRole } from '@sitemuster/shared';

import { errorMessageKey } from '../../../src/api/errors';
import { queryKeys, useProject } from '../../../src/api/hooks';
import { managedOrganizationIds } from '../../../src/auth/routing';
import { AppButton } from '../../../src/components/AppButton';
import { Banner } from '../../../src/components/Banner';
import { ChipGroup } from '../../../src/components/ChipGroup';
import { QueryState } from '../../../src/components/QueryState';
import { Screen } from '../../../src/components/Screen';
import { StaffGate } from '../../../src/components/StaffGate';
import { TextField } from '../../../src/components/TextField';
import { ToggleRow } from '../../../src/components/ToggleRow';
import { Body, Heading, Title } from '../../../src/components/Typography';
import { useApi, useAuth } from '../../../src/state/auth';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export default function InviteStaffScreen() {
  return (
    <StaffGate>
      <InviteStaffForm />
    </StaffGate>
  );
}

/**
 * Invite project staff by e-mail. The invitee accepts after signing in with that verified e-mail
 * and MFA. Extra powers (emergency role, configuration/staffing delegation, correction approval)
 * can only be granted by an organization owner/admin (server-enforced, decision #65).
 */
function InviteStaffForm() {
  const { t } = useTranslation();
  const api = useApi();
  const { state } = useAuth();
  const queryClient = useQueryClient();
  const { id } = useLocalSearchParams<{ id: string }>();
  const project = useProject(id);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<ProjectStaffRole>('SUPER');
  const [emergency, setEmergency] = useState(false);
  const [canConfigure, setCanConfigure] = useState(false);
  const [canAssign, setCanAssign] = useState(false);
  const [canApprove, setCanApprove] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const orgAdmin =
    project.data !== undefined &&
    managedOrganizationIds(state).includes(project.data.project.organization_id);

  const submit = async () => {
    const normalized = email.trim().toLowerCase();
    if (!EMAIL.test(normalized)) {
      setError(t('apiErrors.INVALID_EMAIL'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.inviteStaff({
        projectId: id,
        email: normalized,
        role,
        emergencyDesignated: orgAdmin && emergency,
        canConfigureProject: orgAdmin && role === 'PM' && canConfigure,
        canAssignStaff: orgAdmin && role === 'PM' && canAssign,
        canApproveCorrections: orgAdmin && role === 'SAFETY' && canApprove,
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.project(id) });
      setSentTo(normalized);
      setEmail('');
    } catch (caught) {
      setError(t(errorMessageKey(caught)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen testID="invite-staff-screen">
      <Title>{t('invite.title')}</Title>
      <QueryState
        isLoading={project.isLoading}
        error={project.error}
        onRetry={() => void project.refetch()}
      />
      {project.data ? (
        <Body>{t('invite.body', { project: project.data.project.name })}</Body>
      ) : null}
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
        testID="invite-email"
      />
      <Heading>{t('invite.role')}</Heading>
      <ChipGroup
        label={t('invite.role')}
        options={PROJECT_STAFF_ROLES.map((value) => ({ value, label: t(`roles.${value}`) }))}
        selected={[role]}
        onToggle={setRole}
        testID="invite-role"
      />
      <Body>{t(`roleHelp.${role}`)}</Body>
      {orgAdmin ? (
        <>
          <ToggleRow
            label={t('invite.emergency')}
            description={t('invite.emergencyHint')}
            value={emergency}
            onValueChange={setEmergency}
            testID="invite-emergency"
          />
          {role === 'PM' ? (
            <>
              <ToggleRow
                label={t('invite.canConfigure')}
                value={canConfigure}
                onValueChange={setCanConfigure}
                testID="invite-can-configure"
              />
              <ToggleRow
                label={t('invite.canAssign')}
                value={canAssign}
                onValueChange={setCanAssign}
                testID="invite-can-assign"
              />
            </>
          ) : null}
          {role === 'SAFETY' ? (
            <ToggleRow
              label={t('invite.canApprove')}
              value={canApprove}
              onValueChange={setCanApprove}
              testID="invite-can-approve"
            />
          ) : null}
        </>
      ) : (
        <Body>{t('invite.delegationNote')}</Body>
      )}
      {error ? <Banner tone="danger" text={error} testID="invite-error" /> : null}
      <AppButton
        label={busy ? t('common.saving') : t('invite.send')}
        onPress={() => void submit()}
        disabled={busy}
        testID="invite-send"
      />
      <AppButton
        variant="secondary"
        label={t('common.done')}
        onPress={() => router.back()}
        testID="invite-done"
      />
    </Screen>
  );
}
