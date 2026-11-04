import { describe, expect, it, jest } from '@jest/globals';
import * as SecureStore from 'expo-secure-store';
import { router } from 'expo-router';
import { act, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';

import { base64UrlDecode, buildBadgePayload } from '@sitemuster/shared';

import { FAKE_BADGE_SECRET, FakeSiteMusterApi, FakeWorld } from '../support/fake-api';
import { access, fakeBackend } from '../support/fake-auth';

/**
 * Screen flows for Milestone 08 (attended kiosk, printed badge, foreman crew, manual correction,
 * visitor desk, sign-out with unsent records) on the real `app/` routes. The phone's outbox is the
 * real native one (expo-sqlite double, AES-256-GCM); the server is the typed API double. The same
 * rules are enforced by Postgres and the ingest-operations handler (pgTAP 025, backend tests).
 */
type Globals = typeof globalThis & { __fakeAuthBackend?: unknown };

jest.mock('../../src/auth/create-gateway', () => ({
  createAuthBackend: () => (globalThis as Globals).__fakeAuthBackend ?? null,
}));

const ATTENDANT_USER = '77777777-7777-4777-8777-777777777777';
const FOREMAN_USER = '88888888-8888-4888-8888-888888888888';
const DEVICE = '5d000000-0000-4000-8000-0000000000a1';
const COMPANY = '0c000000-0000-4000-8000-0000000000a1';
const CREW_1 = '4f000000-0000-4000-8000-000000000001';
const CREW_2 = '4f000000-0000-4000-8000-000000000002';
const SESSION = '5e000000-0000-4000-8000-000000000001';

function signIn(world: FakeWorld, staff: boolean) {
  const api = new FakeSiteMusterApi(world);
  const backend = fakeBackend(() => world.access, api);
  backend.gateway.session = { destination: world.email };
  backend.gateway.aal = staff ? 'aal2' : 'aal1';
  backend.gateway.factors = staff ? ['factor-1'] : [];
  (globalThis as Globals).__fakeAuthBackend = backend;
  return api;
}

async function chooseLanguage(locale: 'en-US' | 'es-US') {
  await SecureStore.setItemAsync('sitemuster.locale.v1', locale);
}

/** An ACTIVE project owned by a GC owner, with one approved worker. */
async function site() {
  const owner = new FakeWorld(
    access({ email_verified: true, phone_verified: false }),
    'owner@example.test',
  );
  const orgId = owner.addOrganization('Gulf Coast Builders');
  const ownerApi = new FakeSiteMusterApi(owner);
  const projectId = await ownerApi.seedProject(orgId);
  await ownerApi.setStatus(projectId, 'ACTIVE', null);
  const enrollment = owner.addEnrollment(projectId, 'Ana Acosta', 'APPROVED');
  return { owner, projectId, enrollment };
}

function attendantWorld(owner: FakeWorld, projectId: string) {
  const world = new FakeWorld(
    access({
      user_id: ATTENDANT_USER,
      email_verified: true,
      phone_verified: false,
      project_roles: [{ project_id: projectId, role: 'ATTENDANT' }],
    }),
    'attendant@example.test',
    owner,
  );
  owner.projects
    .find((p) => p.id === projectId)
    ?.staff.push({
      id: 'staff-attendant',
      userId: ATTENDANT_USER,
      email: 'attendant@example.test',
      role: 'ATTENDANT',
      emergency: false,
    });
  return world;
}

const phoneBadge = (projectId: string) =>
  buildBadgePayload(
    base64UrlDecode(FAKE_BADGE_SECRET),
    DEVICE,
    projectId,
    Math.floor(Date.now() / 1000),
  );

describe('attended kiosk', () => {
  it('records a phone badge offline as "waiting to sync", then shows the worker once the server answers', async () => {
    const { owner, projectId, enrollment } = await site();
    const world = attendantWorld(owner, projectId);
    const badge = phoneBadge(projectId);
    world.badgeWorkers.set(badge, enrollment.workerId);
    world.operationsOffline = true;
    signIn(world, true);
    await chooseLanguage('en-US');
    await renderRouter('./app', { initialUrl: `/project/${projectId}/kiosk` });
    expect(await screen.findByTestId('kiosk')).toBeTruthy();
    expect(world.kiosks).toHaveLength(1);

    await fireEvent.changeText(screen.getByTestId('kiosk-code'), badge);
    await fireEvent.press(screen.getByTestId('kiosk-record'));
    expect(await screen.findByText('Waiting to sync — not confirmed')).toBeTruthy();
    expect(screen.getByTestId('sync-status-pending').props.children).toBe(
      'Records waiting to send: 1',
    );

    // Airplane mode off: Sync now sends it; the server answers for this one person.
    world.operationsOffline = false;
    await fireEvent.press(screen.getByTestId('sync-status-now'));
    expect(await screen.findByText('Ana Acosta: recorded')).toBeTruthy();
    expect(screen.getByTestId('sync-status-pending').props.children).toBe(
      'Everything recorded on this phone has reached the server.',
    );
    const sent = world.calls.filter((call) => call === 'ingestOperations');
    expect(sent.length).toBeGreaterThanOrEqual(2); // one refused offline, one delivered
  });

  it('a printed badge needs a face-and-name confirmation and stays flagged as printed', async () => {
    const { owner, projectId, enrollment } = await site();
    const world = attendantWorld(owner, projectId);
    const code = 'SMP1.printed-badge-code-0001-abcd';
    world.badgeWorkers.set(code, enrollment.workerId);
    signIn(world, true);
    await chooseLanguage('en-US');
    await renderRouter('./app', { initialUrl: `/project/${projectId}/kiosk` });
    await screen.findByTestId('kiosk');
    await fireEvent.changeText(screen.getByTestId('kiosk-code'), code);
    await fireEvent.press(screen.getByTestId('kiosk-record'));
    expect(
      await screen.findByText(
        'Printed badge: weaker evidence. Confirm the face and name match before recording.',
      ),
    ).toBeTruthy();
    expect(world.calls).not.toContain('ingestOperations'); // nothing recorded before confirming
    await fireEvent.press(screen.getByTestId('kiosk-printed-confirm'));
    expect(await screen.findByText('Ana Acosta: recorded')).toBeTruthy();
    expect(screen.getAllByText(/Printed badge/).length).toBeGreaterThan(0);
  });

  it('a worker approved after the kiosk opened is shown by name once the scan is accepted', async () => {
    const { owner, projectId } = await site();
    const world = attendantWorld(owner, projectId);
    signIn(world, true);
    await chooseLanguage('en-US');
    await renderRouter('./app', { initialUrl: `/project/${projectId}/kiosk` });
    await screen.findByTestId('kiosk');
    // Approved at the gate after the kiosk loaded its name list.
    const late = owner.addEnrollment(projectId, 'Diego Ruiz', 'APPROVED');
    const code = 'SMP1.printed-badge-code-late-0001';
    world.badgeWorkers.set(code, late.workerId);
    await fireEvent.changeText(screen.getByTestId('kiosk-code'), code);
    await fireEvent.press(screen.getByTestId('kiosk-record'));
    await fireEvent.press(await screen.findByTestId('kiosk-printed-confirm'));
    expect(await screen.findByText('Diego Ruiz: recorded')).toBeTruthy();
  });

  it('refuses anything that is not a SiteMuster badge', async () => {
    const { owner, projectId } = await site();
    signIn(attendantWorld(owner, projectId), true);
    await chooseLanguage('en-US');
    await renderRouter('./app', { initialUrl: `/project/${projectId}/kiosk` });
    await screen.findByTestId('kiosk');
    await fireEvent.changeText(screen.getByTestId('kiosk-code'), 'https://example.test/qr');
    await fireEvent.press(screen.getByTestId('kiosk-record'));
    expect(await screen.findByText('That is not a SiteMuster badge.')).toBeTruthy();
  });

  it('speaks Spanish when Spanish is chosen', async () => {
    const { owner, projectId } = await site();
    signIn(attendantWorld(owner, projectId), true);
    await chooseLanguage('es-US');
    await renderRouter('./app', { initialUrl: `/project/${projectId}/kiosk` });
    expect(
      await screen.findByText(
        'Quiosco atendido. Verifique la cara y el nombre de cada persona antes de registrarla.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('Llegada')).toBeTruthy();
  });
});

describe('foreman crew', () => {
  it('signs selected crew members in with one result per worker', async () => {
    const { owner, projectId } = await site();
    const world = new FakeWorld(
      access({ user_id: FOREMAN_USER, worker_profile_id: 'w-foreman', is_foreman: true }),
      '+15555550199',
      owner,
    );
    world.foremanProjects = [
      {
        project_id: projectId,
        project_name: 'Main Street Tower',
        project_status: 'ACTIVE',
        company_id: COMPANY,
        company_name: 'Acme Concrete',
        kiosk_grant: false,
      },
    ];
    world.crews.set(`${projectId}|${COMPANY}`, [
      { worker_id: CREW_1, name: 'Ana Acosta', trade: 'Concrete', employer_status: 'VERIFIED' },
      { worker_id: CREW_2, name: 'Ben Avila', trade: 'Concrete', employer_status: 'VERIFIED' },
    ]);
    signIn(world, false);
    await chooseLanguage('en-US');
    await renderRouter('./app', { initialUrl: '/worker/home' });
    await fireEvent.press(await screen.findByTestId(`crew-open-${projectId}`));
    expect(await screen.findByTestId('crew-screen')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('crew-submit'));
    expect(await screen.findByText('Select at least one worker.')).toBeTruthy();
    await fireEvent(screen.getByTestId(`crew-${CREW_1}`), 'valueChange', true);
    await fireEvent(screen.getByTestId(`crew-${CREW_2}`), 'valueChange', true);
    await fireEvent.press(screen.getByTestId('crew-submit'));
    expect(await screen.findByTestId(`crew-child-${CREW_1}`)).toBeTruthy();
    expect(screen.getByTestId(`crew-child-${CREW_1}`).props.children).toBe('Ana Acosta: recorded');
    expect(screen.getByTestId(`crew-child-${CREW_2}`).props.children).toBe('Ben Avila: recorded');
    expect(
      screen.getByText('A foreman sign-in is estimated attendance, not a verified payroll record.'),
    ).toBeTruthy();
  });
});

describe('manual correction', () => {
  it('the superintendent corrects one visit with a reason; the result is shown', async () => {
    const { owner, projectId, enrollment } = await site();
    owner.correctable.set(`${projectId}|${enrollment.workerId}`, [
      {
        session_id: SESSION,
        start_at: '2026-11-04T13:10:00Z',
        end_at: '2026-11-04T21:00:00Z',
        status: 'CLOSED',
        start_source: 'GEOFENCE',
        end_source: 'GEOFENCE',
      },
    ]);
    signIn(owner, true);
    await chooseLanguage('en-US');
    await renderRouter('./app', { initialUrl: `/project/${projectId}/workers` });
    await fireEvent.press(await screen.findByTestId(`correct-${enrollment.id}`));
    expect(await screen.findByTestId('correct-screen')).toBeTruthy();
    await fireEvent.press(await screen.findByText('2026-11-04 07:10 – 15:00'));
    expect(screen.getByTestId('correct-start').props.value).toBe('07:10');
    await fireEvent.changeText(screen.getByTestId('correct-start'), '06:30');
    await fireEvent.press(screen.getByTestId('correct-submit'));
    expect(
      await screen.findByText('Enter a valid date and time and a reason of at least 3 characters.'),
    ).toBeTruthy();
    await fireEvent.changeText(
      screen.getByTestId('correct-reason'),
      'Arrived before the gate opened',
    );
    await fireEvent.press(screen.getByTestId('correct-submit'));
    expect(await screen.findByText('Recorded')).toBeTruthy();
  });
});

describe('visitor desk', () => {
  it('signs a visitor in and out, separate from the workforce', async () => {
    const { owner, projectId } = await site();
    const world = attendantWorld(owner, projectId);
    signIn(world, true);
    await chooseLanguage('en-US');
    await renderRouter('./app', { initialUrl: `/project/${projectId}/visitors` });
    expect(
      await screen.findByText(
        'Visitors are never counted as workers. They do appear on emergency rosters.',
      ),
    ).toBeTruthy();
    await fireEvent.press(screen.getByTestId('visitor-submit'));
    expect(
      await screen.findByText("Enter the visitor's name and purpose and choose a host."),
    ).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId('visitor-name'), 'Ivy Inspector');
    await fireEvent.changeText(screen.getByTestId('visitor-purpose'), 'Framing inspection');
    await fireEvent.press(await screen.findByText('attendant@example.test · Kiosk attendant'));
    await fireEvent.press(screen.getByTestId('visitor-submit'));
    await waitFor(() => expect(world.visits).toHaveLength(1));
    const visitorId = world.visits[0]?.visitor_id ?? '';
    await fireEvent.press(await screen.findByTestId(`visitor-sign-out-${visitorId}`));
    await waitFor(() => expect(world.visits).toHaveLength(0));
    expect(world.operationReceipts.size).toBe(2);
  });
});

describe('sign-out with unsent records', () => {
  it('asks before discarding records that have not reached the server', async () => {
    const { owner, projectId, enrollment } = await site();
    const world = attendantWorld(owner, projectId);
    const badge = phoneBadge(projectId);
    world.badgeWorkers.set(badge, enrollment.workerId);
    world.operationsOffline = true;
    signIn(world, true);
    await chooseLanguage('en-US');
    const app = await renderRouter('./app', { initialUrl: `/project/${projectId}/kiosk` });
    await screen.findByTestId('kiosk');
    await fireEvent.changeText(screen.getByTestId('kiosk-code'), badge);
    await fireEvent.press(screen.getByTestId('kiosk-record'));
    await screen.findByText('Waiting to sync — not confirmed');

    await act(() => router.push('/staff/more'));
    await fireEvent.press(await screen.findByTestId('sign-out'));
    expect(
      await screen.findByText(
        'Records on this phone that have not reached the server: 1. If you sign out now, they will be lost.',
      ),
    ).toBeTruthy();
    await fireEvent.press(screen.getByTestId('sign-out-guard-cancel'));
    expect(await screen.findByTestId('sign-out')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('sign-out'));
    await fireEvent.press(await screen.findByTestId('sign-out-guard-discard'));
    await waitFor(() => expect(app.getPathname()).toBe('/sign-in'));
    expect(world.operationReceipts.size).toBe(0); // nothing was ever sent
  });
});
