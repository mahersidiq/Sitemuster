import { Redirect, Tabs } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { useSession } from '../../src/state/session';
import { colors } from '../../src/theme';

/** Worker tabs: Home, My Projects, Time History, Profile (docs/spec/01-product.md). */
export default function WorkerLayout() {
  const { t } = useTranslation();
  const { previewRole } = useSession();
  // Milestone 01: only the development preview can open this shell. Milestone 03 adds real auth.
  if (previewRole !== 'worker') return <Redirect href="/sign-in" />;
  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.primary,
        tabBarLabelStyle: { fontSize: 13 },
        headerTitleAlign: 'center',
      }}
    >
      <Tabs.Screen name="home" options={{ title: t('worker.tabs.home') }} />
      <Tabs.Screen name="projects" options={{ title: t('worker.tabs.projects') }} />
      <Tabs.Screen name="history" options={{ title: t('worker.tabs.history') }} />
      <Tabs.Screen name="profile" options={{ title: t('worker.tabs.profile') }} />
    </Tabs>
  );
}
