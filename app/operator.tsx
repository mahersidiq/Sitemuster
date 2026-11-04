import { useTranslation } from 'react-i18next';

import { InfoScreen } from '../src/components/InfoScreen';

/** Platform operator accounts never use the mobile app (decision #32). */
export default function OperatorScreen() {
  const { t } = useTranslation();
  return (
    <InfoScreen
      testID="operator-screen"
      title={t('access.operatorTitle')}
      body={t('access.operatorBody')}
    />
  );
}
