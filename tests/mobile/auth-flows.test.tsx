import { describe, expect, it, jest } from '@jest/globals';
import * as SecureStore from 'expo-secure-store';
import { fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';

import {
  access,
  FAKE_EMAIL_CODE,
  FAKE_SMS_CODE,
  FAKE_TOTP_CODE,
  fakeBackend,
  ids,
} from '../support/fake-auth';

/**
 * Screen-flow integration for Milestone 03: real `app/` routes, real providers and i18n, with a
 * typed auth-backend double (tests/support/fake-auth.ts). Server-side behaviour (Supabase Auth,
 * SMS hook, TOTP) is proven end-to-end in tests/backend.
 */
type Globals = typeof globalThis & { __fakeAuthBackend?: unknown };

jest.mock('../../src/auth/create-gateway', () => ({
  createAuthBackend: () => (globalThis as Globals).__fakeAuthBackend ?? null,
}));

function useBackend(backend: ReturnType<typeof fakeBackend>) {
  (globalThis as Globals).__fakeAuthBackend = backend;
  return backend;
}

async function chooseLanguage(locale: 'en-US' | 'es-US') {
  await SecureStore.setItemAsync('sitemuster.locale.v1', locale);
}

describe('worker SMS sign-in flow', () => {
  it('validates the number, rejects a wrong code and signs in (Spanish)', async () => {
    const backend = useBackend(fakeBackend(() => access({})));
    await chooseLanguage('es-US');
    const app = await renderRouter('./app', { initialUrl: '/sign-in' });

    await fireEvent.press(await screen.findByTestId('worker-sign-in'));
    expect(await screen.findByTestId('phone-screen')).toBeTruthy();

    await fireEvent.changeText(screen.getByTestId('phone-input'), '123');
    await fireEvent.press(screen.getByTestId('send-code'));
    expect(
      await screen.findByText('Escriba un número de celular válido, por ejemplo (555) 555-0123.'),
    ).toBeTruthy();

    await fireEvent.changeText(screen.getByTestId('phone-input'), '(555) 555-0123');
    await fireEvent.press(screen.getByTestId('send-code'));
    expect(await screen.findByTestId('phone-code-screen')).toBeTruthy();
    expect(
      screen.getByText('Enviamos un código a +1 ••• ••• 0123. Vence en 10 minutos.'),
    ).toBeTruthy();
    expect(screen.getByText(/Podrá pedir un código nuevo en \d+ s/)).toBeTruthy();

    await fireEvent.changeText(screen.getByTestId('code-input'), '000000');
    await fireEvent.press(screen.getByTestId('verify-code'));
    expect(
      await screen.findByText('Ese código no es correcto. Revise el mensaje e intente de nuevo.'),
    ).toBeTruthy();

    await fireEvent.changeText(screen.getByTestId('code-input'), FAKE_SMS_CODE);
    await fireEvent.press(screen.getByTestId('verify-code'));
    expect(await screen.findByTestId('join-screen')).toBeTruthy();
    expect(app.getPathname()).toBe('/join');
    await waitFor(() => expect(backend.gateway.savedLanguages).toContain('es-US'));
  });

  it('opens the worker tabs when the worker already has a profile', async () => {
    useBackend(fakeBackend(() => access({ worker_profile_id: ids.worker })));
    await chooseLanguage('en-US');
    await renderRouter('./app', { initialUrl: '/auth/phone' });
    await fireEvent.changeText(await screen.findByTestId('phone-input'), '555 555 0199');
    await fireEvent.press(screen.getByTestId('send-code'));
    await fireEvent.changeText(await screen.findByTestId('code-input'), FAKE_SMS_CODE);
    await fireEvent.press(screen.getByTestId('verify-code'));
    expect(await screen.findByTestId('worker-home')).toBeTruthy();
  });

  it('points to the kiosk/foreman fallback when SMS is unavailable', async () => {
    const backend = useBackend(fakeBackend(() => access({})));
    backend.gateway.smsDown = true;
    await chooseLanguage('en-US');
    await renderRouter('./app', { initialUrl: '/auth/phone' });
    await fireEvent.changeText(await screen.findByTestId('phone-input'), '(555) 555-0123');
    await fireEvent.press(screen.getByTestId('send-code'));
    expect(
      await screen.findByText(
        'Text messages are not available right now. Ask your foreman or the kiosk attendant to check you in.',
      ),
    ).toBeTruthy();
  });
});

describe('staff email + TOTP flow', () => {
  const staffAccess = access({
    email_verified: true,
    phone_verified: false,
    project_roles: [{ project_id: ids.project, role: 'SUPER' }],
  });

  it('requires authenticator enrollment before the staff shell opens', async () => {
    useBackend(fakeBackend(() => staffAccess));
    await chooseLanguage('en-US');
    const app = await renderRouter('./app', { initialUrl: '/sign-in' });

    await fireEvent.press(await screen.findByTestId('staff-sign-in'));
    await fireEvent.changeText(await screen.findByTestId('email-input'), 'Super@GC.example');
    await fireEvent.press(screen.getByTestId('send-email-code'));
    expect(
      await screen.findByText('We sent a code to su•••@gc.example. It expires in 10 minutes.'),
    ).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId('email-code-input'), FAKE_EMAIL_CODE);
    await fireEvent.press(screen.getByTestId('verify-email-code'));

    expect(await screen.findByTestId('mfa-enroll-screen')).toBeTruthy();
    expect(await screen.findByTestId('mfa-secret')).toBeTruthy();
    expect(screen.getByText('JBSW Y3DP EHPK 3PXP')).toBeTruthy();

    await fireEvent.changeText(screen.getByTestId('mfa-code-input'), '111111');
    await fireEvent.press(screen.getByTestId('mfa-confirm'));
    expect(
      await screen.findByText(
        'That authenticator code did not work. Use the current 6-digit code.',
      ),
    ).toBeTruthy();

    await fireEvent.changeText(screen.getByTestId('mfa-code-input'), FAKE_TOTP_CODE);
    await fireEvent.press(screen.getByTestId('mfa-confirm'));
    expect(await screen.findByTestId('staff-home')).toBeTruthy();
    expect(app.getPathname()).toBe('/staff/home');
  });

  it('blocks a deep link into the staff shell until the TOTP challenge passes', async () => {
    const backend = useBackend(fakeBackend(() => staffAccess));
    backend.gateway.session = { destination: 'super@gc.example' };
    backend.gateway.factors = ['factor-1'];
    backend.gateway.aal = 'aal1';
    await chooseLanguage('en-US');
    const app = await renderRouter('./app', { initialUrl: '/staff/workforce' });

    expect(await screen.findByTestId('mfa-verify-screen')).toBeTruthy();
    expect(app.getPathname()).toBe('/auth/mfa-verify');
    await fireEvent.changeText(screen.getByTestId('mfa-verify-input'), FAKE_TOTP_CODE);
    await fireEvent.press(screen.getByTestId('mfa-verify-confirm'));
    expect(await screen.findByTestId('staff-home')).toBeTruthy();
  });
});

