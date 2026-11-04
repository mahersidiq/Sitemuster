import { describe, expect, it, jest } from '@jest/globals';
import { act, render, screen, waitFor } from '@testing-library/react-native';
import * as SecureStore from 'expo-secure-store';
import { fireEvent, renderRouter } from 'expo-router/testing-library';
import { useEffect } from 'react';
import { AppState, Text } from 'react-native';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import type { RuntimeEnv } from '../../src/config/runtime-env';
import { AuthProvider, useAuth } from '../../src/state/auth';
import { LanguageProvider } from '../../src/state/language';
import { SessionProvider } from '../../src/state/session';
import { FakeSiteMusterApi, FakeWorld } from '../support/fake-api';
import { access, fakeBackend, ids } from '../support/fake-auth';

/**
 * Regression tests for the automated-review findings on merged PRs #3 and #4 (decision #76):
 * an access check finishing after sign-out cannot resurrect the session, a cached access summary
 * is only reused for the same user, coming back to the foreground refreshes stale access, and
 * revoked project access stops showing previously loaded project details.
 */
type Globals = typeof globalThis & { __fakeAuthBackend?: unknown };

jest.mock('../../src/auth/create-gateway', () => ({
  createAuthBackend: () => (globalThis as Globals).__fakeAuthBackend ?? null,
}));

const ENV: RuntimeEnv = {
  appEnv: 'development',
  supabaseUrl: 'http://127.0.0.1:54321',
  supabaseAnonKey: 'anon',
  sentryDsn: null,
};
const USER_A = ids.user;
const USER_B = '99999999-9999-4999-8999-999999999999';
const CACHE_KEY = 'sitemuster-access-cache';

const authRef: { current: ReturnType<typeof useAuth> | null } = { current: null };
function Probe() {
  const value = useAuth();
  useEffect(() => {
    authRef.current = value;
  });
  const { state } = value;
  return (
    <Text testID="auth-status">
      {state.status === 'signed_in'
        ? `signed_in:${state.access.user_id}:${state.accessIsStale ? 'stale' : 'fresh'}`
        : state.status}
    </Text>
  );
}

function workerBackend() {
  const backend = fakeBackend((destination) =>
    access({
      user_id: destination === 'B' ? USER_B : USER_A,
      worker_profile_id: ids.worker,
    }),
  );
  (globalThis as Globals).__fakeAuthBackend = backend;
  return backend;
}

async function renderProbe() {
  await SecureStore.setItemAsync('sitemuster.locale.v1', 'en-US');
  // Same providers as the app, without the native safe-area container (no layout in Jest).
  await render(
    <QueryClientProvider client={new QueryClient()}>
      <LanguageProvider appEnv="development">
        <SessionProvider env={ENV}>
          <AuthProvider env={ENV}>
            <Probe />
          </AuthProvider>
        </SessionProvider>
      </LanguageProvider>
    </QueryClientProvider>,
  );
}

const status = () => String(screen.getByTestId('auth-status').props.children);

describe('access refresh hardening', () => {
  it('does not resurrect a session when an access check finishes after sign-out', async () => {
    const backend = workerBackend();
    backend.gateway.session = { destination: 'A' };
    const release = backend.gateway.holdNextFetch();
    await renderProbe();
    await screen.findByTestId('auth-status');
    expect(status()).toBe('loading');
    await act(async () => {
      await authRef.current?.signOut();
    });
    expect(status()).toBe('signed_out');
    await act(async () => {
      release();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(status()).toBe('signed_out');
    expect(await backend.storage.getItem(CACHE_KEY)).toBeNull();
  });

  it('never reuses another person’s cached access while offline', async () => {
    const backend = workerBackend();
    backend.gateway.session = { destination: 'A' };
    await renderProbe();
    await waitFor(() => expect(status()).toBe(`signed_in:${USER_A}:fresh`));
    // Person A's session ends without the sign-out button; person B signs in with no signal.
    backend.gateway.session = { destination: 'B' };
    backend.gateway.offline = true;
    await act(async () => {
      await authRef.current?.refresh();
    });
    expect(status()).toBe('offline');
  });

  it('refreshes stale access when the app returns to the foreground', async () => {
    const handlers: ((state: string) => void)[] = [];
    const spy = jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, handler) => {
      handlers.push(handler as (state: string) => void);
      return { remove: () => undefined } as ReturnType<typeof AppState.addEventListener>;
    });
    const backend = workerBackend();
    backend.gateway.session = { destination: 'A' };
    await renderProbe();
    await waitFor(() => expect(status()).toBe(`signed_in:${USER_A}:fresh`));
    backend.gateway.offline = true;
    await act(async () => {
      await authRef.current?.refresh();
    });
    expect(status()).toBe(`signed_in:${USER_A}:stale`);
    backend.gateway.offline = false;
    await act(async () => {
      for (const handler of handlers) handler('active');
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(status()).toBe(`signed_in:${USER_A}:fresh`);
    spy.mockRestore();
  });
});

describe('revoked project access', () => {
  it('stops showing previously loaded project details after the server refuses access', async () => {
    const world = new FakeWorld(
      access({ email_verified: true, phone_verified: false }),
      'owner@example.test',
    );
    const orgId = world.addOrganization('Gulf Coast Builders');
    const api = new FakeSiteMusterApi(world);
    const projectId = await api.seedProject(orgId);
    const backend = fakeBackend(() => world.access, api);
    backend.gateway.session = { destination: world.email };
    backend.gateway.aal = 'aal2';
    backend.gateway.factors = ['factor-1'];
    (globalThis as Globals).__fakeAuthBackend = backend;
    await SecureStore.setItemAsync('sitemuster.locale.v1', 'en-US');
    await renderRouter('./app', { initialUrl: `/project/${projectId}` });
    expect(await screen.findByText('Main Street Tower')).toBeTruthy();

    // Access is revoked on the server: every following load is refused.
    world.access = { ...world.access, org_roles: [], project_roles: [] };
    await fireEvent.press(screen.getByTestId('edit-settings'));
    await fireEvent.press(await screen.findByTestId('edit-cancel'));
    await waitFor(() => expect(screen.queryByText('Main Street Tower')).toBeNull(), {
      timeout: 3000,
    });
  });
});
