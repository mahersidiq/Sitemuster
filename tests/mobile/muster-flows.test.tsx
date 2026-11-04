import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { router } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import { act, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import { Share } from 'react-native';

import { base64UrlDecode, buildBadgePayload } from '@sitemuster/shared';

import { resetMusterAlertRegistrations } from '../../src/notifications/muster-alerts';
import { resetHandledMusterResponses } from '../../src/notifications/MusterNotifications';
import {
  FAKE_BADGE_SECRET,
  type FakeMuster,
  FakeSiteMusterApi,
  FakeWorld,
} from '../support/fake-api';
import { access, FAKE_SMS_CODE, fakeBackend } from '../support/fake-auth';

/**
 * Screen flows for Milestone 11 (Active Muster Mode) on the real `app/` routes: the designated
 * safety role starts a muster after a confirmation, the board keeps "seen at the assembly point",
 * "said safe in the app", unknown and not-accounted-for apart (visitors separately), I'M SAFE is
 * a self-report only, foreman and kiosk checks go through the offline outbox, and closing needs a
 * note plus an explicit acknowledgement before the immutable report. The server rules are tested
 * in pgTAP 028, the Edge core tests and the backend tests.
 */
type Globals = typeof globalThis & {
  __fakeAuthBackend?: unknown;
  __easProjectId?: string;
  __notifications?: {
    permission: { granted: boolean; canAskAgain: boolean };
    lastResponse: unknown;
    categories: Record<string, unknown>;
  };
};

jest.mock('../../src/auth/create-gateway', () => ({
  createAuthBackend: () => (globalThis as Globals).__fakeAuthBackend ?? null,
}));

beforeEach(() => {
  resetMusterAlertRegistrations();
  resetHandledMusterResponses();
});

const SAFETY_USER = '66666666-6666-4666-8666-666666666666';
const ATTENDANT_USER = '77777777-7777-4777-8777-777777777777';
const FOREMAN_USER = '88888888-8888-4888-8888-888888888888';
const WORKER_USER = '99999999-9999-4999-8999-999999999999';
const DEVICE = '5d000000-0000-4000-8000-0000000000a1';

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

/**
 * An ACTIVE project: Ana (her own phone, registered for alerts) and Ben (no phone) approved for
 * Acme Concrete, and optionally Carl approved for another company.
 */
async function site({ withCarl = false } = {}) {
  const owner = new FakeWorld(
    access({ email_verified: true, phone_verified: false }),
    'owner@example.test',
  );
  const orgId = owner.addOrganization('Gulf Coast Builders');
  const ownerApi = new FakeSiteMusterApi(owner);
  const projectId = await ownerApi.seedProject(orgId);
  await ownerApi.setStatus(projectId, 'ACTIVE', null);
  const ana = owner.addEnrollment(projectId, 'Ana Acosta', 'APPROVED', WORKER_USER);
  const ben = owner.addEnrollment(projectId, 'Ben Avila', 'APPROVED');
  owner.pushTokens.push({ userId: WORKER_USER, token: 'ExponentPushToken[anaphone0001]' });
  if (withCarl) {
    const carl = owner.addEnrollment(projectId, 'Carl Diaz', 'APPROVED');
    const other = { id: '0c000000-0000-4000-8000-0000000000b2', name: 'Bayou Steel', projectId };
    owner.companies.push(other);
    carl.companyId = other.id;
  }
  return { owner, projectId, ana, ben };
}

/**
 * What the acting phone's fake server sees right now: Ana detected on site by her phone and Vera
 * signed in at the visitor desk (per-actor state in the fake).
 */
function stage(world: FakeWorld, anaEnrollmentId: string) {
  world.setPresence(anaEnrollmentId, {
    presence: 'ONSITE_ESTIMATED',
    counted: true,
    source: 'GEOFENCE',
  });
  world.visits.push({
    visit_id: '6a000000-0000-4000-8000-000000000001',
    visitor_id: '6b000000-0000-4000-8000-000000000001',
    name: 'Vera Inspector',
    organization: 'City Inspections',
    host_user_id: null,
    purpose: 'Inspection',
    checked_in_at: new Date(world.now - 3_600_000).toISOString(),
    status: 'OPEN',
  });
}

function staffWorld(
  owner: FakeWorld,
  projectId: string,
  userId: string,
  role: 'SAFETY' | 'SUPER' | 'ATTENDANT',
) {
  const world = new FakeWorld(
    access({
      user_id: userId,
      email_verified: true,
      phone_verified: false,
      project_roles: [{ project_id: projectId, role }],
    }),
    `${role.toLowerCase()}@example.test`,
    owner,
  );
  owner.projects
    .find((p) => p.id === projectId)
    ?.staff.push({
      id: `staff-${role}`,
      userId,
      email: `${role.toLowerCase()}@example.test`,
      role,
      emergency: role === 'SAFETY',
    });
  return world;
}

function workerWorld(owner: FakeWorld) {
  return new FakeWorld(
    access({ user_id: WORKER_USER, worker_profile_id: owner.workers[0]?.id ?? null }),
    '+15555550123',
    owner,
  );
}

const member = (muster: FakeMuster, name: string) => {
  const row = muster.members.find((m) => m.name === name);
  if (!row) throw new Error(`no member ${name}`);
  return row;
};

const count = (testID: string) => screen.getByTestId(testID).props.children as string;

describe('starting a muster (designated safety role)', () => {
  it('asks for confirmation, then shows separated counters, alert results and where people were', async () => {
    const { owner, projectId, ana: anaEnrollment } = await site();
    const world = staffWorld(owner, projectId, SAFETY_USER, 'SAFETY');
    stage(world, anaEnrollment.id);
    signIn(world, true);
    await chooseLanguage('en-US');
    await renderRouter('./app', { initialUrl: `/project/${projectId}` });
    await fireEvent.press(await screen.findByTestId('open-muster'));
    expect(await screen.findByTestId('muster-disclaimer')).toBeTruthy();

    await fireEvent.press(await screen.findByTestId('muster-start-button'));
    expect(await screen.findByText('Write what is happening.')).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId('muster-label'), 'Fire alarm, level 3');
    await fireEvent.press(screen.getByTestId('muster-start-button'));
    expect(await screen.findByTestId('muster-start-confirm-card')).toBeTruthy();
    expect(owner.musters).toHaveLength(0); // nothing happens before the confirmation
    await fireEvent.press(screen.getByTestId('muster-start-confirm'));

    expect(await screen.findByTestId('muster-board')).toBeTruthy();
    expect(owner.musters).toHaveLength(1);
    expect(
      screen.getByText(
        'Muster started. Alerts sent: 1 of 1. Failed: 0. Do not wait for alerts: check people at the assembly point. Development build: alerts go to a test adapter, not to real phones.',
      ),
    ).toBeTruthy();
    expect(count('muster-count-verified')).toBe('Seen at the assembly point: 0');
    expect(count('muster-count-self')).toBe('Said safe in the app (not checked): 0');
    expect(count('muster-count-unaccounted')).toBe('Not accounted for: 2');
    expect(count('muster-count-visitors-unaccounted')).toBe('Not seen yet: 1');
    expect(count('muster-board-push-line')).toBe('Sent: 1 · Failed: 0 · No phone registered: 1');
    const muster = owner.musters[0] as FakeMuster;
    const ana = member(muster, 'Ana Acosta');
    const ben = member(muster, 'Ben Avila');
    expect(screen.getByText('Detected on site at the start: Phone (estimated)')).toBeTruthy();
    expect(screen.getByText('Approved for this project, not detected on site')).toBeTruthy();
    expect(screen.getByText('Vera Inspector · visitor')).toBeTruthy();
    expect(screen.getByTestId(`muster-status-${ana.member_id}`).props.children).toBe(
      'Not accounted for',
    );
    expect(screen.getByTestId(`muster-seen-${ben.member_id}`)).toBeTruthy();
  });

  it('a start that timed out is retried with the same key: still one muster', async () => {
    const { owner, projectId } = await site();
    const api = signIn(staffWorld(owner, projectId, SAFETY_USER, 'SAFETY'), true);
    await chooseLanguage('en-US');
    await renderRouter('./app', { initialUrl: `/project/${projectId}/muster` });
    await fireEvent.changeText(await screen.findByTestId('muster-label'), 'Drill');
    await fireEvent.press(screen.getByTestId('muster-start-button'));
    api.failNext('NETWORK', true); // the server started it, the answer was lost
    await fireEvent.press(await screen.findByTestId('muster-start-confirm'));
    expect(
      await screen.findByText("Couldn't reach SiteMuster. Check your connection and try again."),
    ).toBeTruthy();
    await fireEvent.press(screen.getByTestId('muster-start-confirm'));
    expect(await screen.findByTestId('muster-board')).toBeTruthy();
    expect(screen.getByText('Muster started.')).toBeTruthy();
    expect(owner.musters).toHaveLength(1);
  });

  it('a superintendent without the safety role sees the board but cannot start, close or mark people', async () => {
    const { owner, projectId } = await site();
    new FakeSiteMusterApi(owner).seedMuster(projectId);
    signIn(staffWorld(owner, projectId, SAFETY_USER, 'SUPER'), true);
    await chooseLanguage('en-US');
    await renderRouter('./app', { initialUrl: `/project/${projectId}/muster` });
    expect(await screen.findByTestId('muster-board')).toBeTruthy();
    expect(screen.getByTestId('muster-only-safety')).toBeTruthy();
    expect(screen.queryByTestId('muster-start')).toBeNull();
    expect(screen.queryByTestId('muster-close')).toBeNull();
    expect(screen.queryAllByText('Seen at the assembly point', { exact: true })).toHaveLength(0);
  });
});

