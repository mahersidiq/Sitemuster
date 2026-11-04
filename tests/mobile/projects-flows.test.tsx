import { describe, expect, it, jest } from '@jest/globals';
import * as SecureStore from 'expo-secure-store';
import { fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';

import { FakeSiteMusterApi, FakeWorld } from '../support/fake-api';
import { access, fakeBackend, ids } from '../support/fake-auth';

/**
 * Screen flows for Milestone 04 (organizations, projects, site circles, schedules, versions,
 * lifecycle, invitations) on the real `app/` routes with a typed API double. The same rules are
 * enforced by Postgres and proven in supabase/tests/database/020_projects_config.test.sql.
 */
type Globals = typeof globalThis & { __fakeAuthBackend?: unknown };

jest.mock('../../src/auth/create-gateway', () => ({
  createAuthBackend: () => (globalThis as Globals).__fakeAuthBackend ?? null,
}));

const OTHER_USER = '55555555-5555-4555-8555-555555555555';

/** Signs a verified staff member in at aal2 (MFA done) against the given world. */
function signIn(world: FakeWorld) {
  const api = new FakeSiteMusterApi(world);
  const backend = fakeBackend(() => world.access, api);
  backend.gateway.session = { destination: world.email };
  backend.gateway.aal = 'aal2';
  backend.gateway.factors = ['factor-1'];
  (globalThis as Globals).__fakeAuthBackend = backend;
  return api;
}

function ownerWorld(withOrganization = true) {
  const world = new FakeWorld(
    access({ email_verified: true, phone_verified: false }),
    'owner@example.test',
  );
  const orgId = withOrganization ? world.addOrganization('Gulf Coast Builders') : null;
  return { world, orgId, api: signIn(world) };
}

async function chooseLanguage(locale: 'en-US' | 'es-US') {
  await SecureStore.setItemAsync('sitemuster.locale.v1', locale);
}

describe('organization creation', () => {
  it('creates the organization from the no-organization screen and opens Projects', async () => {
    const { world } = ownerWorld(false);
    await chooseLanguage('en-US');
    const app = await renderRouter('./app', { initialUrl: '/' });
    expect(await screen.findByTestId('no-org-screen')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('create-organization'));
    expect(await screen.findByTestId('org-new-screen')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('org-create'));
    expect(await screen.findByText('Enter your company name.')).toBeTruthy();

    await fireEvent.changeText(screen.getByTestId('org-name'), 'Gulf Coast Builders');
    await fireEvent.press(screen.getByTestId('org-create'));
    expect(await screen.findByTestId('new-project')).toBeTruthy();
    expect(app.getPathname()).toBe('/staff/projects');
    expect(
      await screen.findByText('No projects yet. Tap New project to set up your first jobsite.'),
    ).toBeTruthy();
    expect(world.orgs.map((o) => o.name)).toEqual(['Gulf Coast Builders']);
    expect(world.access.org_roles).toEqual([{ organization_id: world.orgs[0]?.id, role: 'OWNER' }]);
  });
});

describe('new project wizard', () => {
  it('creates a project with a site circle, an overnight shift and no duplicate on retry', async () => {
    const { world, orgId, api } = ownerWorld();
    await api.seedProject(orgId ?? '');
    await chooseLanguage('en-US');
    await renderRouter('./app', { initialUrl: '/project/new' });
    expect(await screen.findByTestId('project-new-screen')).toBeTruthy();
    expect(screen.getByText('Step 1 of 4')).toBeTruthy();

    // Step 1 — name (required).
    await fireEvent.press(screen.getByTestId('wizard-next'));
    expect(await screen.findByText('Enter a project name.')).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId('project-name'), 'Main Street Tower Phase 2');
    await fireEvent.changeText(screen.getByTestId('project-number'), 'MST-2');
    await fireEvent.press(screen.getByTestId('wizard-next'));

    // Step 2 — address through the (development) address adapter, map circle and radius.
    expect(await screen.findByText('Site and circle')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('wizard-next'));
    expect(await screen.findByText('Search for the site address and pick a result.')).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId('address-query'), '100 Main St');
    await fireEvent.press(await screen.findByTestId('address-candidate-0', {}, { timeout: 3000 }));
    expect(await screen.findByTestId('selected-address')).toBeTruthy();
    expect(screen.getByTestId('dev-address-provider')).toBeTruthy();
    expect(screen.getByTestId('map-circle-150')).toBeTruthy();
    expect(screen.getByTestId('map-circle-200')).toBeTruthy();
    expect(screen.getByTestId('radius-decrease').props.accessibilityState).toMatchObject({
      disabled: true,
    });
    await fireEvent.press(screen.getByTestId('radius-increase'));
    expect(screen.getByText('175 m (574 ft)')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('radius-preset-250'));
    expect(screen.getByText('250 m (820 ft)')).toBeTruthy();
    expect(screen.getByTestId('map-circle-300')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('wizard-next'));

    // Step 3 — explicit site time zone and shifts (one overnight).
    expect(await screen.findByText('Site time zone')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('wizard-next'));
    expect(await screen.findByText("Choose the site's time zone.")).toBeTruthy();
    await fireEvent.press(screen.getByTestId('timezone-America/Chicago'));
    await fireEvent.press(screen.getByTestId('add-shift'));
    expect(screen.getByTestId('shift-1-summary').props.children).toMatch(/the next day/);
    await fireEvent.changeText(screen.getByTestId('shift-1-start'), '25:00');
    await fireEvent.press(screen.getByTestId('wizard-next'));
    expect(
      await screen.findByText(
        'Enter times as HH:MM in 24-hour format, for example 06:00 or 18:30.',
      ),
    ).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId('shift-1-start'), '20:00');
    await fireEvent.press(screen.getByTestId('wizard-next'));

    // Step 4 — review with advisory warnings (never blocking).
    expect(await screen.findByText('Review and create')).toBeTruthy();
    expect(await screen.findByTestId('overlap-warning')).toBeTruthy();
    expect(screen.getByTestId('similar-name-warning')).toBeTruthy();
    expect(screen.getByText('Mon, Tue, Wed, Thu, Fri: 8:00 PM – 4:00 AM (next day)')).toBeTruthy();

    // The server commits but the response is lost; retrying returns the same project.
    api.failNext('NETWORK', true);
    await fireEvent.press(screen.getByTestId('wizard-create'));
    expect(
      await screen.findByText("Couldn't reach SiteMuster. Check your connection and try again."),
    ).toBeTruthy();
    expect(screen.getByTestId('retry-safe')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('wizard-create'));
    expect(await screen.findByTestId('project-created')).toBeTruthy();

    const created = world.projects.filter((p) => p.name === 'Main Street Tower Phase 2');
    expect(created).toHaveLength(1);
    const [project] = created;
    expect(project?.status).toBe('DRAFT');
    expect(project?.timeZone).toBe('America/Chicago');
    expect(project?.versions).toHaveLength(1);
    expect(project?.versions[0]?.radiusM).toBe(250);
    expect(project?.versions[0]?.windows).toContainEqual({
      weekday: 1,
      local_start_time: '20:00',
      local_end_time: '04:00',
      crosses_midnight: true,
    });
    expect(screen.getByTestId('project-status')).toBeTruthy();
    expect(screen.getByText('Draft')).toBeTruthy();
  });

  it('shows the wizard and provider errors in Spanish', async () => {
    const { api } = ownerWorld();
    await chooseLanguage('es-US');
    await renderRouter('./app', { initialUrl: '/project/new' });
    expect(await screen.findByText('Proyecto nuevo')).toBeTruthy();
    expect(screen.getByText('Paso 1 de 4')).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId('project-name'), 'Torre Norte');
    await fireEvent.press(screen.getByTestId('wizard-next'));
    expect(await screen.findByText('Obra y círculo')).toBeTruthy();
    api.failNext('RATE_LIMITED');
    await fireEvent.changeText(screen.getByTestId('address-query'), 'Calle Principal 100');
    expect(
      await screen.findByText(
        'Demasiadas solicitudes. Espere un minuto e intente de nuevo.',
        {},
        { timeout: 3000 },
      ),
    ).toBeTruthy();
  });
});

