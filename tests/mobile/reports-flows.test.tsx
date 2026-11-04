import { describe, expect, it, jest } from '@jest/globals';
import { File } from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';
import * as Sharing from 'expo-sharing';
import { fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';

import {
  addDays,
  formatLocalDate,
  parseLocalDate,
  zonedToUtc,
  type ReportView,
} from '@sitemuster/shared';

import { formatLocalDateLabel, recentLocalDates, weekStarts } from '../../src/reports/format';
import { FakeSiteMusterApi, FakeWorld } from '../support/fake-api';
import { access, fakeBackend } from '../support/fake-auth';

/**
 * Screen flows for Milestone 10 on the real `app/` routes: staff read the company report and issue
 * a corrected version, the foreman disputes or asks for a correction (reason required, late answers
 * refused), staff approve or reject requests (approval travels with the manual correction), the
 * worker sees only their own estimated hours, shares a CSV labelled "not payroll" in their
 * language and asks for a correction; kiosk access for a foreman needs a reason. The server rules
 * are tested in pgTAP 027, the Edge core tests and the backend tests.
 */
type Globals = typeof globalThis & { __fakeAuthBackend?: unknown };

jest.mock('../../src/auth/create-gateway', () => ({
  createAuthBackend: () => (globalThis as Globals).__fakeAuthBackend ?? null,
}));

const FOREMAN_USER = '88888888-8888-4888-8888-888888888888';
const WORKER_USER = '99999999-9999-4999-8999-999999999999';
const COMPANY = '0c000000-0000-4000-8000-0000000000a1';
const ANA = '4f000000-0000-4000-8000-000000000001';
const BEN = '4f000000-0000-4000-8000-000000000002';
const S_ANA = '5e000000-0000-4000-8000-000000000001';
const S_BEN = '5e000000-0000-4000-8000-000000000002';
const TZ = 'America/Chicago';

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

async function site() {
  const owner = new FakeWorld(
    access({ email_verified: true, phone_verified: false }),
    'owner@example.test',
  );
  const orgId = owner.addOrganization('Gulf Coast Builders');
  const ownerApi = new FakeSiteMusterApi(owner);
  const projectId = await ownerApi.seedProject(orgId);
  await ownerApi.setStatus(projectId, 'ACTIVE', null);
  return { owner, projectId };
}

const at = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(zonedToUtc(parseLocalDate(date), (h ?? 0) * 60 + (m ?? 0), TZ))
    .toISOString()
    .replace('.000Z', 'Z');
};

const line = (id: string, date: string, from: string, to: string, hours: number) => ({
  session_id: id,
  start_at: at(date, from),
  end_at: at(date, to),
  end_latest_at: null,
  start_source: 'FOREMAN',
  end_source: 'FOREMAN',
  status: 'CLOSED',
  witnessed: true,
  definite_seconds: hours * 3600,
  uncertain_seconds: 0,
  pending_approval_seconds: 0,
  needs_review: false,
  corrected: false,
});

/** Yesterday's (project clock) report for Acme: Ana 8 h, Ben 9 h, due in a day. */
function seedReport(world: FakeWorld, projectId: string): ReportView {
  const date = recentLocalDates(TZ, Date.now(), 2)[1] as string;
  const report: ReportView = {
    report_id: '7e000000-0000-4000-8000-000000000001',
    project_id: projectId,
    project_name: 'Main Street Tower',
    company_id: COMPANY,
    company_name: 'Acme Concrete',
    local_date: date,
    version: 1,
    status: 'PENDING_CONFIRMATION',
    due_at: new Date(world.now + 86_400_000).toISOString(),
    generated_at: new Date(world.now - 3_600_000).toISOString(),
    can_answer: false,
    summary: {
      time_zone: TZ,
      workers: [
        {
          worker_id: ANA,
          definite_seconds: 8 * 3600,
          uncertain_seconds: 0,
          pending_approval_seconds: 0,
          needs_review: false,
          sessions: [line(S_ANA, date, '07:00', '15:00', 8)],
        },
        {
          worker_id: BEN,
          definite_seconds: 9 * 3600,
          uncertain_seconds: 0,
          pending_approval_seconds: 0,
          needs_review: false,
          sessions: [line(S_BEN, date, '07:00', '16:00', 9)],
        },
      ],
      totals: {
        workers: 2,
        definite_seconds: 17 * 3600,
        uncertain_seconds: 0,
        pending_approval_seconds: 0,
        sessions_needing_review: 0,
        peak_estimated_count: 2,
      },
    },
    worker_names: { [ANA]: 'Ana Acosta', [BEN]: 'Ben Avila' },
    answers: [],
    earlier_versions: [],
  };
  world.reports.push(report);
  return report;
}

