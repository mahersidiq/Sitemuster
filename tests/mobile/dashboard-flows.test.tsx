import { describe, expect, it, jest } from '@jest/globals';
import * as SecureStore from 'expo-secure-store';
import { act, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';

import type { ProjectStaffRole } from '@sitemuster/shared';

import type { MapMarker } from '../../src/api/types';
import { FakeSiteMusterApi, FakeWorld } from '../support/fake-api';
import { access, fakeBackend } from '../support/fake-auth';

/**
 * Screen flows for Milestone 09 (superintendent dashboard, workforce roster, map, live updates) on
 * the real `app/` routes with the typed API double. The same rules run in Postgres (pgTAP 026) and
 * against a real Realtime server (tests/backend/dashboard.test.ts).
 */
type Globals = typeof globalThis & {
  __fakeAuthBackend?: unknown;
  __mapFails?: boolean;
  __mapAnimations?: { latitude: number; longitude: number }[];
};

jest.mock('../../src/auth/create-gateway', () => ({
  createAuthBackend: () => (globalThis as Globals).__fakeAuthBackend ?? null,
}));

const STAFF_USER = '99999999-9999-4999-8999-999999999999';

function signIn(world: FakeWorld) {
  const api = new FakeSiteMusterApi(world);
  const backend = fakeBackend(() => world.access, api);
  backend.gateway.session = { destination: world.email };
  backend.gateway.aal = 'aal2';
  backend.gateway.factors = ['factor-1'];
  (globalThis as Globals).__fakeAuthBackend = backend;
  return api;
}

async function chooseLanguage(locale: 'en-US' | 'es-US') {
  await SecureStore.setItemAsync('sitemuster.locale.v1', locale);
}

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

/** An ACTIVE project with four approved workers, one waiting for approval, seen by `role`. */
async function site(role: ProjectStaffRole = 'SUPER') {
  const owner = new FakeWorld(
    access({ email_verified: true, phone_verified: false }),
    'owner@example.test',
  );
  const orgId = owner.addOrganization('Gulf Coast Builders');
  const ownerApi = new FakeSiteMusterApi(owner);
  const projectId = await ownerApi.seedProject(orgId);
  await ownerApi.setStatus(projectId, 'ACTIVE', null);
  const ana = owner.addEnrollment(projectId, 'Ana Acosta', 'APPROVED');
  const ben = owner.addEnrollment(projectId, 'Ben Avila', 'APPROVED');
  const diego = owner.addEnrollment(projectId, 'Diego Ruiz', 'APPROVED');
  const fernando = owner.addEnrollment(projectId, 'Fernando Alvarez', 'APPROVED');
  owner.addEnrollment(projectId, 'Paula Pending', 'PENDING');
  for (const e of [ana, ben, diego, fernando]) e.employer = 'VERIFIED';
  const world = new FakeWorld(
    access({
      user_id: STAFF_USER,
      email_verified: true,
      phone_verified: false,
      project_roles: [{ project_id: projectId, role }],
    }),
    'staff@example.test',
    owner,
  );
  owner.projects
    .find((p) => p.id === projectId)
    ?.staff.push({
      id: 'staff-1',
      userId: STAFF_USER,
      email: 'staff@example.test',
      role,
      emergency: false,
    });
  world.setPresence(ana.id, {
    presence: 'ONSITE_ESTIMATED',
    counted: true,
    source: 'GEOFENCE',
    arrivedAt: minutesAgo(90),
    lastSeenAt: minutesAgo(2),
    tracking: 'CREDENTIAL_EXPIRING',
  });
  world.setPresence(ben.id, {
    presence: 'ONSITE_ESTIMATED',
    counted: true,
    source: 'FOREMAN',
    witnessed: true,
    arrivedAt: minutesAgo(60),
  });
  world.setPresence(diego.id, {
    presence: 'PRESENCE_UNKNOWN',
    source: 'GEOFENCE',
    lastSeenAt: minutesAgo(30),
    tracking: 'ACTIVE',
  });
  world.visits.push({
    visit_id: 'v1',
    visitor_id: 'v1',
    name: 'Ivy Inspector',
    organization: 'City',
    host_user_id: STAFF_USER,
    purpose: 'Inspection',
    checked_in_at: minutesAgo(20),
    status: 'OPEN',
  });
  const marker = (
    worker: { workerId: string },
    name: string,
    age: number,
    life: number,
  ): MapMarker => ({
    worker_id: worker.workerId,
    legal_name: name,
    company_name: 'Acme Concrete',
    lat: 29.7605,
    lng: -95.3697,
    accuracy_m: name === 'Ana Acosta' ? 12 : 20,
    observed_at: minutesAgo(age),
    expires_at: new Date(Date.now() + life * 60_000).toISOString(),
    fresh: age < 10,
  });
  world.markers.set(projectId, [
    marker(ana, 'Ana Acosta', 2, 18),
    marker(ben, 'Ben Avila', 15, 5),
    marker(diego, 'Diego Ruiz', 25, -5), // already expired: never shown
  ]);
  return { owner, world, projectId, ana, ben, diego, fernando };
}

describe('superintendent dashboard', () => {
  it('shows the estimate, its sources, unknown (not gone), visitors apart and the approval queue', async () => {
    const { world, projectId } = await site();
    signIn(world);
    await chooseLanguage('en-US');
    await renderRouter('./app', { initialUrl: '/staff/home' });
    expect(await screen.findByTestId('dash-onsite')).toBeTruthy();
    expect(screen.getByText('Main Street Tower')).toBeTruthy(); // the only project, picked
    expect(screen.getByTestId('dash-onsite-count').props.children).toBe('2');
    expect(
      screen.getByText(
        'An estimate from phones, kiosk scans, foremen and manual entries. It is not a verified headcount.',
      ),
    ).toBeTruthy();
    expect(screen.getByTestId('dash-witnessed').props.children).toBe(
      'Confirmed in person (kiosk, foreman or manual): 1',
    );
    expect(screen.getByTestId('dash-source-GEOFENCE').props.children).toBe('Phone (estimated): 1');
    expect(screen.getByTestId('dash-source-FOREMAN').props.children).toBe('Foreman: 1');
    expect(screen.getByTestId('dash-source-KIOSK_PRINTED_BADGE').props.children).toBe(
      'Kiosk, printed badge (weaker evidence): 0',
    );
    expect(screen.getByTestId('dash-unknown').props.children).toBe('Presence unknown: 1');
    expect(
      screen.getByText('No recent signal. Not counted, and not assumed to have left.'),
    ).toBeTruthy();
    expect(screen.getByTestId('dash-visitors').props.children).toBe(
      'Visitors on site (not counted as workers): 1',
    );
    expect(screen.getByText(/Acme Concrete: 2 on site of 4 approved/)).toBeTruthy();
    expect(screen.getByTestId('dash-pending').props.children).toBe('Waiting for approval: 1');
    expect(screen.getByTestId('live-LIVE')).toBeTruthy();
    expect(screen.getByTestId('dash-open-map')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('dash-review-approvals'));
    expect(screen).toHavePathname(`/project/${projectId}/workers`);
  });

  it('a Broadcast refetches the counts; a dropped channel says so and resyncs what it missed', async () => {
    const { world, projectId, fernando, diego } = await site();
    signIn(world);
    await chooseLanguage('en-US');
    await renderRouter('./app', { initialUrl: '/staff/home' });
    await screen.findByTestId('dash-onsite');
    await waitFor(() => expect(world.channels.get(projectId)?.size).toBe(1));

    // A kiosk scan lands on the server: the database sends a message, the screen refetches.
    world.setPresence(fernando.id, {
      presence: 'ONSITE_ESTIMATED',
      counted: true,
      source: 'KIOSK_DYNAMIC_BADGE',
      witnessed: true,
    });
    await act(async () => {
      world.emitBroadcast(projectId);
    });
    // Refetches are coalesced into a 2-second window (fake timers advance inside waitFor).
    await waitFor(() => expect(screen.getByTestId('dash-onsite-count').props.children).toBe('3'), {
      timeout: 5000,
    });

    // The channel drops: the screen says so; a change happens while nobody hears it.
    await act(async () => {
      world.setChannelStatus(projectId, 'DISCONNECTED');
    });
    expect(await screen.findByTestId('live-PAUSED')).toBeTruthy();
    expect(
      screen.getByText(/Live updates paused\. Refreshing every minute \(updated /),
    ).toBeTruthy();
    world.setPresence(diego.id, { presence: 'ONSITE_ESTIMATED', counted: true });
    // Back: joining again refetches everything, so the missed change appears.
    await act(async () => {
      world.setChannelStatus(projectId, 'SUBSCRIBED');
    });
    await waitFor(() => expect(screen.getByTestId('dash-onsite-count').props.children).toBe('4'), {
      timeout: 5000,
    });
    expect(screen.getByTestId('live-LIVE')).toBeTruthy();
  });

  it('offline keeps the last numbers with the time they were loaded; revoked access hides them', async () => {
    const { world, projectId } = await site();
    signIn(world);
    await chooseLanguage('en-US');
    await renderRouter('./app', { initialUrl: '/staff/home' });
    await screen.findByTestId('dash-onsite');

    world.readsOffline = true;
    await fireEvent.press(screen.getByTestId('live-refresh'));
    expect(await screen.findByTestId('live-offline', {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByText(/Offline: showing what was loaded at/)).toBeTruthy();
    expect(screen.getByTestId('dash-onsite-count').props.children).toBe('2');

    // The superintendent is removed from the project: the database refuses both the channel
    // and the reads, and the screen stops showing project data.
    world.readsOffline = false;
    world.access = { ...world.access, project_roles: [] };
    await act(async () => {
      world.setChannelStatus(projectId, 'DENIED');
    });
    expect(await screen.findByTestId('live-DENIED')).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId('dash-onsite')).toBeNull(), { timeout: 5000 });
  });

  it('speaks Spanish when Spanish is chosen', async () => {
    const { world } = await site();
    signIn(world);
    await chooseLanguage('es-US');
    await renderRouter('./app', { initialUrl: '/staff/home' });
    expect(await screen.findByText('Estimado en la obra')).toBeTruthy();
    expect(screen.getByTestId('dash-unknown').props.children).toBe('Presencia desconocida: 1');
    expect(screen.getByTestId('dash-visitors').props.children).toBe(
      'Visitantes en la obra (no se cuentan como trabajadores): 1',
    );
    expect(screen.getByTestId('dash-source-FOREMAN').props.children).toBe('Capataz: 1');
  });

  it('with several projects the person picks one explicitly and can change it', async () => {
    const { owner, world } = await site();
    const ownerApi = new FakeSiteMusterApi(owner);
    const second = await ownerApi.seedProject(owner.orgs[0]?.id ?? '', { name: 'Harbor Plant' });
    world.access = {
      ...world.access,
      project_roles: [...world.access.project_roles, { project_id: second, role: 'SUPER' }],
    };
    signIn(world);
    await chooseLanguage('en-US');
    await renderRouter('./app', { initialUrl: '/staff/home' });
    expect(await screen.findByTestId('project-header-picker')).toBeTruthy();
    expect(screen.queryByTestId('dash-onsite')).toBeNull(); // nothing shown until chosen
    await fireEvent.press(screen.getByTestId(`pick-${second}`));
    expect(await screen.findByTestId('dash-onsite')).toBeTruthy();
    expect(screen.getByText('Harbor Plant')).toBeTruthy();
    expect(screen.getByTestId('dash-onsite-count').props.children).toBe('0');
    expect(screen.getByTestId('dash-no-workers')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('change-project'));
    expect(await screen.findByTestId('project-header-picker')).toBeTruthy();
  });
});

describe('workforce roster', () => {
  it('lists counted people first with how they were recorded, unknown as unknown, and phone health', async () => {
    const { world, ana, ben, diego, fernando } = await site();
    signIn(world);
    await chooseLanguage('en-US');
    await renderRouter('./app', { initialUrl: '/staff/workforce' });
    expect(await screen.findByTestId(`member-${ana.workerId}`)).toBeTruthy();
    expect(screen.getByTestId(`member-presence-${ana.workerId}`).props.children).toEqual([
      'On site (estimated)',
      ' · Phone (estimated)',
    ]);
    expect(screen.getByTestId(`member-presence-${ben.workerId}`).props.children).toEqual([
      'On site (estimated)',
      ' · Foreman',
    ]);
    expect(screen.getByText('Confirmed in person')).toBeTruthy();
    expect(screen.getByTestId(`member-presence-${diego.workerId}`).props.children).toEqual([
      'Presence unknown: no recent signal',
      ' · Phone (estimated)',
    ]);
    expect(screen.getByTestId(`member-tracking-${ana.workerId}`).props.children).toBe(
      'Automatic attendance ends soon. Ask the worker to open the app.',
    );
    expect(screen.getByText('Waiting for approval: 1')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('roster-filter-UNKNOWN'));
    expect(screen.getByTestId(`member-${diego.workerId}`)).toBeTruthy();
    expect(screen.queryByTestId(`member-${ana.workerId}`)).toBeNull();
    expect(screen.queryByTestId(`member-${fernando.workerId}`)).toBeNull();
  });
});

describe('site map', () => {
  it('shows recent positions with time and accuracy, labels stale ones, and never shows expired ones', async () => {
    const { world, projectId, ana, ben, diego } = await site();
    signIn(world);
    await chooseLanguage('en-US');
    await renderRouter('./app', { initialUrl: '/staff/map' });
    expect(await screen.findByTestId('native-map')).toBeTruthy();
    expect(screen.getByTestId('map-circle-150')).toBeTruthy(); // the site circle
    expect(screen.getByTestId('map-circle-200')).toBeTruthy(); // where leaving is detected
    expect(screen.getByTestId(`marker-${ana.workerId}`).props.children).toBe(
      'Ana Acosta (Acme Concrete): 12 m accuracy · 2 min ago',
    );
    expect(screen.getByTestId(`marker-${ben.workerId}`).props.children).toBe(
      'Ben Avila (Acme Concrete): Stale, not live: 15 min ago · 20 m accuracy',
    );
    expect(screen.queryByTestId(`marker-${diego.workerId}`)).toBeNull();
    expect(screen.getAllByTestId('map-marker')).toHaveLength(2);
    expect(screen.getByTestId('map-attendance-summary').props.children).toBe(
      'Estimated on site: 2 · Presence unknown: 1',
    );
    expect(world.calls).toContain('projectMap');
    expect(projectId).toBeTruthy();
  });

  it('a revoked worker leaves an open map, and a moved site brings the view with it', async () => {
    // Review findings on PR #9: an enrollment change must refetch the map; the native map's
    // initialRegion applies only on mount, so a moved site must move the view.
    const { owner, world, projectId, ana } = await site();
    signIn(world);
    await chooseLanguage('en-US');
    await renderRouter('./app', { initialUrl: '/staff/map' });
    expect(await screen.findByTestId(`marker-${ana.workerId}`)).toBeTruthy();
    await waitFor(() => expect(world.channels.get(projectId)?.size).toBe(1));

    ana.status = 'REVOKED'; // revoked from another phone: only an enrollment message arrives
    await act(async () => {
      world.emitBroadcast(projectId, 'ENROLLMENT_CHANGED');
    });
    await waitFor(() => expect(screen.queryByTestId(`marker-${ana.workerId}`)).toBeNull(), {
      timeout: 5000,
    });

    const version = owner.projects.find((p) => p.id === projectId)?.versions.at(-1);
    if (!version) throw new Error('no configuration version');
    version.centerLat = 29.77;
    version.centerLng = -95.36;
    await act(async () => {
      world.emitBroadcast(projectId, 'PROJECT_CONFIG_CHANGED');
    });
    await waitFor(
      () =>
        expect((globalThis as Globals).__mapAnimations?.at(-1)).toMatchObject({
          latitude: 29.77,
          longitude: -95.36,
        }),
      { timeout: 5000 },
    );
  });

  it('a map that cannot render keeps the attendance numbers and the position list', async () => {
    const { world, ana } = await site();
    (globalThis as Globals).__mapFails = true;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    signIn(world);
    await chooseLanguage('en-US');
    await renderRouter('./app', { initialUrl: '/staff/map' });
    expect(await screen.findByTestId('map-unavailable')).toBeTruthy();
    expect(screen.queryByTestId('native-map')).toBeNull();
    expect(screen.getByTestId(`marker-${ana.workerId}`)).toBeTruthy();
    expect(screen.getByTestId('map-attendance-summary').props.children).toBe(
      'Estimated on site: 2 · Presence unknown: 1',
    );
    expect(warn).toHaveBeenCalledWith('map: render failed', 'Error');
    warn.mockRestore();
    error.mockRestore();
  });

  it('a kiosk attendant sees counts but no positions, and the map is never requested', async () => {
    const { world } = await site('ATTENDANT');
    signIn(world);
    await chooseLanguage('en-US');
    await renderRouter('./app', { initialUrl: '/staff/map' });
    expect(await screen.findByTestId('map-not-allowed')).toBeTruthy();
    expect(screen.getByTestId('map-attendance-summary').props.children).toBe(
      'Estimated on site: 2 · Presence unknown: 1',
    );
    expect(screen.queryByTestId('native-map')).toBeNull();
    expect(world.calls).not.toContain('projectMap');
  });
});
