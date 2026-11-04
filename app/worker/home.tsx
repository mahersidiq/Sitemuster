import { useTranslation } from 'react-i18next';

import { ShellScreen } from '../../src/components/ShellScreen';

export default function WorkerHomeScreen() {
  const { t } = useTranslation();
  return (
    <ShellScreen testID="worker-home" title={t('worker.home.title')} body={t('worker.home.body')} />
  );
}
