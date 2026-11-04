import { useTranslation } from 'react-i18next';

import { useDemoProjects, useDemoStatus } from '../api/hooks';
import { Banner } from './Banner';

/**
 * Shown on every main screen of a demo project (decision #142): its people are synthetic and its
 * locations simulated. Whether a project is a demo comes only from the server allowlist.
 */
export function DemoBanner({ projectId }: { projectId: string | null | undefined }) {
  const { t } = useTranslation();
  const { demo } = useDemoStatus(projectId);
  if (!demo) return null;
  return <Banner tone="info" text={t('demo.banner')} testID="demo-banner" />;
}

/** Worker screens: shown when this account belongs to the reviewer demo. */
export function WorkerDemoBanner() {
  const { t } = useTranslation();
  const projects = useDemoProjects().data ?? [];
  if (projects.length === 0) return null;
  return <Banner tone="info" text={t('demo.workerBanner')} testID="demo-banner-worker" />;
}