describe('the acceptance case: 2 workers and 1 visitor', () => {
  it('I’M SAFE, a physical check and the visitor check stay in separate counters', async () => {
    const { owner, projectId, ana: anaEnrollment } = await site();
    const world = staffWorld(owner, projectId, SAFETY_USER, 'SAFETY');
    stage(world, anaEnrollment.id);
    const muster = new FakeSiteMusterApi(world).seedMuster(projectId);
    const ana = member(muster, 'Ana Acosta');
    const ben = member(muster, 'Ben Avila');
    const vera = member(muster, 'Vera Inspector');
    // Ana answered I'M SAFE from her own phone (her flow is tested below).
    ana.status = 'SELF_REPORTED_SAFE';
    ana.last_response = { action: 'SELF_REPORT', channel: 'APP', at: new Date().toISOString() };
    signIn(world, true);
    await chooseLanguage('en-US');
    await renderRouter('./app', { initialUrl: `/project/${projectId}/muster` });
    expect(await screen.findByTestId('muster-board')).toBeTruthy();
    expect(screen.getByTestId(`muster-status-${ana.member_id}`).props.children).toBe(
      'Said safe (not checked)',
    );

    // The commander sees Ben and Vera at the assembly point.
    await fireEvent.press(screen.getByTestId(`muster-seen-${ben.member_id}`));
    await fireEvent.press(screen.getByTestId(`muster-seen-${vera.member_id}`));
    await waitFor(() =>
      expect(count('muster-count-verified')).toBe('Seen at the assembly point: 1'),
    );
    await waitFor(() =>
      expect(count('muster-count-visitors-verified')).toBe('Seen at the assembly point: 1'),
    );
    expect(count('muster-count-self')).toBe('Said safe in the app (not checked): 1');
    expect(count('muster-count-unaccounted')).toBe('Not accounted for: 0');
    // A self-report never turns into "seen": Ana still needs a physical check.
    expect(ana.status).toBe('SELF_REPORTED_SAFE');
    await fireEvent.press(screen.getByTestId('muster-board-filter-ALL'));
    expect(screen.getByTestId(`muster-seen-${ana.member_id}`)).toBeTruthy();
    await fireEvent.press(screen.getByTestId(`muster-seen-${ana.member_id}`));
    await waitFor(() =>
      expect(count('muster-count-verified')).toBe('Seen at the assembly point: 2'),
    );
    expect(member(muster, 'Ana Acosta').status).toBe('VERIFIED_ACCOUNTED');
  });
});