function foremanWorld(owner: FakeWorld, projectId: string) {
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
  return world;
}

describe('daily company reports (staff)', () => {
  it('shows yesterday by company with the estimate notice; a corrected version keeps the first one', async () => {
    const { owner, projectId } = await site();
    seedReport(owner, projectId);
    signIn(owner, true);
    await chooseLanguage('en-US');
    await renderRouter('./app', { initialUrl: `/project/${projectId}` });
    await fireEvent.press(await screen.findByTestId('open-reports'));
    expect(await screen.findByTestId(`report-${COMPANY}`)).toBeTruthy();
    expect(screen.getByTestId('reports-notice')).toBeTruthy();
    expect(screen.getByTestId(`report-total-${COMPANY}`).props.children).toBe(
      '2 workers · 17.00 estimated hours · most at once: 2',
    );
    expect(screen.getByTestId(`report-status-${COMPANY}`).props.children).toBe(
      'Waiting for foreman',
    );
    expect(screen.getByText('Ben Avila · 9.00 h')).toBeTruthy();

    await fireEvent.press(screen.getByTestId(`reissue-${COMPANY}`));
    await fireEvent.press(screen.getByTestId(`reissue-confirm-${COMPANY}`));
    expect(await screen.findByText('Write a reason (at least 3 characters).')).toBeTruthy();
    await fireEvent.changeText(
      screen.getByTestId(`reissue-reason-${COMPANY}`),
      'Ben left at noon (approved)',
    );
    await fireEvent.press(screen.getByTestId(`reissue-confirm-${COMPANY}`));
    expect(await screen.findByText('Version 2', { exact: false })).toBeTruthy();
    expect(screen.getByTestId(`report-earlier-${COMPANY}`).props.children).toBe(
      'Earlier versions: v1 Replaced by a newer version',
    );
    expect(owner.reports.map((r) => [r.version, r.status])).toEqual([
      [1, 'SUPERSEDED'],
      [2, 'PENDING_CONFIRMATION'],
    ]);
  });

  it('an unanswered report past its deadline reads "Not confirmed", never confirmed', async () => {
    const { owner, projectId } = await site();
    const report = seedReport(owner, projectId);
    report.due_at = new Date(owner.now - 60_000).toISOString();
    signIn(owner, true);
    await chooseLanguage('es-US');
    await renderRouter('./app', { initialUrl: `/project/${projectId}/reports` });
    expect(await screen.findByTestId(`report-status-${COMPANY}`)).toBeTruthy();
    expect(screen.getByTestId(`report-status-${COMPANY}`).props.children).toBe(
      'Sin confirmar (no respondió a tiempo)',
    );
  });
});

