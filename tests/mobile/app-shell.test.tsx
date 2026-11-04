import { describe, expect, it } from '@jest/globals';
import * as SecureStore from 'expo-secure-store';
import { fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';

/**
 * Router-level integration: renders the real `app/` directory with the real providers, i18n
 * resources and guards. Only native modules are replaced (tests/setup/jest.setup.ts).
 */

type TestGlobals = typeof globalThis & { __deviceLocale?: string; __appEnv?: string };

describe('EN/ES role shell (Milestone 01)', () => {
  it('asks for a language on first launch, then shows sign-in in the chosen language', async () => {
    (globalThis as TestGlobals).__deviceLocale = 'es-MX';
    const app = await renderRouter('./app', { initialUrl: '/' });

    expect(await screen.findByTestId('language-screen')).toBeTruthy();
    // The device suggestion renders the chooser in Spanish but does NOT skip the explicit choice.
    expect(screen.getByText('Elija su idioma')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('choose-es-US'));

    expect(await screen.findByTestId('sign-in-screen')).toBeTruthy();
    expect(app.getPathname()).toBe('/sign-in');
    expect(screen.getByText('Iniciar sesión')).toBeTruthy();
    expect(await SecureStore.getItemAsync('sitemuster.locale.v1')).toBe('es-US');
  });

  it('keeps sign-in disabled when no backend is configured (no fake success)', async () => {
    await SecureStore.setItemAsync('sitemuster.locale.v1', 'en-US');
    await renderRouter('./app', { initialUrl: '/sign-in' });
    expect(await screen.findByTestId('sign-in-screen')).toBeTruthy();
    expect(screen.getByTestId('worker-sign-in').props.accessibilityState).toEqual({
      disabled: true,
    });
    expect(screen.getByTestId('staff-sign-in').props.accessibilityState).toEqual({
      disabled: true,
    });
    expect(screen.getByTestId('backend-unavailable')).toBeTruthy();
  });

  it('shows the worker tabs in Spanish through the development preview', async () => {
    await SecureStore.setItemAsync('sitemuster.locale.v1', 'es-US');
    const app = await renderRouter('./app', { initialUrl: '/sign-in' });
    await fireEvent.press(await screen.findByTestId('preview-worker'));

    expect(await screen.findByTestId('worker-home')).toBeTruthy();
    expect(app.getPathname()).toBe('/worker/home');
    for (const label of ['Inicio', 'Mis proyectos', 'Historial de horas', 'Perfil']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    expect(screen.getByTestId('preview-banner')).toBeTruthy();
  });

  it('shows the staff tabs in English through the development preview', async () => {
    await SecureStore.setItemAsync('sitemuster.locale.v1', 'en-US');
    const app = await renderRouter('./app', { initialUrl: '/sign-in' });
    await fireEvent.press(await screen.findByTestId('preview-staff'));

    expect(await screen.findByTestId('staff-home')).toBeTruthy();
    expect(app.getPathname()).toBe('/staff/home');
    for (const label of ['Home', 'Projects', 'Workforce', 'Map', 'More']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
  });

  it('switches language from the staff More tab and re-renders the tabs', async () => {
    await SecureStore.setItemAsync('sitemuster.locale.v1', 'en-US');
    await renderRouter('./app', { initialUrl: '/sign-in' });
    await fireEvent.press(await screen.findByTestId('preview-staff'));
    await fireEvent.press(await screen.findByText('More'));
    await fireEvent.press(await screen.findByTestId('language-switch-es-US'));
    await waitFor(() => expect(screen.getAllByText('Más').length).toBeGreaterThan(0));
    expect(await SecureStore.getItemAsync('sitemuster.locale.v1')).toBe('es-US');
  });

  it('redirects a deep link into a role shell to sign-in when there is no session', async () => {
    await SecureStore.setItemAsync('sitemuster.locale.v1', 'en-US');
    const app = await renderRouter('./app', { initialUrl: '/staff/workforce' });
    expect(await screen.findByTestId('sign-in-screen')).toBeTruthy();
    expect(app.getPathname()).toBe('/sign-in');
  });

  it('never offers the role preview outside development builds', async () => {
    (globalThis as TestGlobals).__appEnv = 'staging';
    process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://example-staging.supabase.co';
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'public-anon-key';
    try {
      await SecureStore.setItemAsync('sitemuster.locale.v1', 'en-US');
      await renderRouter('./app', { initialUrl: '/sign-in' });
      expect(await screen.findByTestId('sign-in-screen')).toBeTruthy();
      expect(screen.queryByTestId('dev-preview')).toBeNull();
    } finally {
      delete process.env.EXPO_PUBLIC_SUPABASE_URL;
      delete process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
    }
  });

  it('fails closed with a blocking screen when a production build lacks configuration', async () => {
    (globalThis as TestGlobals).__appEnv = 'production';
    (globalThis as TestGlobals).__deviceLocale = 'es-US';
    await renderRouter('./app', { initialUrl: '/' });
    expect(await screen.findByTestId('configuration-error')).toBeTruthy();
    expect(screen.getByText('SiteMuster no puede iniciar')).toBeTruthy();
    expect(screen.queryByTestId('sign-in-screen')).toBeNull();
  });
});