describe('project configuration versions', () => {
  it('saves a larger circle as version 2 only after confirming the sensitive change', async () => {
    const { world, orgId, api } = ownerWorld();
    const projectId = await api.seedProject(orgId ?? '');
    await chooseLanguage('en-US');
    await renderRouter('./app', { initialUrl: `/project/${projectId}` });
    expect(await screen.findByText('Settings version 1 · since Nov 4, 2026, 8:00 AM')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('edit-settings'));
    expect(await screen.findByTestId('project-edit-screen')).toBeTruthy();
    await fireEvent.press(await screen.findByTestId('radius-preset-250'));
    await fireEvent.press(screen.getByTestId('save-config'));
    expect(await screen.findByText('Enter a short reason (at least 3 characters).')).toBeTruthy();

    await fireEvent.changeText(screen.getByTestId('edit-reason'), 'Laydown yard added');
    await fireEvent.press(screen.getByTestId('save-config'));
    expect(await screen.findByTestId('sensitive-confirmation')).toBeTruthy();
    expect(screen.getByText('Larger site circle')).toBeTruthy();
    expect(world.projects[0]?.versions).toHaveLength(1);

    await fireEvent.press(screen.getByTestId('confirm-sensitive'));
    expect(await screen.findByTestId('version-2')).toBeTruthy();
    expect(screen.getByTestId('version-1')).toBeTruthy();
    expect(world.projects[0]?.versions.map((v) => [v.number, v.radiusM, v.reason])).toEqual([
      [1, 150, 'Project created'],
      [2, 250, 'Laydown yard added'],
    ]);
  });

  it('does not offer configuration or staffing to a PM without delegation', async () => {
    const owner = ownerWorld();
    const projectId = await owner.api.seedProject(owner.orgId ?? '');
    const pm = new FakeWorld(
      access({
        user_id: OTHER_USER,
        email_verified: true,
        phone_verified: false,
        project_roles: [{ project_id: projectId, role: 'PM' }],
      }),
      'pm@example.test',
      owner.world,
    );
    signIn(pm);
    await chooseLanguage('en-US');
    await renderRouter('./app', { initialUrl: '/staff/projects' });
    expect(await screen.findByTestId(`project-${projectId}`)).toBeTruthy();
    expect(screen.queryByTestId('new-project')).toBeNull();
    await fireEvent.press(screen.getByTestId(`project-${projectId}`));
    expect(await screen.findByTestId('site-card')).toBeTruthy();
    expect(screen.queryByTestId('edit-settings')).toBeNull();
    expect(screen.queryByTestId('lifecycle-card')).toBeNull();
    expect(screen.queryByTestId('invite-staff')).toBeNull();
  });
});