describe('foreman answers', () => {
  it('a dispute needs a reason; once sent the report leaves the list and the report itself is unchanged', async () => {
    const { owner, projectId } = await site();
    const report = seedReport(owner, projectId);
    const before = JSON.stringify(report.summary);
    signIn(foremanWorld(owner, projectId), false);
    await chooseLanguage('en-US');
    await renderRouter('./app', { initialUrl: '/worker/home' });
    await fireEvent.press(await screen.findByTestId('foreman-reports-open'));
    expect(await screen.findByTestId(`report-${COMPANY}`)).toBeTruthy();
    // Which project and work day this answer is for (review on PR #10).
    expect(screen.getByTestId(`report-context-${report.report_id}`).props.children).toBe(
      `Main Street Tower · ${formatLocalDateLabel(report.local_date, 'en-US')}`,
    );
    await fireEvent.press(screen.getByTestId(`answer-mode-${report.report_id}-DISPUTE`));
    await fireEvent.press(screen.getByTestId(`answer-send-${report.report_id}`));
    expect(await screen.findByText('Write what is wrong (at least 3 characters).')).toBeTruthy();
    expect(owner.answers).toHaveLength(0);
    await fireEvent.changeText(
      screen.getByTestId(`answer-reason-${report.report_id}`),
      'Ben left at noon',
    );
    await fireEvent.press(screen.getByTestId(`answer-send-${report.report_id}`));
    expect(await screen.findByTestId('answer-done')).toBeTruthy();
    expect(screen.getByText(/Disputed by foreman/)).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId(`report-${COMPANY}`)).toBeNull());
    expect(owner.answers.map((a) => a.action)).toEqual(['DISPUTE']);
    expect(JSON.stringify(report.summary)).toBe(before);
  });

  it('a correction names the visit and the right time; it becomes a request staff decide', async () => {
    const { owner, projectId } = await site();
    const report = seedReport(owner, projectId);
    signIn(foremanWorld(owner, projectId), false);
    await chooseLanguage('en-US');
    await renderRouter('./app', { initialUrl: '/foreman/reports' });
    await screen.findByTestId(`report-${COMPANY}`);
    await fireEvent.press(screen.getByTestId(`answer-mode-${report.report_id}-SUBMIT_CORRECTION`));
    await fireEvent.press(screen.getByTestId(`answer-visit-${report.report_id}-${BEN}|${S_BEN}`));
    await fireEvent.changeText(screen.getByTestId(`answer-end-${report.report_id}`), '12:00');
    await fireEvent.changeText(
      screen.getByTestId(`answer-reason-${report.report_id}`),
      'Ben left at noon',
    );
    await fireEvent.press(screen.getByTestId(`answer-send-${report.report_id}`));
    expect(await screen.findByTestId('answer-done')).toBeTruthy();
    expect(owner.correctionRequests).toEqual([
      expect.objectContaining({
        channel: 'FOREMAN_REQUEST',
        worker_id: BEN,
        session_id: S_BEN,
        status: 'PENDING',
        proposed: expect.objectContaining({ proposed_end_at: at(report.local_date, '12:00') }),
      }),
    ]);
  });

  it('a departure-only fix on a night shift lands on the next day (review on PR #10)', async () => {
    const { owner, projectId } = await site();
    const report = seedReport(owner, projectId);
    const next = formatLocalDate(addDays(parseLocalDate(report.local_date), 1));
    const ben = report.summary.workers[1];
    if (ben?.sessions[0]) {
      ben.sessions[0] = {
        ...ben.sessions[0],
        start_at: at(report.local_date, '22:00'),
        end_at: at(next, '06:00'),
      };
    }
    signIn(foremanWorld(owner, projectId), false);
    await chooseLanguage('en-US');
    await renderRouter('./app', { initialUrl: '/foreman/reports' });
    await screen.findByTestId(`report-${COMPANY}`);
    await fireEvent.press(screen.getByTestId(`answer-mode-${report.report_id}-SUBMIT_CORRECTION`));
    await fireEvent.press(screen.getByTestId(`answer-visit-${report.report_id}-${BEN}|${S_BEN}`));
    await fireEvent.changeText(screen.getByTestId(`answer-end-${report.report_id}`), '07:00');
    await fireEvent.changeText(
      screen.getByTestId(`answer-reason-${report.report_id}`),
      'Ben stayed an hour longer',
    );
    await fireEvent.press(screen.getByTestId(`answer-send-${report.report_id}`));
    expect(await screen.findByTestId('answer-done')).toBeTruthy();
    expect(owner.correctionRequests[0]?.proposed.proposed_end_at).toBe(at(next, '07:00'));
  });

  it('a reason longer than 1,000 characters cannot be typed', async () => {
    const { owner, projectId } = await site();
    const report = seedReport(owner, projectId);
    signIn(foremanWorld(owner, projectId), false);
    await chooseLanguage('en-US');
    await renderRouter('./app', { initialUrl: '/foreman/reports' });
    await screen.findByTestId(`report-${COMPANY}`);
    await fireEvent.press(screen.getByTestId(`answer-mode-${report.report_id}-DISPUTE`));
    expect(screen.getByTestId(`answer-reason-${report.report_id}`).props.maxLength).toBe(1000);
  });

  it('after the deadline the answer is refused with a clear message', async () => {
    const { owner, projectId } = await site();
    const report = seedReport(owner, projectId);
    signIn(foremanWorld(owner, projectId), false);
    await chooseLanguage('en-US');
    await renderRouter('./app', { initialUrl: '/foreman/reports' });
    await screen.findByTestId(`report-${COMPANY}`);
    report.due_at = new Date(owner.now - 1).toISOString(); // the deadline passes while open
    await fireEvent.press(screen.getByTestId(`confirm-${report.report_id}`));
    expect(
      await screen.findByText(
        'The deadline passed. The report is now not confirmed; site staff can issue a new version.',
      ),
    ).toBeTruthy();
    expect(report.status).toBe('NOT_CONFIRMED');
  });
});

