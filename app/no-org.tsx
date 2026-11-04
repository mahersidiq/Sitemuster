import { useTranslation } from 'react-i18next';

import { InfoScreen } from '../src/components/InfoScreen';

/** Verified staff (aal2) with no organization or project role yet. */
export default function NoOrganizationScreen() {
  const { t } = useTranslation();
  return (
    <InfoScreen
      testID="no-org-screen"
      title={t('access.noOrgTitle')}
      body={t('access.noOrgBody')}
    />
  );
}