describe('worker I’M SAFE', () => {
  it('offline it waits on the phone, says it is not a physical check, and is sent once', async () => {
    const { owner, projectId } = await site();
    const muster = new FakeSiteMusterApi(owner).seedMuster(projectId);
    const world = workerWorld(owner);
    world.operationsOffline = true;
    signIn(world, false);
    await chooseLanguage('en-US');
    await renderRouter('./app', { initialUrl: '/worker/home' });
    expect(await screen.findByTestId(`muster-alert-${muster.id}`)).toBeTruthy();
    expect(
      screen.getByText(`EMERGENCY MUSTER · ${owner.projects[0]?.name ?? ''} · Fire alarm`),
    ).toBeTruthy();
    await fireEvent.press(screen.getByTestId('muster-im-safe'));
    expect(await screen.findByText('Waiting to sync — not confirmed')).toBeTruthy();
    expect(screen.getByTestId('muster-self-note')).toBeTruthy();
    expect(screen.queryByTestId('muster-im-safe')).toBeNull();
    expect(member(muster, 'Ana Acosta').status).toBe('UNACCOUNTED');

    world.operationsOffline = false;
    await fireEvent.press(screen.getByTestId('sync-status-now'));
    expect(await screen.findByText('Recorded')).toBeTruthy();
    expect(member(muster, 'Ana Acosta').status).toBe('SELF_REPORTED_SAFE');
    const sent = owner.musters[0]?.members.filter((m) => m.status === 'VERIFIED_ACCOUNTED');
    expect(sent).toHaveLength(0);
  });

  it('speaks Spanish: ESTOY A SALVO, and the counted state once seen at the assembly point', async () => {
    const { owner, projectId } = await site();
    const muster = new FakeSiteMusterApi(owner).seedMuster(projectId, 'Simulacro');
    signIn(workerWorld(owner), false);
    await chooseLanguage('es-US');
    await renderRouter('./app', { initialUrl: '/worker/home' });
    expect(await screen.findByText('ESTOY A SALVO')).toBeTruthy();
    expect(
      screen.getByText(
        'Si está a salvo, toque ESTOY A SALVO. Luego vaya al punto de reunión para que lo cuenten.',
      ),
    ).toBeTruthy();
    // Meanwhile her foreman sees her at the assembly point; her own I'M SAFE never undoes that.
    member(muster, 'Ana Acosta').status = 'VERIFIED_ACCOUNTED';
    await fireEvent.press(screen.getByTestId('muster-im-safe'));
    expect(await screen.findByTestId('muster-worker-verified')).toBeTruthy();
    expect(screen.getByText('Lo contaron en el punto de reunión.')).toBeTruthy();
  });

  it('the I’M SAFE button on the alert queues the worker’s own answer (unlock required)', async () => {
    const { owner, projectId } = await site();
    const muster = new FakeSiteMusterApi(owner).seedMuster(projectId);
    const notifications = (globalThis as Globals).__notifications;
    if (!notifications) throw new Error('notifications mock missing');
    notifications.lastResponse = {
      actionIdentifier: 'IM_SAFE',
      notification: {
        request: {
          identifier: 'n-1',
          content: {
            data: {
              type: 'MUSTER',
              muster_id: muster.id,
              project_id: projectId,
              member_id: member(muster, 'Ana Acosta').member_id,
            },
          },
        },
      },
    };
    signIn(workerWorld(owner), false);
    await chooseLanguage('en-US');
    await renderRouter('./app', { initialUrl: '/worker/home' });
    await waitFor(() => expect(member(muster, 'Ana Acosta').status).toBe('SELF_REPORTED_SAFE'));
    expect(member(muster, 'Ana Acosta').last_response?.channel).toBe('NOTIFICATION_ACTION');
    expect(notifications.categories.MUSTER).toEqual([
      {
        identifier: 'IM_SAFE',
        buttonTitle: "I'M SAFE",
        options: { opensAppToForeground: true, isAuthenticationRequired: true },
      },
    ]);
    expect(await screen.findByTestId('muster-self-note')).toBeTruthy();
  });
});