describe('project lifecycle', () => {
  it('activates a draft and requires a reason to complete it', async () => {
    const { world, orgId, api } = ownerWorld();
    const projectId = await api.seedProject(orgId ?? '');
    await chooseLanguage('en-US');
    await renderRouter('./app', { initialUrl: `/project/${projectId}` });

    await fireEvent.press(await screen.findByTestId('status-ACTIVE'));
    expect(screen.getByText('Change the status to Active?')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('confirm-status'));
    await waitFor(() => expect(world.projects[0]?.status).toBe('ACTIVE'));

    await fireEvent.press(await screen.findByTestId('status-COMPLETED'));
    await fireEvent.press(screen.getByTestId('confirm-status'));
    expect(await screen.findByText('Enter a short reason (at least 3 characters).')).toBeTruthy();
    expect(world.projects[0]?.status).toBe('ACTIVE');

    await fireEvent.changeText(screen.getByTestId('status-reason'), 'Handover done');
    await fireEvent.press(screen.getByTestId('confirm-status'));
    await waitFor(() => expect(world.projects[0]?.status).toBe('COMPLETED'));
    // Completed projects keep their records but settings can no longer change.
    await waitFor(() => expect(screen.queryByTestId('edit-settings')).toBeNull());
    expect(await screen.findByTestId('status-ARCHIVED')).toBeTruthy();
  });
});

