import { Redirect, Tabs } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { useSession } from '../../src/state/session';
import { colors } from '../../src/theme';

/** GC/superintendent tabs: Home, Projects, Workforce, Map, More (docs/spec/01-product.md). */
export default function StaffLayout() {
  const { t } = useTranslation();
  const { previewRole } = useSession();
  // Milestone 01: only the development preview can open this shell. Milestone 03 adds real auth.
  if (previewRole !== 'staff') return <Redirect href="/sign-in" />;
  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.primary,
        tabBarLabelStyle: { fontSize: 13 },
        headerTitleAlign: 'center',
      }}
    >
      <Tabs.Screen name="home" options={{ title: t('staff.tabs.home') }} />
      <Tabs.Screen name="projects" options={{ title: t('staff.tabs.projects') }} />
      <Tabs.Screen name="workforce" options={{ title: t('staff.tabs.workforce') }} />
      <Tabs.Screen name="map" options={{ title: t('staff.tabs.map') }} />
      <Tabs.Screen name="more" options={{ title: t('staff.tabs.more') }} />
    </Tabs>
  );
}
