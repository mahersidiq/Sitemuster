import { describe, expect, it, jest } from '@jest/globals';
import * as SecureStore from 'expo-secure-store';
import * as Sharing from 'expo-sharing';
import { fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';

import { base64UrlDecode, buildBadgePayload, rotatingOrientationCode } from '@sitemuster/shared';

import {
  FAKE_BADGE_SECRET,
  FAKE_ROTATING_SECRET,
  FakeSiteMusterApi,
  FakeWorld,
} from '../support/fake-api';
import { access, fakeBackend } from '../support/fake-auth';

/**
 * Screen flows for Milestone 05 on the real `app/` routes with the typed API double. Database
 * rules are proven in supabase/tests/database/021_orientation_badges.test.sql and end to end in
 * tests/backend/orientation-flow.test.ts.
 */
type Globals = typeof globalThis & { __fakeAuthBackend?: unknown; __cameraGranted?: boolean };

jest.mock('../../src/auth/create-gateway', () => ({
  createAuthBackend: () => (globalThis as Globals).__fakeAuthBackend ?? null,
}));

const WORKER_USER = '66666666-6666-4666-8666-666666666666';

function signIn(world: FakeWorld, staff: boolean) {
  const api = new FakeSiteMusterApi(world);
  const backend = fakeBackend(() => world.access, api);
  backend.gateway.session = { destination: world.email };
  backend.gateway.aal = staff ? 'aal2' : 'aal1';
  backend.gateway.factors = staff ? ['factor-1'] : [];
  (globalThis as Globals).__fakeAuthBackend = backend;
  return api;
}

/** Owner with an ACTIVE project and an open orientation session. */
async function siteWithSession() {
  const owner = new FakeWorld(
    access({ email_verified: true, phone_verified: false }),
    'owner@example.test',
  );
  const orgId = owner.addOrganization('Gulf Coast Builders');
  const ownerApi = new FakeSiteMusterApi(owner);
  const projectId = await ownerApi.seedProject(orgId);
  await ownerApi.setStatus(projectId, 'ACTIVE', null);
  const session = await ownerApi.startOrientation(projectId, 'k');
  return { owner, ownerApi, projectId, session };
}

function workerWorld(owner: FakeWorld) {
  return new FakeWorld(access({ user_id: WORKER_USER }), '+15555550123', owner);
}

async function chooseLanguage(locale: 'en-US' | 'es-US') {
  await SecureStore.setItemAsync('sitemuster.locale.v1', locale);
}

describe('worker joins by orientation code', () => {
  it('reads the draft notice, joins and stays waiting for approval', async () => {
    const { owner, session, projectId } = await siteWithSession();
    const worker = workerWorld(owner);
    signIn(worker, false);
    await chooseLanguage('en-US');
    await renderRouter('./app', { initialUrl: '/' });
    expect(await screen.findByTestId('join-screen')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('join-type'));
    await fireEvent.changeText(await screen.findByTestId('join-code-input'), 'hello');
    await fireEvent.press(screen.getByTestId('join-code-submit'));
    expect(await screen.findByText('That is not a SiteMuster orientation code.')).toBeTruthy();
    await fireEvent.changeText(
      screen.getByTestId('join-code-input'),
      `SMS1.${session.session_id}.${session.static_code}`,
    );
    await fireEvent.press(screen.getByTestId('join-code-submit'));

    expect(await screen.findByText('Main Street Tower')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('join-next'));
    expect(await screen.findByText('Enter a project name.')).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId('details-name'), 'Ana Worker');
    await fireEvent.changeText(screen.getByTestId('details-company-name'), 'Acme Drywall');
    await fireEvent.press(screen.getByTestId('join-next'));
    expect(
      await screen.findByText('Enter an emergency contact name and phone number.'),
    ).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId('details-emergency-name'), 'Luis Worker');
    await fireEvent.changeText(screen.getByTestId('details-emergency-phone'), '+1 555 000 2222');
    await fireEvent.press(screen.getByTestId('join-next'));

    expect(await screen.findByTestId('notice-draft')).toBeTruthy();
    expect(
      screen.getByText('DRAFT notice: this project keeps an estimated attendance record.'),
    ).toBeTruthy();
    expect(screen.getByTestId('join-submit').props.accessibilityState).toMatchObject({
      disabled: true,
    });
    await fireEvent(screen.getByTestId('join-acknowledge'), 'valueChange', true);
    await fireEvent.press(screen.getByTestId('join-submit'));
    expect(await screen.findByTestId('join-done')).toBeTruthy();
    expect(worker.enrollments).toEqual([
      expect.objectContaining({
        projectId,
        status: 'PENDING',
        employer: 'PENDING_CONFIRMATION',
        consent: 'DIGITAL',
      }),
    ]);

    await fireEvent.press(screen.getByTestId('join-home'));
    expect(await screen.findByTestId(`enrollment-status-${projectId}`)).toBeTruthy();
    expect(screen.getByText('Waiting for approval')).toBeTruthy();
    expect(screen.queryByTestId(`show-badge-${projectId}`)).toBeNull();
  });

  it('shows the Spanish notice and Spanish errors', async () => {
    const { owner, ownerApi, session } = await siteWithSession();
    signIn(workerWorld(owner), false);
    await chooseLanguage('es-US');
    await renderRouter('./app', {
      initialUrl: `/join/form?code=SMS1.${session.session_id}.${session.static_code}`,
    });
    expect(await screen.findByText('Unirse al proyecto')).toBeTruthy();
    await fireEvent.changeText(await screen.findByTestId('details-name'), 'Ana Trabajadora');
    await fireEvent.changeText(screen.getByTestId('details-company-name'), 'Concretos del Sur');
    await fireEvent.changeText(screen.getByTestId('details-emergency-name'), 'Luis');
    await fireEvent.changeText(screen.getByTestId('details-emergency-phone'), '+15550002222');
    await fireEvent.press(screen.getByTestId('join-next'));
    expect(
      await screen.findByText(
        'Aviso BORRADOR: este proyecto lleva un registro estimado de asistencia.',
      ),
    ).toBeTruthy();
    await ownerApi.closeOrientation(session.project_id, session.session_id);
    await fireEvent(screen.getByTestId('join-acknowledge'), 'valueChange', true);
    await fireEvent.press(screen.getByTestId('join-submit'));
    expect(
      await screen.findByText(
        'Esta sesión de orientación terminó. Pida al supervisor que inicie una nueva.',
      ),
    ).toBeTruthy();
  });

  it('falls back to typing the code when the camera is not allowed', async () => {
    (globalThis as Globals).__cameraGranted = false;
    const { owner } = await siteWithSession();
    signIn(workerWorld(owner), false);
    await chooseLanguage('en-US');
    await renderRouter('./app', { initialUrl: '/join/scan' });
    expect(await screen.findByTestId('camera-needed')).toBeTruthy();
    expect(screen.queryByTestId('join-camera')).toBeNull();
    expect(screen.getByTestId('join-code-input')).toBeTruthy();
  });
});

