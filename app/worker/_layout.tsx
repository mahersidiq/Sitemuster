import { Redirect, Tabs } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { useSession } from '../../src/state/session';
import { tabNavigatorOptions, tabScreenOptions } from '../../src/navigation/tabOptions';

/** Worker tabs: Home, My Projects, Time History, Profile (docs/spec/01-product.md). */
export default function WorkerLayout() {
  const { t } = useTranslation();
  const { previewRole } = useSession();
  // Milestone 01: only the development preview can open this shell. Milestone 03 adds real auth.
  if (previewRole !== 'worker') return <Redirect href="/sign-in" />;
  return (
    <Tabs screenOptions={tabNavigatorOptions}>
      <Tabs.Screen name="home" options={tabScreenOptions(t('worker.tabs.home'))} />
      <Tabs.Screen name="projects" options={tabScreenOptions(t('worker.tabs.projects'))} />
      <Tabs.Screen name="history" options={tabScreenOptions(t('worker.tabs.history'))} />
      <Tabs.Screen name="profile" options={tabScreenOptions(t('worker.tabs.profile'))} />
    </Tabs>
  );
}