describe('session restoration and offline behaviour', () => {
  it('restores an existing session on restart without asking to sign in again', async () => {
    const backend = useBackend(fakeBackend(() => access({ worker_profile_id: ids.worker })));
    backend.gateway.session = { destination: '+15555550123' };
    await chooseLanguage('en-US');
    const app = await renderRouter('./app', { initialUrl: '/' });
    expect(await screen.findByTestId('worker-home')).toBeTruthy();
    expect(app.getPathname()).toBe('/worker/home');
  });

  it('uses the encrypted cached access offline and labels it stale', async () => {
    const backend = useBackend(fakeBackend(() => access({ worker_profile_id: ids.worker })));
    backend.gateway.session = { destination: '+15555550123' };
    await backend.storage.setItem(
      'sitemuster-access-cache',
      JSON.stringify(access({ worker_profile_id: ids.worker })),
    );
    backend.gateway.offline = true;
    await chooseLanguage('en-US');
    await renderRouter('./app', { initialUrl: '/' });
    expect(await screen.findByTestId('worker-home')).toBeTruthy();
    await fireEvent.press(screen.getAllByText('Profile')[0]!);
    expect(await screen.findByTestId('stale-access')).toBeTruthy();
  });

  it('shows the offline screen when access cannot be confirmed and nothing is cached', async () => {
    const backend = useBackend(fakeBackend(() => access({ worker_profile_id: ids.worker })));
    backend.gateway.session = { destination: '+15555550123' };
    backend.gateway.offline = true;
    await chooseLanguage('es-US');
    await renderRouter('./app', { initialUrl: '/' });
    expect(await screen.findByTestId('offline-screen')).toBeTruthy();
    expect(screen.getByText('Está sin conexión')).toBeTruthy();
  });

  it('signs out from the profile and wipes the encrypted session store', async () => {
    const backend = useBackend(fakeBackend(() => access({ worker_profile_id: ids.worker })));
    backend.gateway.session = { destination: '+15555550123' };
    await backend.storage.setItem('sitemuster-auth', '{"session":"x"}');
    await chooseLanguage('en-US');
    const app = await renderRouter('./app', { initialUrl: '/' });
    await screen.findByTestId('worker-home');
    await fireEvent.press(screen.getAllByText('Profile')[0]!);
    await fireEvent.press(await screen.findByTestId('sign-out'));
    expect(await screen.findByTestId('sign-in-screen')).toBeTruthy();
    expect(app.getPathname()).toBe('/sign-in');
    expect(await backend.storage.getItem('sitemuster-auth')).toBeNull();
  });

  it('refuses platform operator accounts in the mobile app', async () => {
    const backend = useBackend(
      fakeBackend(() =>
        access({ email_verified: true, phone_verified: false, is_platform_operator: true }),
      ),
    );
    backend.gateway.session = { destination: 'operator@example.test' };
    backend.gateway.aal = 'aal2';
    backend.gateway.factors = ['factor-1'];
    await chooseLanguage('en-US');
    await renderRouter('./app', { initialUrl: '/' });
    expect(await screen.findByTestId('operator-screen')).toBeTruthy();
  });
});