describe('correction requests (staff)', () => {
  function seedRequest(owner: FakeWorld) {
    owner.correctionRequests.push({
      request_id: 'ce000000-0000-4000-8000-000000000001',
      worker_id: BEN,
      worker_name: 'Ben Avila',
      company_name: 'Acme Concrete',
      channel: 'FOREMAN_REQUEST',
      session_id: S_BEN,
      original: { start_at: '2026-11-03T13:00:00Z', end_at: '2026-11-03T22:00:00Z' },
      proposed: { proposed_start_at: null, proposed_end_at: '2026-11-03T18:00:00Z', note: null },
      reason: 'Ben left at noon',
      status: 'PENDING',
      decision_reason: null,
      created_at: '2026-11-04T14:00:00Z',
      decided_at: null,
    });
  }

  it('rejecting needs a reason the worker can read', async () => {
    const { owner, projectId } = await site();
    seedRequest(owner);
    signIn(owner, true);
    await chooseLanguage('en-US');
    await renderRouter('./app', { initialUrl: `/project/${projectId}/requests` });
    const id = 'ce000000-0000-4000-8000-000000000001';
    expect(await screen.findByTestId(`request-${id}`)).toBeTruthy();
    expect(screen.getByText('Asked for: departure 2026-11-03 12:00')).toBeTruthy();
    expect(screen.getByText('Recorded: 2026-11-03 07:00 – 16:00')).toBeTruthy();
    await fireEvent.press(screen.getByTestId(`reject-${id}`));
    await fireEvent.press(screen.getByTestId(`reject-confirm-${id}`));
    expect(await screen.findByText('Write a reason (at least 3 characters).')).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId(`reject-reason-${id}`), 'Gate log shows 4 pm');
    await fireEvent.press(screen.getByTestId(`reject-confirm-${id}`));
    expect(await screen.findByText('Rejected: Gate log shows 4 pm')).toBeTruthy();
  });

  it('approving opens the manual correction filled in; the approval travels with it', async () => {
    const { owner, projectId } = await site();
    seedRequest(owner);
    owner.correctable.set(`${projectId}|${BEN}`, [
      {
        session_id: S_BEN,
        start_at: '2026-11-03T13:00:00Z',
        end_at: '2026-11-03T22:00:00Z',
        status: 'CLOSED',
        start_source: 'FOREMAN',
        end_source: 'FOREMAN',
      },
    ]);
    signIn(owner, true);
    await chooseLanguage('en-US');
    await renderRouter('./app', { initialUrl: `/project/${projectId}/requests` });
    const id = 'ce000000-0000-4000-8000-000000000001';
    await fireEvent.press(await screen.findByTestId(`approve-${id}`));
    expect(await screen.findByTestId('correct-from-request')).toBeTruthy();
    expect(screen.getByTestId('correct-date').props.value).toBe('2026-11-03');
    expect(screen.getByTestId('correct-end').props.value).toBe('12:00');
    await fireEvent.changeText(screen.getByTestId('correct-reason'), 'Approved foreman request');
    await fireEvent.press(screen.getByTestId('correct-submit'));
    expect(await screen.findByText('Recorded')).toBeTruthy();
    expect(owner.correctionRequests[0]?.status).toBe('APPROVED');
  });
});

