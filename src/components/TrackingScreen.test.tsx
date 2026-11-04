import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen } from '@testing-library/react-native';
import * as SecureStore from 'expo-secure-store';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import TrackingScreen from '../../app/worker/tracking';
import { LanguageProvider } from '../state/language';
import type { TrackingStatus } from '../tracking/service';

/** Device permission and sync-state UX (Milestone 07): every state is visible, EN and ES. */
const mockTracking: {
  status: TrackingStatus | null;
  requestPermission: jest.Mock<() => Promise<void>>;
  syncNow: jest.Mock<() => Promise<void>>;
  refresh: jest.Mock<() => Promise<void>>;
} = {
  status: null,
  requestPermission: jest.fn(async () => undefined),
  syncNow: jest.fn(async () => undefined),
  refresh: jest.fn(async () => undefined),
};

jest.mock('../state/tracking', () => ({ useTracking: () => mockTracking }));

const BASE: TrackingStatus = {
  phase: 'ACTIVE',
  mode: 'ARMED_OFFSITE',
  permission: { location: 'ALWAYS', precise: true, servicesEnabled: true },
  credential: 'OK',
  credentialExpiresAt: '2026-12-04T12:00:00Z',
  coordinatesAllowed: true,
  monitored: [{ id: 'p1', name: 'Main Street Tower' }],
  notMonitored: [],
  queued: 3,
  lastHttpStatus: 200,
  planStale: false,
};

async function show(status: TrackingStatus, locale: 'en-US' | 'es-US' = 'en-US') {
  mockTracking.status = status;
  await SecureStore.setItemAsync('sitemuster.locale.v1', locale);
  await render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 0, left: 0, right: 0, bottom: 0 },
      }}
    >
      <LanguageProvider appEnv="development">
        <TrackingScreen />
      </LanguageProvider>
    </SafeAreaProvider>,
  );
}

beforeEach(() => {
  mockTracking.requestPermission.mockClear();
  mockTracking.syncNow.mockClear();
});

describe('automatic attendance screen', () => {
  it('shows the active state, the estimate notice, monitored sites, key validity and the queue', async () => {
    await show(BASE);
    expect(
      await screen.findByText(
        'On. Your phone notes when you arrive at and leave your sites (estimated).',
      ),
    ).toBeTruthy();
    expect(screen.getByText('Waiting for you to arrive at a site')).toBeTruthy();
    expect(screen.getByText(/an estimate, not proof that you are on site/)).toBeTruthy();
    expect(screen.getByText('Main Street Tower')).toBeTruthy();
    expect(screen.getByText('Location records waiting to upload: 3')).toBeTruthy();
    expect(screen.getByText(/^Valid until /)).toBeTruthy();
    await fireEvent.press(screen.getByTestId('tracking-sync-now'));
    expect(mockTracking.syncNow).toHaveBeenCalledTimes(1);
  });

  it('lists each missing permission and offers to allow location (no silent failure)', async () => {
    await show({
      ...BASE,
      phase: 'PERMISSION_REQUIRED',
      mode: 'DISARMED',
      permission: { location: 'WHEN_IN_USE', precise: false, servicesEnabled: true },
    });
    expect(
      await screen.findByText(
        'Needs location permission: allow "Always" and keep Precise location on.',
      ),
    ).toBeTruthy();
    expect(screen.getByTestId('tracking-permission-location').props.children).toBe('Needed');
    expect(screen.getByTestId('tracking-permission-precise').props.children).toBe('Needed');
    expect(screen.getByTestId('tracking-permission-services').props.children).toBe('OK');
    await fireEvent.press(screen.getByTestId('tracking-allow'));
    expect(mockTracking.requestPermission).toHaveBeenCalledTimes(1);
  });

  it('explains limited mode, unmonitored sites and a refused upload', async () => {
    await show({
      ...BASE,
      phase: 'TRACKING_LIMITED',
      coordinatesAllowed: false,
      lastHttpStatus: 401,
      notMonitored: [
        { id: 'p2', name: 'Harbor Plant', reason: 'CONSENT_MISSING' },
        { id: 'p3', name: 'Airport Hangar', reason: 'REGION_BUDGET' },
      ],
    });
    expect(
      await screen.findByText(/Limited\. Your phone notes only entering and leaving/),
    ).toBeTruthy();
    expect(screen.getByText('Harbor Plant: Accept the site notice')).toBeTruthy();
    expect(screen.getByText(/Airport Hangar: Phone limit reached/)).toBeTruthy();
    expect(screen.getByTestId('tracking-refused')).toBeTruthy();
  });

  it('speaks Spanish when Spanish is chosen', async () => {
    await show({ ...BASE, phase: 'CREDENTIAL_EXPIRED', credential: 'EXPIRED' }, 'es-US');
    expect(
      await screen.findByText(
        'Abra SiteMuster con conexión para mantener activada la asistencia automática.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('Vencida. Abra SiteMuster con conexión para renovarla.')).toBeTruthy();
  });
});
