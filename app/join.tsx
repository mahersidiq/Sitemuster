import { useTranslation } from 'react-i18next';

import { InfoScreen } from '../src/components/InfoScreen';

/** Signed-in worker without a project yet (joining through orientation arrives in Milestone 05). */
export default function JoinScreen() {
  const { t } = useTranslation();
  return (
    <InfoScreen testID="join-screen" title={t('access.joinTitle')} body={t('access.joinBody')} />
  );
}