describe('staff orientation and approvals', () => {
  it('shows a rotating QR computed on the phone and a printable QR, then ends the session', async () => {
    const { owner, projectId } = await siteWithSession();
    signIn(owner, true);
    await chooseLanguage('en-US');
    await renderRouter('./app', { initialUrl: `/project/${projectId}/orientation` });
    const rotating = await screen.findByTestId('qr-value');
    const sessionId = owner.sessions.at(-1)?.session_id ?? '';
    const expected = rotatingOrientationCode(
      base64UrlDecode(FAKE_ROTATING_SECRET),
      sessionId,
      Math.floor(Date.now() / 1000),
    );
    expect(String(rotating.props.children).split('.').slice(0, 2)).toEqual(
      expected.split('.').slice(0, 2),
    );
    expect(String(rotating.props.children)).toMatch(/^SMO1\./);
    await fireEvent.press(screen.getByTestId('orientation-mode-PRINTED'));
    expect(String((await screen.findByTestId('qr-value')).props.children)).toBe(
      `SMS1.${sessionId}.${'S'.repeat(43)}`,
    );
    await fireEvent.press(screen.getByTestId('orientation-share'));
    await waitFor(() =>
      expect(Sharing.shareAsync).toHaveBeenCalledWith(
        'file:///cache/qr.png',
        expect.objectContaining({ mimeType: 'image/png' }),
      ),
    );
    expect(
      screen.getByText(
        'Scanning a QR never approves anyone. You approve workers in Workers and approvals.',
      ),
    ).toBeTruthy();
    await fireEvent.press(screen.getByTestId('orientation-close'));
    expect(await screen.findByTestId('orientation-start')).toBeTruthy();
    expect(owner.sessions.every((s) => !s.open)).toBe(true);
  });

  it('approves selected workers with a result per person and confirms the employer separately', async () => {
    const { owner, projectId } = await siteWithSession();
    const ana = owner.addEnrollment(projectId, 'Ana Worker');
    const luis = owner.addEnrollment(projectId, 'Luis Worker');
    owner.addEnrollment(projectId, 'Pedro Approved', 'APPROVED');
    signIn(owner, true);
    await chooseLanguage('en-US');
    await renderRouter('./app', { initialUrl: `/project/${projectId}/workers` });
    expect(await screen.findByText('Waiting for approval (2)')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('select-all'));
    await fireEvent.press(screen.getByTestId('approve-selected'));
    expect(await screen.findByText('Ana Worker: approved')).toBeTruthy();
    expect(screen.getByText('Luis Worker: approved')).toBeTruthy();
    expect(owner.enrollments.filter((e) => e.status === 'APPROVED')).toHaveLength(3);
    expect(ana.employer).toBe('PENDING_CONFIRMATION');

    await fireEvent(await screen.findByTestId(`select-${luis.id}`), 'valueChange', true);
    await fireEvent.press(screen.getByTestId('confirm-employer-selected'));
    expect(await screen.findByText('Luis Worker: employer confirmed')).toBeTruthy();
    expect(luis.employer).toBe('VERIFIED');
    expect(ana.employer).toBe('PENDING_CONFIRMATION');
  });

  it('requires a reason to reject and adds a supervised no-phone worker as pending', async () => {
    const { owner, projectId } = await siteWithSession();
    const pending = owner.addEnrollment(projectId, 'Duplicate Person');
    signIn(owner, true);
    await chooseLanguage('en-US');
    await renderRouter('./app', { initialUrl: `/project/${projectId}/workers` });
    await fireEvent.press(await screen.findByTestId(`reject-${pending.id}`));
    await fireEvent.press(screen.getByTestId('confirm-reject'));
    expect(await screen.findByText('Enter a short reason (at least 3 characters).')).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId('reject-reason'), 'Same person twice');
    await fireEvent.press(screen.getByTestId('confirm-reject'));
    await waitFor(() => expect(pending.status).toBe('REJECTED'));

    await fireEvent.press(screen.getByTestId('add-no-phone'));
    expect(await screen.findByTestId('add-worker-screen')).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId('details-name'), 'Pedro Sin Telefono');
    await fireEvent.press(
      await screen.findByTestId(`details-company-${owner.companies[0]?.id ?? ''}`),
    );
    await fireEvent.changeText(screen.getByTestId('details-emergency-name'), 'Maria');
    await fireEvent.changeText(screen.getByTestId('details-emergency-phone'), '+15550003333');
    expect(
      await screen.findByText(
        'Aviso BORRADOR: este proyecto lleva un registro estimado de asistencia.',
      ),
    ).toBeTruthy();
    expect(screen.getByTestId('add-worker-submit').props.accessibilityState).toMatchObject({
      disabled: true,
    });
    await fireEvent(screen.getByTestId('add-worker-ack'), 'valueChange', true);
    await fireEvent.press(screen.getByTestId('add-worker-submit'));
    expect(await screen.findByTestId('add-worker-done')).toBeTruthy();
    const managed = owner.workers.find((w) => w.legalName === 'Pedro Sin Telefono');
    expect(managed).toMatchObject({ managed: true, userId: null });
    expect(owner.enrollments.find((e) => e.workerId === managed?.id)).toMatchObject({
      status: 'PENDING',
      consent: 'SUPERVISED',
    });
  });

  it('issues an opaque printed badge once and needs a reason to cancel it', async () => {
    const { owner, projectId } = await siteWithSession();
    const approved = owner.addEnrollment(projectId, 'Pedro Approved', 'APPROVED');
    signIn(owner, true);
    await chooseLanguage('en-US');
    await renderRouter('./app', {
      initialUrl: `/project/${projectId}/printed-badge?workerId=${approved.workerId}&name=Pedro`,
    });
    await fireEvent.press(await screen.findByTestId('printed-badge-issue'));
    expect(String((await screen.findByTestId('qr-value')).props.children)).toMatch(
      /^SMP1\.[A-Za-z0-9_-]{32}$/,
    );
    await fireEvent.press(screen.getByTestId('printed-badge-revoke'));
    expect(await screen.findByText('Enter a short reason (at least 3 characters).')).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId('printed-badge-reason'), 'Badge lost');
    await fireEvent.press(screen.getByTestId('printed-badge-revoke'));
    expect(await screen.findByText('Badge cancelled.')).toBeTruthy();
    expect(owner.printedBadges.every((b) => !b.active)).toBe(true);
  });
});

