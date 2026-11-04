import { Redirect } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { routeFor } from '../src/auth/routing';
import { Screen } from '../src/components/Screen';
import { Body } from '../src/components/Typography';
import { useAuth } from '../src/state/auth';
import { useLanguage } from '../src/state/language';
import { useSession } from '../src/state/session';

/** Entry router: explicit language choice first, then the screen the signed-in state allows. */
export default function Index() {
  const { t } = useTranslation();
  const { ready, chosenLocale } = useLanguage();
  const { previewRole } = useSession();
  const { state } = useAuth();
  if (!ready) {
    return (
      <Screen>
        <Body>{t('common.loading')}</Body>
      </Screen>
    );
  }
  if (chosenLocale && previewRole === 'worker') return <Redirect href="/worker/home" />;
  if (chosenLocale && previewRole === 'staff') return <Redirect href="/staff/home" />;
  const route = routeFor(state, chosenLocale !== null);
  if (route === null) {
    return (
      <Screen>
        <Body>{t('common.loading')}</Body>
      </Screen>
    );
  }
  return <Redirect href={route} />;
}