describe("the worker's own hours", () => {
  /** Two visits last week (Monday 8 h, Tuesday 7 h 30) for the signed-in worker only. */
  async function workerSite(locale: 'en-US' | 'es-US') {
    const { owner, projectId } = await site();
    const enrollment = owner.addEnrollment(projectId, 'Wanda Worker', 'APPROVED', WORKER_USER);
    const monday = weekStarts(TZ, Date.now()).previous;
    const tuesday = formatLocalDate(addDays(parseLocalDate(monday), 1));
    const session = (id: string, date: string, from: string, to: string) => ({
      id,
      projectId,
      workerId: enrollment.workerId,
      status: 'CLOSED' as const,
      startAt: at(date, from),
      startSource: 'KIOSK_DYNAMIC_BADGE' as const,
      startConfidence: 'HIGH' as const,
      endAt: at(date, to),
      endSource: 'KIOSK_DYNAMIC_BADGE' as const,
      endEarliestAt: null,
      endLatestAt: null,
      configVersionId: 'cv-1',
      timezone: TZ,
      lastSeenAt: at(date, to),
      lastConfirmedInsideAt: at(date, to),
      closeoutAt: at(date, '23:00'),
      authorizeAt: null,
      authorizedCloseoutAt: null,
      windowStartAt: null,
      windowEndAt: null,
      unscheduled: false,
      unscheduledUntil: null,
      overtimeApprovedAt: null,
      overtimeApprovedBy: null,
      witnessed: true,
      gaps: [],
      reviewReasons: [],
      unresolvedAt: null,
      openedByEvent: id,
      employerSnapshotId: COMPANY,
    });
    const world = new FakeWorld(
      access({ user_id: WORKER_USER, worker_profile_id: enrollment.workerId }),
      '+15555550123',
      owner,
    );
    world.attendance.set(projectId, {
      project: { id: projectId, name: 'Main Street Tower', time_zone: TZ },
      configs: [{ config_version_id: 'cv-1', presence_unknown_seconds: 1200 }],
      sessions: [
        session('5e000000-0000-4000-8000-0000000000a1', monday, '07:00', '15:00'),
        session('5e000000-0000-4000-8000-0000000000a2', tuesday, '07:00', '14:30'),
      ],
      requests: [],
    });
    signIn(world, false);
    await chooseLanguage(locale);
    return { owner, world, projectId, monday };
  }

  const csvWritten = () => {
    const instances = (File as unknown as jest.Mock).mock.results;
    const file = instances[instances.length - 1]?.value as { write: jest.Mock };
    return String(file.write.mock.calls[0]?.[0] ?? '');
  };

  it('daily and weekly estimated hours; the CSV says "not payroll" and holds only own visits', async () => {
    const { monday } = await workerSite('en-US');
    await renderRouter('./app', { initialUrl: '/worker/history' });
    expect(await screen.findByTestId('hours-notice')).toBeTruthy();
    await fireEvent.press(await screen.findByTestId('hours-week-previous'));
    expect(await screen.findByText('Week total: 15.50 h (estimated)')).toBeTruthy();
    expect(screen.getByTestId(`hours-day-${monday}`)).toBeTruthy();
    await fireEvent.press(screen.getByTestId('hours-share'));
    await waitFor(() => expect(Sharing.shareAsync).toHaveBeenCalled());
    const csv = csvWritten();
    expect(
      csv.startsWith(
        '﻿Date,Project,Arrival,Departure,Estimated onsite hours (not payroll),Status\r\n',
      ),
    ).toBe(true);
    expect(csv).toContain(`${monday},Main Street Tower,07:00,15:00,8.00,Recorded`);
    expect(csv.trim().split('\r\n')).toHaveLength(3);
    expect(csv).not.toMatch(/Ana|Ben|Acme/);
  });

  it('Spanish headers in the CSV', async () => {
    await workerSite('es-US');
    await renderRouter('./app', { initialUrl: '/worker/history' });
    await fireEvent.press(await screen.findByTestId('hours-week-previous'));
    await screen.findByText('Total de la semana: 15.50 h (estimado)');
    await fireEvent.press(screen.getByTestId('hours-share'));
    await waitFor(() => expect(Sharing.shareAsync).toHaveBeenCalled());
    expect(csvWritten()).toContain(
      'Fecha,Proyecto,Llegada,Salida,Horas estimadas en obra (no es nómina),Estado',
    );
  });

  it('asks for a correction of one visit; the request shows as waiting', async () => {
    const { owner, monday } = await workerSite('en-US');
    await renderRouter('./app', { initialUrl: '/worker/history' });
    await fireEvent.press(await screen.findByTestId('hours-week-previous'));
    await screen.findByText('Week total: 15.50 h (estimated)');
    await fireEvent.press(screen.getByTestId('hours-request-open'));
    await fireEvent.press(
      screen.getByTestId('hours-request-target-5e000000-0000-4000-8000-0000000000a1'),
    );
    // An existing visit keeps its own date: no date to type (review on PR #10).
    expect(screen.queryByTestId('hours-request-date')).toBeNull();
    await fireEvent.changeText(screen.getByTestId('hours-request-end'), '16:00');
    await fireEvent.press(screen.getByTestId('hours-request-send'));
    expect(
      await screen.findByText('Check the date (YYYY-MM-DD), times (HH:MM) and reason.'),
    ).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId('hours-request-reason'), 'I stayed until 4 pm');
    await fireEvent.press(screen.getByTestId('hours-request-send'));
    expect(await screen.findByTestId('hours-request-sent')).toBeTruthy();
    expect(owner.correctionRequests).toEqual([
      expect.objectContaining({
        channel: 'WORKER_REQUEST',
        status: 'PENDING',
        reason: 'I stayed until 4 pm',
      }),
    ]);
    expect(owner.correctionRequests[0]?.proposed.proposed_end_at).toBe(
      new Date(Date.parse(at(monday, '16:00'))).toISOString(),
    );
    expect(await screen.findByText('Waiting · I stayed until 4 pm')).toBeTruthy();
  });
});

describe('foreman kiosk access', () => {
  it('needs a reason; the superintendent turns it on and off', async () => {
    const { owner, projectId } = await site();
    owner.kioskGrants.set(projectId, [
      {
        foreman_profile_id: 'w-foreman',
        name: 'Fernando Alvarez',
        company_id: COMPANY,
        company_name: 'Acme Concrete',
        can_operate_kiosk: false,
      },
    ]);
    signIn(owner, true);
    await chooseLanguage('en-US');
    await renderRouter('./app', { initialUrl: `/project/${projectId}` });
    await fireEvent.press(await screen.findByTestId('open-foremen'));
    expect(await screen.findByTestId('grant-w-foreman')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('grant-toggle-w-foreman'));
    expect(await screen.findByText('Write a reason (at least 3 characters).')).toBeTruthy();
    await fireEvent.changeText(
      screen.getByTestId('grant-reason-w-foreman'),
      'Scans his crew at gate 2',
    );
    await fireEvent.press(screen.getByTestId('grant-toggle-w-foreman'));
    await waitFor(() =>
      expect(screen.getByTestId('grant-state-w-foreman').props.children).toBe(
        'Can run the kiosk for their crew',
      ),
    );
  });
});
