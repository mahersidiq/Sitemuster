import { Redirect, Tabs } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { useSession } from '../../src/state/session';
import { tabNavigatorOptions, tabScreenOptions } from '../../src/navigation/tabOptions';

/** GC/superintendent tabs: Home, Projects, Workforce, Map, More (docs/spec/01-product.md). */
export default function StaffLayout() {
  const { t } = useTranslation();
  const { previewRole } = useSession();
  // Milestone 01: only the development preview can open this shell. Milestone 03 adds real auth.
  if (previewRole !== 'staff') return <Redirect href="/sign-in" />;
  return (
    <Tabs screenOptions={tabNavigatorOptions}>
      <Tabs.Screen name="home" options={tabScreenOptions(t('staff.tabs.home'))} />
      <Tabs.Screen name="projects" options={tabScreenOptions(t('staff.tabs.projects'))} />
      <Tabs.Screen name="workforce" options={tabScreenOptions(t('staff.tabs.workforce'))} />
      <Tabs.Screen name="map" options={tabScreenOptions(t('staff.tabs.map'))} />
      <Tabs.Screen name="more" options={tabScreenOptions(t('staff.tabs.more'))} />
    </Tabs>
  );
}