describe('muster alerts on the phone', () => {
  it('explains first, asks once, and says when push is not set up in this build', async () => {
    const { owner } = await site();
    const world = workerWorld(owner);
    signIn(world, false);
    await chooseLanguage('en-US');
    await renderRouter('./app', { initialUrl: '/worker/home' });
    expect(await screen.findByTestId('muster-alerts-setup')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('muster-alerts-turn-on'));
    expect(await screen.findByTestId('muster-alerts-not-configured')).toBeTruthy();
    expect(world.calls).not.toContain('registerPushToken');
  });

  it('registers this phone for the signed-in worker once the build has an EAS project', async () => {
    const { owner } = await site();
    owner.pushTokens.length = 0;
    (globalThis as Globals).__easProjectId = 'eas-project-test';
    const notifications = (globalThis as Globals).__notifications;
    if (notifications) notifications.permission = { granted: true, canAskAgain: true };
    const world = workerWorld(owner);
    signIn(world, false);
    await chooseLanguage('en-US');
    await renderRouter('./app', { initialUrl: '/worker/home' });
    await waitFor(() =>
      expect(owner.pushTokens).toEqual([
        { userId: WORKER_USER, token: 'ExponentPushToken[testtoken0001]' },
      ]),
    );
    expect(screen.queryByTestId('muster-alerts-setup')).toBeNull();
  });

  it('signing out and back in during the same app run registers the phone again (review on PR #11)', async () => {
    const { owner } = await site();
    owner.pushTokens.length = 0;
    (globalThis as Globals).__easProjectId = 'eas-project-test';
    const notifications = (globalThis as Globals).__notifications;
    if (notifications) notifications.permission = { granted: true, canAskAgain: true };
    const world = workerWorld(owner);
    signIn(world, false);
    await chooseLanguage('en-US');
    await renderRouter('./app', { initialUrl: '/worker/home' });
    await waitFor(() => expect(owner.pushTokens).toHaveLength(1));

    // Sign out: the server stops this person's alerts on this phone.
    await act(() => router.push('/worker/profile'));
    await fireEvent.press(await screen.findByTestId('sign-out'));
    await waitFor(() => expect(owner.pushTokens).toHaveLength(0));
    expect(world.calls).toContain('revokeMyPushTokens');

    // Same person, same app run: signing in again turns the alerts back on.
    await fireEvent.press(await screen.findByTestId('worker-sign-in'));
    await fireEvent.changeText(await screen.findByTestId('phone-input'), '(555) 555-0123');
    await fireEvent.press(screen.getByTestId('send-code'));
    await fireEvent.changeText(await screen.findByTestId('code-input'), FAKE_SMS_CODE);
    await fireEvent.press(screen.getByTestId('verify-code'));
    expect(await screen.findByTestId('worker-home')).toBeTruthy();
    await waitFor(() =>
      expect(owner.pushTokens).toEqual([
        { userId: WORKER_USER, token: 'ExponentPushToken[testtoken0001]' },
      ]),
    );
    expect(world.calls.filter((call) => call === 'registerPushToken')).toHaveLength(2);
  });

  it('alerts turned off: says so and links to Settings', async () => {
    const { owner } = await site();
    const notifications = (globalThis as Globals).__notifications;
    if (notifications) notifications.permission = { granted: false, canAskAgain: false };
    signIn(workerWorld(owner), false);
    await chooseLanguage('es-US');
    await renderRouter('./app', { initialUrl: '/worker/home' });
    expect(await screen.findByTestId('muster-alerts-denied')).toBeTruthy();
    expect(screen.getByText('Abrir Configuración')).toBeTruthy();
  });
});

