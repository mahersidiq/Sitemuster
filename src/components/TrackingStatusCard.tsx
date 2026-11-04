import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { useTracking } from '../state/tracking';
import type { TrackingPhase } from '../tracking/service';
import { Banner } from './Banner';
import { Card } from './Card';
import { Body, Title } from './Typography';

const TONE: Record<TrackingPhase, 'success' | 'warning' | 'danger' | 'info'> = {
  STARTING: 'info',
  ACTIVE: 'success',
  TRACKING_LIMITED: 'warning',
  PERMISSION_REQUIRED: 'warning',
  NO_DEVICE: 'info',
  NOT_ENROLLED: 'info',
  DEVICE_REVOKED: 'danger',
  CREDENTIAL_EXPIRED: 'danger',
  UNAVAILABLE: 'warning',
};

/** Worker home: one-line automatic-attendance status, opening the details screen. */
export function TrackingStatusCard() {
  const { t } = useTranslation();
  const router = useRouter();
  const { status } = useTracking();
  if (!status) return null;
  return (
    <Card
      testID="tracking-card"
      accessibilityLabel={t('tracking.openDetails')}
      onPress={() => router.push('/worker/tracking')}
    >
      <Title>{t('tracking.title')}</Title>
      <Banner
        tone={TONE[status.phase]}
        text={t(`tracking.phase.${status.phase}`)}
        testID="tracking-card-phase"
      />
      <Body>{t('tracking.openDetails')}</Body>
    </Card>
  );
}

export { TONE as TRACKING_PHASE_TONE };
