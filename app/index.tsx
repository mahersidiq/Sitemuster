import { Redirect } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { Screen } from '../src/components/Screen';
import { Body } from '../src/components/Typography';
import { useLanguage } from '../src/state/language';
import { useSession } from '../src/state/session';

/** Entry router: explicit language choice first, then sign-in (or the active preview shell). */
export default function Index() {
  const { t } = useTranslation();
  const { ready, chosenLocale } = useLanguage();
  const { previewRole } = useSession();
  if (!ready) {
    return (
      <Screen>
        <Body>{t('common.loading')}</Body>
      </Screen>
    );
  }
  if (!chosenLocale) return <Redirect href="/language" />;
  if (previewRole === 'worker') return <Redirect href="/worker/home" />;
  if (previewRole === 'staff') return <Redirect href="/staff/home" />;
  return <Redirect href="/sign-in" />;
}