describe('foreman and kiosk checks', () => {
  it('a foreman sees only their own company and checks a worker through the outbox', async () => {
    const { owner, projectId } = await site({ withCarl: true });
    const muster = new FakeSiteMusterApi(owner).seedMuster(projectId);
    const company = owner.companies.find((c) => c.name === 'Acme Concrete');
    const world = new FakeWorld(
      access({ user_id: FOREMAN_USER, worker_profile_id: 'w-foreman', is_foreman: true }),
      '+15555550199',
      owner,
    );
    world.foremanProjects = [
      {
        project_id: projectId,
        project_name: owner.projects[0]?.name ?? '',
        project_status: 'ACTIVE',
        company_id: company?.id ?? '',
        company_name: 'Acme Concrete',
        kiosk_grant: false,
      },
    ];
    signIn(world, false);
    await chooseLanguage('en-US');
    await renderRouter('./app', { initialUrl: '/worker/home' });
    await fireEvent.press(await screen.findByTestId(`foreman-muster-open-${muster.id}`));
    expect(await screen.findByTestId('foreman-muster')).toBeTruthy();
    expect(screen.queryByText('Carl Diaz')).toBeNull();
    expect(screen.queryByText('Vera Inspector · visitor')).toBeNull();
    const ben = member(muster, 'Ben Avila');
    await fireEvent.press(screen.getByTestId(`muster-seen-${ben.member_id}`));
    await waitFor(() => expect(member(muster, 'Ben Avila').status).toBe('VERIFIED_ACCOUNTED'));
    // Seen people leave the default "Not seen yet" list; "Everyone" shows the server status.
    await waitFor(() => expect(screen.queryByTestId(`muster-member-${ben.member_id}`)).toBeNull());
    await fireEvent.press(screen.getByTestId('foreman-muster-filter-ALL'));
    expect(screen.getByTestId(`muster-status-${ben.member_id}`).props.children).toBe(
      'Seen at the assembly point',
    );
    expect(member(muster, 'Carl Diaz').status).toBe('UNACCOUNTED');
  });

  it('kiosk muster mode: an offline badge scan reads "waiting to sync" and counts once after sync', async () => {
    const { owner, projectId, ana } = await site();
    const muster = new FakeSiteMusterApi(owner).seedMuster(projectId);
    const world = staffWorld(owner, projectId, ATTENDANT_USER, 'ATTENDANT');
    owner.projects
      .find((p) => p.id === projectId)
      ?.staff.forEach((entry) => {
        if (entry.userId === ATTENDANT_USER) entry.emergency = false;
      });
    const badge = buildBadgePayload(
      base64UrlDecode(FAKE_BADGE_SECRET),
      DEVICE,
      projectId,
      Math.floor(Date.now() / 1000),
    );
    world.badgeWorkers.set(badge, ana.workerId);
    world.operationsOffline = true;
    signIn(world, true);
    await chooseLanguage('en-US');
    await renderRouter('./app', { initialUrl: `/project/${projectId}/muster` });
    await fireEvent.press(await screen.findByTestId('muster-scan'));
    expect(await screen.findByTestId('kiosk-muster')).toBeTruthy();
    expect(screen.queryByTestId('kiosk-direction')).toBeNull();
    await fireEvent.changeText(screen.getByTestId('kiosk-code'), badge);
    await fireEvent.press(screen.getByTestId('kiosk-record'));
    expect(await screen.findByText('Waiting to sync — not confirmed')).toBeTruthy();
    expect(member(muster, 'Ana Acosta').status).toBe('UNACCOUNTED');

    world.operationsOffline = false;
    await fireEvent.press(screen.getByTestId('sync-status-now'));
    expect(await screen.findByText('Ana Acosta: recorded')).toBeTruthy();
    expect(member(muster, 'Ana Acosta').status).toBe('VERIFIED_ACCOUNTED');
    await fireEvent.press(screen.getByTestId('sync-status-now'));
    const verifies = world.calls.filter((call) => call === 'ingestOperations').length;
    expect(verifies).toBeGreaterThanOrEqual(2); // refused offline, then delivered once
    expect(screen.getAllByTestId('kiosk-scan')).toHaveLength(1);
  });
});