describe('staff invitations', () => {
  it('owner invites a superintendent with the emergency role', async () => {
    const { world, orgId, api } = ownerWorld();
    const projectId = await api.seedProject(orgId ?? '');
    await chooseLanguage('en-US');
    await renderRouter('./app', { initialUrl: `/project/${projectId}/invite` });
    expect(await screen.findByTestId('invite-staff-screen')).toBeTruthy();

    await fireEvent.changeText(screen.getByTestId('invite-email'), 'not-an-email');
    await fireEvent.press(screen.getByTestId('invite-send'));
    expect(await screen.findByText('Enter a valid email address.')).toBeTruthy();

    await fireEvent.changeText(screen.getByTestId('invite-email'), 'Super@Example.test');
    await fireEvent.press(screen.getByTestId('invite-role-SUPER'));
    await fireEvent(await screen.findByTestId('invite-emergency'), 'valueChange', true);
    await fireEvent.press(screen.getByTestId('invite-send'));
    expect(await screen.findByTestId('invite-sent')).toBeTruthy();
    expect(world.invitations).toEqual([
      expect.objectContaining({
        email: 'super@example.test',
        projectRole: 'SUPER',
        emergency: true,
        projectId,
      }),
    ]);
  });

  it('invitee signs in with the invited email, accepts and gets the staff tabs', async () => {
    const owner = ownerWorld();
    const projectId = await owner.api.seedProject(owner.orgId ?? '');
    await owner.api.inviteStaff({
      projectId,
      email: 'super@example.test',
      role: 'SUPER',
      emergencyDesignated: false,
      canConfigureProject: false,
      canAssignStaff: false,
      canApproveCorrections: false,
    });
    const invitee = new FakeWorld(
      access({ user_id: OTHER_USER, email_verified: true, phone_verified: false }),
      'super@example.test',
      owner.world,
    );
    signIn(invitee);
    await chooseLanguage('en-US');
    const app = await renderRouter('./app', { initialUrl: '/' });
    expect(await screen.findByTestId('no-org-screen')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('open-invitations'));
    expect(await screen.findByText('Gulf Coast Builders · Superintendent')).toBeTruthy();
    const [invitation] = owner.world.invitations;
    await fireEvent.press(screen.getByTestId(`accept-${invitation?.id ?? ''}`));
    expect(await screen.findByTestId('staff-home')).toBeTruthy();
    expect(app.getPathname()).toBe('/staff/home');
    expect(invitee.access.project_roles).toEqual([{ project_id: projectId, role: 'SUPER' }]);
  });
});

describe('route guards', () => {
  it('sends a worker away from staff project screens', async () => {
    const world = new FakeWorld(access({ worker_profile_id: ids.worker }), 'n/a');
    const api = new FakeSiteMusterApi(world);
    const backend = fakeBackend(() => world.access, api);
    backend.gateway.session = { destination: '+15555550123' };
    (globalThis as Globals).__fakeAuthBackend = backend;
    await chooseLanguage('en-US');
    const app = await renderRouter('./app', { initialUrl: '/project/new' });
    expect(await screen.findByTestId('worker-home')).toBeTruthy();
    expect(app.getPathname()).toBe('/worker/home');
    // Only the worker's own data was requested (enrollments, own foreman crews) — no staff/project API call.
    expect(
      world.calls.filter((call) => call !== 'myEnrollments' && call !== 'myForemanProjects'),
    ).toEqual([]);
  });
});
