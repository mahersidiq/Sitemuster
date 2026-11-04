import { Redirect } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { InfoScreen } from '../../src/components/InfoScreen';
import { useAuth } from '../../src/state/auth';

/**
 * Someone signed in again while their account deletion is being processed (decision #137): the
 * server already refuses everything to them, so the app says so (with the usual sign-out button)
 * instead of showing empty or failing screens.
 */
export default function DeletionPendingScreen() {
  const { t } = useTranslation();
  const { state } = useAuth();
  if (state.status !== 'signed_in' || !state.access.account_deletion_pending) {
    return <Redirect href="/" />;
  }
  return (
    <InfoScreen
      testID="deletion-pending-screen"
      title={t('account.delete.pendingTitle')}
      body={t('account.delete.pendingBody')}
    />
  );
}
