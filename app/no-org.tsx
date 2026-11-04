import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { canCreateOrganization } from '../src/auth/routing';
import { AppButton } from '../src/components/AppButton';
import { InfoScreen } from '../src/components/InfoScreen';
import { useAuth } from '../src/state/auth';

/** Verified staff (aal2) with no organization or project role yet. */
export default function NoOrganizationScreen() {
  const { t } = useTranslation();
  const { state, api } = useAuth();
  const canAct = api !== null && canCreateOrganization(state);
  return (
    <InfoScreen testID="no-org-screen" title={t('access.noOrgTitle')} body={t('access.noOrgBody')}>
      {canAct ? (
        <>
          <AppButton
            label={t('org.createCta')}
            onPress={() => router.push('/org/new')}
            testID="create-organization"
          />
          <AppButton
            variant="secondary"
            label={t('invitations.cta')}
            onPress={() => router.push('/invitations')}
            testID="open-invitations"
          />
        </>
      ) : null}
    </InfoScreen>
  );
}
