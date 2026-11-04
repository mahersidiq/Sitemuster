import { describe, expect, it, jest } from '@jest/globals';
import { router } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import { act, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';

import type { MyConsent } from '../../src/api/types';
import { FakeSiteMusterApi, FakeWorld } from '../support/fake-api';
import {
  access,
  FAKE_EMAIL_CODE,
  FAKE_SMS_CODE,
  FAKE_TOTP_CODE,
  fakeBackend,
  ids,
} from '../support/fake-auth';

/**
 * Screen flows for Milestone 12 on the real `app/` routes: a worker switches location off and on
 * per project, accepts a materially changed notice, and deletes their account after a fresh
 * sign-in (staff also with the authenticator). The server side is tested in pgTAP 029, the
 * account-delete core tests and tests/backend/privacy.test.ts.
 */
type Globals = typeof globalThis & { __fakeAuthBackend?: unknown };

jest.mock('../../src/auth/create-gateway', () => ({
  createAuthBackend: () => (globalThis as Globals).__fakeAuthBackend ?? null,
}));

const PROJECT = '1a000000-0000-4000-8000-0000000000a1';
const NOTICE_V2 = 'aa000000-0000-4000-8000-0000000000e2';

function consent(overrides: Partial<MyConsent> = {}): MyConsent {
  return {
    project_id: PROJECT,
    project_name: 'Main Street Tower',
    consent_id: 'c1',
    locale: 'en-US',
    method: 'DIGITAL',
    accepted_at: '2026-11-01T15:00:00Z',
    notice_version_id: 'n1',
    notice_version: 1,
    location_enabled: true,
    renewal_required: false,
    renewal_notice: null,
    ...overrides,
  };
}

function signIn(world: FakeWorld, destination: string, options: { staff?: boolean } = {}) {
  const api = new FakeSiteMusterApi(world);
  const backend = fakeBackend(() => world.access, api);
  backend.gateway.session = { destination };
  backend.gateway.aal = options.staff ? 'aal2' : 'aal1';
  backend.gateway.factors = options.staff ? ['factor-1'] : [];
  (globalThis as Globals).__fakeAuthBackend = backend;
  return { api, backend };
}

async function chooseLanguage(locale: 'en-US' | 'es-US') {
  await SecureStore.setItemAsync('sitemuster.locale.v1', locale);
}

function workerWorld() {
  return new FakeWorld(access({ worker_profile_id: ids.worker }), '+15555550123');
}

describe('location and consent per project', () => {
  it('switches location off and on; the kiosk alternative is explained', async () => {
    const world = workerWorld();
    world.consents.push(consent());
    signIn(world, '+15555550123');
    await chooseLanguage('en-US');
    await renderRouter('./app', { initialUrl: '/worker/profile' });
    await fireEvent.press(await screen.findByTestId('open-privacy'));
    expect(await screen.findByTestId(`privacy-${PROJECT}`)).toBeTruthy();
    expect(
      screen.getByText('On: your phone counts you on site automatically (estimated).'),
    ).toBeTruthy();
    await fireEvent(screen.getByTestId(`privacy-location-${PROJECT}`), 'valueChange', false);
    expect(
      await screen.findByText(
        'Location is off for this project. Nothing is sent from your phone for it.',
      ),
    ).toBeTruthy();
    expect(world.consents[0]?.location_enabled).toBe(false);
    expect(
      await screen.findByText('Off: use the kiosk or your foreman to sign in and out.'),
    ).toBeTruthy();
    await fireEvent(screen.getByTestId(`privacy-location-${PROJECT}`), 'valueChange', true);
    await waitFor(() => expect(world.consents[0]?.location_enabled).toBe(true));
  });

  it('a materially changed notice must be read and accepted before location comes back', async () => {
    const world = workerWorld();
    world.consents.push(
      consent({
        location_enabled: false,
        renewal_required: true,
        renewal_notice: {
          id: NOTICE_V2,
          document_id: 'WORKER_LOCATION_DISCLOSURE_EN_V2',
          version: 2,
          locale: 'en-US',
          review_status: 'APPROVED',
          content: 'Updated worker location notice (version 2).',
          content_hash: 'b'.repeat(64),
        },
      }),
    );
    signIn(world, '+15555550123');
    await chooseLanguage('es-US');
    await renderRouter('./app', { initialUrl: '/privacy' });
    expect(await screen.findByTestId(`privacy-renewal-${PROJECT}`)).toBeTruthy();
    expect(screen.getByText('Updated worker location notice (version 2).')).toBeTruthy();
    expect(screen.queryByTestId(`privacy-location-${PROJECT}`)).toBeNull();
    await fireEvent.press(screen.getByTestId(`privacy-accept-${PROJECT}`));
    expect(
      await screen.findByText('Gracias. La ubicación está encendida otra vez para este proyecto.'),
    ).toBeTruthy();
    expect(world.consents[0]).toMatchObject({
      notice_version_id: NOTICE_V2,
      renewal_required: false,
      location_enabled: true,
    });
  });
});

describe('account deletion', () => {
  it('a worker signs in again with a fresh code, confirms, and is signed out', async () => {
    const world = workerWorld();
    const { backend } = signIn(world, '+15555550123');
    await chooseLanguage('en-US');
    const app = await renderRouter('./app', { initialUrl: '/worker/profile' });
    await fireEvent.press(await screen.findByTestId('open-delete-account'));
    expect(await screen.findByTestId('notice-view')).toBeTruthy();
    expect(screen.getByTestId('notice-draft')).toBeTruthy();
    expect(screen.getByTestId('delete-continue').props.accessibilityState).toMatchObject({
      disabled: true,
    });
    await fireEvent(screen.getByTestId('delete-understand'), 'valueChange', true);
    await fireEvent.press(screen.getByTestId('delete-continue'));
    expect(await screen.findByText('We sent a 6-digit code to your phone number.')).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId('delete-code'), '000000');
    await fireEvent.press(screen.getByTestId('delete-verify-button'));
    expect(await screen.findByTestId('delete-error')).toBeTruthy();
    expect(world.deletionRequests).toHaveLength(0);
    await fireEvent.changeText(screen.getByTestId('delete-code'), FAKE_SMS_CODE);
    await fireEvent.press(screen.getByTestId('delete-verify-button'));
    expect(await screen.findByTestId('delete-confirm')).toBeTruthy();
    expect(world.deletionRequests).toHaveLength(0); // nothing happens before the last step
    await fireEvent.press(screen.getByTestId('delete-now'));
    expect(await screen.findByTestId('delete-done')).toBeTruthy();
    expect(world.deletionRequests.map((r) => r.userId)).toEqual([ids.user]);
    await fireEvent.press(screen.getByTestId('delete-finish'));
    await waitFor(() => expect(backend.gateway.session).toBeNull());
    await waitFor(() => expect(app.getPathname()).not.toContain('/account/delete'));
  });

  it('a staff member also enters the authenticator code; a stale sign-in starts over', async () => {
    const world = new FakeWorld(
      access({ email_verified: true, phone_verified: false }),
      'pm@example.test',
    );
    const { api } = signIn(world, 'pm@example.test', { staff: true });
    await chooseLanguage('en-US');
    await renderRouter('./app', { initialUrl: '/account/delete' });
    await fireEvent(await screen.findByTestId('delete-understand'), 'valueChange', true);
    await fireEvent.press(screen.getByTestId('delete-continue'));
    expect(await screen.findByText('We sent a 6-digit code to your e-mail address.')).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId('delete-code'), FAKE_EMAIL_CODE);
    await fireEvent.press(screen.getByTestId('delete-verify-button'));
    expect(await screen.findByTestId('delete-mfa')).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId('delete-mfa-code'), FAKE_TOTP_CODE);
    await fireEvent.press(screen.getByTestId('delete-mfa-button'));
    expect(await screen.findByTestId('delete-confirm')).toBeTruthy();
    api.signInIsStale = true;
    await fireEvent.press(screen.getByTestId('delete-now'));
    expect(await screen.findByText('For your security, confirm it is you again.')).toBeTruthy();
    expect(screen.getByTestId('delete-understand')).toBeTruthy();
    expect(world.deletionRequests).toHaveLength(0);
  });

  it('signing in again while the deletion is processed shows only that, in Spanish too', async () => {
    const world = new FakeWorld(access({ account_deletion_pending: true }), '+15555550123');
    const { backend } = signIn(world, '+15555550123');
    await chooseLanguage('es-US');
    await renderRouter('./app', { initialUrl: '/' });
    expect(await screen.findByTestId('deletion-pending-screen')).toBeTruthy();
    expect(screen.getByText('Su cuenta se está eliminando')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('sign-out'));
    await waitFor(() => expect(backend.gateway.session).toBeNull());
  });

  it('speaks Spanish', async () => {
    signIn(workerWorld(), '+15555550123');
    await chooseLanguage('es-US');
    await renderRouter('./app', { initialUrl: '/worker/profile' });
    await act(() => router.push('/account/delete'));
    expect(await screen.findByText('Eliminar mi cuenta')).toBeTruthy();
    expect(screen.getByText('Entiendo que eliminar mi cuenta no se puede deshacer')).toBeTruthy();
    expect(await screen.findByText('Eliminar su cuenta de SiteMuster (borrador).')).toBeTruthy();
  });
});
