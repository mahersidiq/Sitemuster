import { describe, expect, it, jest } from '@jest/globals';
import * as SecureStore from 'expo-secure-store';
import { fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';

import { FakeSiteMusterApi, FakeWorld } from '../support/fake-api';
import { access, fakeBackend, ids } from '../support/fake-auth';

/**
 * Screen flows for the Milestone 13 reviewer demo on the real `app/` routes. The labels and the
 * simulation screen appear only for a project the server lists as a demo; the server rules (the
 * allowlist, synthetic people only, MFA) are tested in pgTAP 032, the demo-simulate core tests and
 * tests/backend/demo.test.ts.
 */
type Globals = typeof globalThis & { __fakeAuthBackend?: unknown };

jest.mock('../../src/auth/create-gateway', () => ({
  createAuthBackend: () => (globalThis as Globals).__fakeAuthBackend ?? null,
}));

const STAFF_USER = '99999999-9999-4999-8999-999999999999';
const PERSON_A = 'dd000000-0000-4000-8000-0000000000a1';
const PERSON_B = 'dd000000-0000-4000-8000-0000000000b1';

function signIn(world: FakeWorld, options: { staff?: boolean } = { staff: true }) {
  const api = new FakeSiteMusterApi(world);
  const backend = fakeBackend(() => world.access, api);
  backend.gateway.session = { destination: world.email };
  backend.gateway.aal = options.staff ? 'aal2' : 'aal1';
  backend.gateway.factors = options.staff ? ['factor-1'] : [];
  (globalThis as Globals).__fakeAuthBackend = backend;
  return api;
}

async function chooseLanguage(locale: 'en-US' | 'es-US') {
  await SecureStore.setItemAsync('sitemuster.locale.v1', locale);
}

/** An ACTIVE project seen by a superintendent; listed as a demo by the server when `demo`. */
async function site(demo: boolean) {
  const owner = new FakeWorld(
    access({ email_verified: true, phone_verified: false }),
    'owner@example.test',
  );
  const orgId = owner.addOrganization('SiteMuster Demo (synthetic data)');
  const ownerApi = new FakeSiteMusterApi(owner);
  const projectId = await ownerApi.seedProject(orgId);
  await ownerApi.setStatus(projectId, 'ACTIVE', null);
  const world = new FakeWorld(
    access({
      user_id: STAFF_USER,
      email_verified: true,
      phone_verified: false,
      project_roles: [{ project_id: projectId, role: 'SUPER' }],
    }),
    'reviewer@example.test',
    owner,
  );
  owner.projects
    .find((p) => p.id === projectId)
    ?.staff.push({
      id: 'staff-1',
      userId: STAFF_USER,
      email: 'reviewer@example.test',
      role: 'SUPER',
      emergency: false,
    });
  if (demo) {
    world.demoProjects.push({ project_id: projectId, organization_id: orgId, active: true });
    world.demoWorkers.set(projectId, [
      {
        worker_id: PERSON_A,
        name: 'Demo Worker A',
        company_name: 'Demo Concrete Co. (synthetic)',
        presence: null,
        last_seen_at: null,
      },
      {
        worker_id: PERSON_B,
        name: 'Demo Worker B',
        company_name: 'Demo Electric LLC (synthetic)',
        presence: 'ONSITE_ESTIMATED',
        last_seen_at: '2026-11-04T14:50:00Z',
      },
    ]);
  }
  return { world, projectId };
}

describe('reviewer demo', () => {
  it('labels a demo project everywhere and simulates an arrival and a departure', async () => {
    const { world, projectId } = await site(true);
    signIn(world);
    await chooseLanguage('en-US');
    await renderRouter('./app', { initialUrl: `/project/${projectId}` });
    expect(await screen.findByTestId('demo-banner')).toBeTruthy();
    expect(
      screen.getByText(
        'DEMO: the people here are synthetic and their locations are simulated. This is not real GPS and not a real site.',
      ),
    ).toBeTruthy();
    await fireEvent.press(await screen.findByTestId('open-demo'));
    expect(screen).toHavePathname(`/project/${projectId}/demo`);

    expect(await screen.findByTestId(`demo-worker-${PERSON_A}`)).toBeTruthy();
    expect(screen.getByTestId(`demo-presence-${PERSON_A}`).props.children).toBe('Not seen yet');
    expect(screen.getByTestId(`demo-presence-${PERSON_B}`).props.children).toBe(
      'On site (estimated)',
    );
    // Only the action that makes sense is offered.
    expect(screen.getByTestId(`demo-leave-${PERSON_A}`).props.accessibilityState).toMatchObject({
      disabled: true,
    });
    expect(screen.getByTestId(`demo-arrive-${PERSON_B}`).props.accessibilityState).toMatchObject({
      disabled: true,
    });

    await fireEvent.press(screen.getByTestId(`demo-arrive-${PERSON_A}`));
    expect(
      await screen.findByText('Demo Worker A arrived (simulated). Counted on site as an estimate.'),
    ).toBeTruthy();
    expect(world.demoSimulations).toEqual([
      expect.objectContaining({ project_id: projectId, worker_id: PERSON_A, action: 'ARRIVE' }),
    ]);
    await waitFor(() =>
      expect(screen.getByTestId(`demo-presence-${PERSON_A}`).props.children).toBe(
        'On site (estimated)',
      ),
    );

    await fireEvent.press(screen.getByTestId(`demo-leave-${PERSON_B}`));
    expect(await screen.findByText('Demo Worker B left (simulated).')).toBeTruthy();
    expect(world.demoSimulations[1]).toMatchObject({ worker_id: PERSON_B, action: 'LEAVE' });
    // The client never sends a time, a place or a phone: the server builds every record.
    for (const request of world.demoSimulations) {
      expect(Object.keys(request).sort()).toEqual(
        ['action', 'idempotency_key', 'project_id', 'schema_version', 'worker_id'].sort(),
      );
    }
  });

  it('shows the server refusal in plain words (the 10-minute rule)', async () => {
    const { world, projectId } = await site(true);
    const api = signIn(world);
    await chooseLanguage('en-US');
    await renderRouter('./app', { initialUrl: `/project/${projectId}/demo` });
    await screen.findByTestId(`demo-worker-${PERSON_A}`);
    api.failNext('DEMO_WAIT');
    await fireEvent.press(screen.getByTestId(`demo-arrive-${PERSON_A}`));
    expect(
      await screen.findByText(
        'The 10-minute arrival rule applies here too. Wait about 10 minutes after the last change for this person, then try again.',
      ),
    ).toBeTruthy();
  });

  it('a real project has no demo label and no simulation entry', async () => {
    const { world, projectId } = await site(false);
    signIn(world);
    await chooseLanguage('en-US');
    await renderRouter('./app', { initialUrl: `/project/${projectId}` });
    expect(await screen.findByTestId('project-detail-screen')).toBeTruthy();
    await screen.findByTestId('workforce-card');
    await waitFor(() => expect(world.calls).toContain('demoProjects'));
    expect(screen.queryByTestId('demo-banner')).toBeNull();
    expect(screen.queryByTestId('open-demo')).toBeNull();
  });

  it('opening the simulation screen of a real project refuses without asking the server to simulate', async () => {
    const { world, projectId } = await site(false);
    signIn(world);
    await chooseLanguage('en-US');
    await renderRouter('./app', { initialUrl: `/project/${projectId}/demo` });
    expect(await screen.findByTestId('demo-not-demo')).toBeTruthy();
    expect(world.calls).not.toContain('demoWorkers');
    expect(world.calls).not.toContain('demoSimulate');
  });

  it('labels the demo in Spanish', async () => {
    const { world, projectId } = await site(true);
    signIn(world);
    await chooseLanguage('es-US');
    await renderRouter('./app', { initialUrl: `/project/${projectId}/demo` });
    expect(
      await screen.findByText(
        'DEMOSTRACIÓN: las personas son ficticias y sus ubicaciones están simuladas. No es GPS real ni una obra real.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('Simular llegadas (demostración)')).toBeTruthy();
    expect(await screen.findByTestId(`demo-arrive-${PERSON_A}`)).toBeTruthy();
    expect(screen.getAllByText('Simular llegada').length).toBeGreaterThan(0);
  });

  it('tells a demo worker account that the other people are synthetic', async () => {
    const worker = new FakeWorld(access({ worker_profile_id: ids.worker }), '+15555550123');
    worker.demoProjects.push({
      project_id: 'dd000000-0000-4000-8000-0000000000f1',
      organization_id: 'dd000000-0000-4000-8000-0000000000f2',
      active: true,
    });
    signIn(worker, { staff: false });
    await chooseLanguage('es-US');
    await renderRouter('./app', { initialUrl: '/worker/home' });
    expect(
      await screen.findByText(
        'Esta es una cuenta de demostración de SiteMuster. Las demás personas y la obra son ficticias.',
      ),
    ).toBeTruthy();
  });
});