describe('offline worker badge', () => {
  it('activates the phone once, then shows a 30-second badge without any network call', async () => {
    const { owner, projectId } = await siteWithSession();
    const worker = workerWorld(owner);
    const enrollment = owner.addEnrollment(projectId, 'Ana Worker', 'APPROVED', WORKER_USER);
    worker.access = { ...worker.access, worker_profile_id: enrollment.workerId };
    const api = signIn(worker, false);
    await chooseLanguage('en-US');
    await renderRouter('./app', { initialUrl: '/worker/home' });
    await fireEvent.press(await screen.findByTestId(`show-badge-${projectId}`));
    await fireEvent.press(await screen.findByTestId('badge-activate'));
    const value = String((await screen.findByTestId('qr-value')).props.children);
    const device = worker.device?.device_id ?? '';
    expect(value).toMatch(
      new RegExp(`^SMB1\\.${device}\\.${projectId}\\.\\d+\\.[A-Za-z0-9_-]{22}$`),
    );
    const step = Number(value.split('.')[3]);
    expect(value).toBe(
      buildBadgePayload(base64UrlDecode(FAKE_BADGE_SECRET), device, projectId, step * 30),
    );

    // No signal: every API call fails, the badge still renders from the phone's keystore.
    api.failNext('NETWORK');
    const callsBefore = worker.calls.length;
    await fireEvent.press(screen.getByTestId('badge-back'));
    await fireEvent.press(await screen.findByTestId(`show-badge-${projectId}`));
    expect(String((await screen.findByTestId('qr-value')).props.children)).toMatch(/^SMB1\./);
    expect(worker.calls.slice(callsBefore)).not.toContain('activateDevice');
  });
});
