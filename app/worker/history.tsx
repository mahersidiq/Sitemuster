import { useTranslation } from 'react-i18next';

import { ShellScreen } from '../../src/components/ShellScreen';

export default function WorkerHistoryScreen() {
  const { t } = useTranslation();
  return (
    <ShellScreen
      testID="worker-history"
      title={t('worker.history.title')}
      body={t('worker.history.body')}
    />
  );
}
