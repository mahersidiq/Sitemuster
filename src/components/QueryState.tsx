import { useTranslation } from 'react-i18next';

import { errorMessageKey } from '../api/errors';
import { AppButton } from './AppButton';
import { Banner } from './Banner';
import { Body } from './Typography';

/** Loading / error states for server reads: errors are explicit and never replaced by fake data. */
export function QueryState({
  isLoading,
  error,
  onRetry,
}: {
  isLoading: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  if (isLoading) return <Body>{t('common.loading')}</Body>;
  if (!error) return null;
  return (
    <>
      <Banner tone="danger" text={t(errorMessageKey(error))} testID="query-error" />
      <AppButton variant="secondary" label={t('common.retry')} onPress={onRetry} testID="retry" />
    </>
  );
}