describe('closing the muster', () => {
  it('needs a note and an explicit acknowledgement; the report is shared as text and corrected by appending', async () => {
    const { owner, projectId, ana } = await site();
    stage(owner, ana.id);
    const muster = new FakeSiteMusterApi(owner).seedMuster(projectId);
    const share = jest
      .spyOn(Share, 'share')
      .mockResolvedValue({ action: 'sharedAction', activityType: undefined });
    signIn(staffWorld(owner, projectId, SAFETY_USER, 'SAFETY'), true);
    await chooseLanguage('en-US');
    await renderRouter('./app', { initialUrl: `/project/${projectId}/muster` });
    await fireEvent.press(await screen.findByTestId('muster-close-open'));
    expect(screen.getByTestId('muster-close-unresolved')).toBeTruthy();
    expect(
      screen.getByText('Still not accounted for or unknown: 3. Review them before you close.'),
    ).toBeTruthy();
    await fireEvent.press(screen.getByTestId('muster-close-confirm'));
    expect(await screen.findByText('Write a note (at least 3 characters).')).toBeTruthy();
    await fireEvent.changeText(
      screen.getByTestId('muster-close-note'),
      'Ben and the inspector not found; fire department informed',
    );
    await fireEvent.press(screen.getByTestId('muster-close-confirm'));
    expect(
      await screen.findByText('Confirm that you reviewed the people who are not accounted for.'),
    ).toBeTruthy();
    expect(muster.status).toBe('ACTIVE');
    await fireEvent(screen.getByTestId('muster-close-ack'), 'valueChange', true);
    await fireEvent.press(screen.getByTestId('muster-close-confirm'));

    expect(await screen.findByTestId('muster-report-screen')).toBeTruthy();
    expect(await screen.findByTestId('muster-report-closed')).toBeTruthy();
    expect(muster.status).toBe('CLOSED');
    expect(await screen.findByTestId('muster-report-notice')).toBeTruthy();
    expect(screen.getByTestId('muster-report-note').props.children).toBe(
      'Closing note: Ben and the inspector not found; fire department informed',
    );

    await fireEvent.press(screen.getByTestId('muster-report-share'));
    const message = (share.mock.calls[0]?.[0] as { message: string }).message;
    expect(message).toContain('Supplemental headcount record, not a certified life-safety record.');
    expect(message).toContain('Not accounted for or unknown at close: 3');
    expect(message).toContain('- Ben Avila (Acme Concrete): Not accounted for');
    expect(message).toContain('- Vera Inspector (City Inspections): Not accounted for');

    await fireEvent.press(screen.getByTestId('muster-amend-open'));
    await fireEvent.press(
      screen.getByTestId(`muster-amend-person-${member(muster, 'Ben Avila').member_id}`),
    );
    await fireEvent.changeText(
      screen.getByTestId('muster-amend-note'),
      'Ben was found at the gate at 10:40',
    );
    await fireEvent.press(screen.getByTestId('muster-amend-send'));
    expect(await screen.findByText('Correction added.')).toBeTruthy();
    expect(await screen.findByText('Ben was found at the gate at 10:40')).toBeTruthy();
    expect(muster.amendments).toHaveLength(1);
    // The report itself is unchanged: Ben's final status at close stays as it was.
    expect(member(muster, 'Ben Avila').status).toBe('UNACCOUNTED');
    share.mockRestore();
  });
});
