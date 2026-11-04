import { Redirect, Tabs } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { canOpenStaffShell } from '../../src/auth/routing';
import { LoadingScreen } from '../../src/components/LoadingScreen';
import { ProjectLiveProvider } from '../../src/realtime/ProjectLive';
import { useAuth } from '../../src/state/auth';
import { useSelectedProject } from '../../src/state/selected-project';
import { useSession } from '../../src/state/session';
import { tabNavigatorOptions, tabScreenOptions } from '../../src/navigation/tabOptions';

/** GC/superintendent tabs: Home, Projects, Workforce, Map, More (docs/spec/01-product.md). */
export default function StaffLayout() {
  const { t } = useTranslation();
  const { previewRole } = useSession();
  const { state } = useAuth();
  const { projectId } = useSelectedProject();
  // Real access needs the server-confirmed role (staff: MFA aal2); the preview is development-only.
  // Keep deep links while the stored session is restored; decide once access is known.
  if (previewRole !== 'staff' && state.status === 'loading') return <LoadingScreen />;
  if (previewRole !== 'staff' && !canOpenStaffShell(state)) return <Redirect href="/" />;
  return (
    // One private live channel for the selected project, shared by Home, Workforce and Map.
    <ProjectLiveProvider projectId={projectId}>
      <Tabs screenOptions={tabNavigatorOptions}>
        <Tabs.Screen name="home" options={tabScreenOptions(t('staff.tabs.home'))} />
        <Tabs.Screen name="projects" options={tabScreenOptions(t('staff.tabs.projects'))} />
        <Tabs.Screen name="workforce" options={tabScreenOptions(t('staff.tabs.workforce'))} />
        <Tabs.Screen name="map" options={tabScreenOptions(t('staff.tabs.map'))} />
        <Tabs.Screen name="more" options={tabScreenOptions(t('staff.tabs.more'))} />
      </Tabs>
    </ProjectLiveProvider>
  );
}
