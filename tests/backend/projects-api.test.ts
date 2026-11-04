import { describe, expect, it } from 'vitest';

import { DEFAULT_WORK_WINDOWS } from '@sitemuster/shared';

import { SupabaseSiteMusterApi } from '../../src/api/supabase-api';
import type { CreateProjectInput } from '../../src/api/types';
import { newClient, uniqueEmail, uniquePhone } from './support/clients';
import { latestSmsCode } from './support/db';
import { staffClient } from './support/staff';

/**
 * The app's real API class (src/api/supabase-api.ts) against the local Supabase stack: proves the
 * RPC names/parameters the screens use match the database, and that refusals surface as stable
 * codes. Authorization itself is covered in depth by pgTAP (020_projects_config).
 */
function projectInput(organizationId: string, overrides: Partial<CreateProjectInput> = {}) {
  return {
    organizationId,
    name: 'E2E Tower',
    projectNumber: 'E2E-1',
    address: '1 Test St, Houston, TX',
    centerLat: 29.76,
    centerLng: -95.37,
    ianaTimezone: 'America/Chicago',
    radiusM: 150,
    operates24x7: false,
    workWindows: [
      ...DEFAULT_WORK_WINDOWS,
      { weekday: 1, local_start_time: '20:00', local_end_time: '04:00' },
    ],
    entryDwellSeconds: 600,
    maxHorizontalAccuracyM: 75,
    idempotencyKey: crypto.randomUUID(),
    ...overrides,
  } satisfies CreateProjectInput;
}

async function ownerWithOrganization() {
  const owner = await staffClient(uniqueEmail('owner'));
  const api = new SupabaseSiteMusterApi(owner.client);
  const orgKey = crypto.randomUUID();
  const org = { name: 'E2E GC', address: '', businessEmail: '', phone: '', idempotencyKey: orgKey };
  const organizationId = await api.createOrganization(org);
  expect(await api.createOrganization(org)).toBe(organizationId);
  return { api, organizationId };
}

describe('project API (app client → PostgREST → Postgres)', () => {
  it('runs GC activation: organization, project v1, overlap check, v2, lifecycle', async () => {
    const { api, organizationId } = await ownerWithOrganization();
    expect((await api.listOrganizations()).map((o) => o.id)).toContain(organizationId);

    const input = projectInput(organizationId);
    const projectId = await api.createProject(input);
    expect(await api.createProject(input)).toBe(projectId);

    const v1 = await api.getProject(projectId);
    expect(v1.project.status).toBe('DRAFT');
    expect(v1.config.version_number).toBe(1);
    expect(v1.config.radius_m).toBe(150);
    expect(v1.config.exit_hysteresis_m).toBe(50);
    expect(v1.config.center_lat).toBeCloseTo(29.76, 6);
    expect(v1.config.settings.work_windows).toContainEqual({
      weekday: 1,
      local_start_time: '20:00',
      local_end_time: '04:00',
      crosses_midnight: true,
    });
    expect(v1.permissions).toEqual({ can_configure: true, can_assign_staff: true });
    expect(v1.staff.map((s) => s.role)).toEqual(['PM']);

    const check = await api.checkSite({
      organizationId,
      name: 'E2E Tower Annex',
      centerLat: 29.7601,
      centerLng: -95.3701,
      radiusM: 150,
    });
    expect(check.overlaps.map((o) => o.project_id)).toContain(projectId);
    expect(check.similar_names.map((o) => o.project_id)).toContain(projectId);

    const change = {
      projectId,
      centerLat: 29.76,
      centerLng: -95.37,
      radiusM: 250,
      operates24x7: false,
      workWindows: [...DEFAULT_WORK_WINDOWS],
      entryDwellSeconds: 600,
      maxHorizontalAccuracyM: 75,
      reason: 'Laydown yard added',
      confirmSensitive: false,
      idempotencyKey: crypto.randomUUID(),
    };
    await expect(api.updateConfig(change)).rejects.toMatchObject({
      code: 'SENSITIVE_CHANGE_REQUIRES_CONFIRMATION',
      detail: 'GEOFENCE_ENLARGED',
    });
    const v2Id = await api.updateConfig({ ...change, confirmSensitive: true });
    expect(await api.updateConfig({ ...change, confirmSensitive: true })).toBe(v2Id);
    const v2 = await api.getProject(projectId);
    expect(v2.config.version_number).toBe(2);
    expect(v2.versions.map((v) => [v.version_number, v.reason])).toEqual([
      [2, 'Laydown yard added'],
      [1, 'Project created'],
    ]);

    await api.setStatus(projectId, 'ACTIVE', null);
    await expect(api.setStatus(projectId, 'ARCHIVED', 'skip ahead')).rejects.toMatchObject({
      code: 'INVALID_STATUS_TRANSITION',
    });
    await expect(api.setStatus(projectId, 'COMPLETED', null)).rejects.toMatchObject({
      code: 'REASON_REQUIRED',
    });
    expect((await api.listProjects()).find((p) => p.id === projectId)).toMatchObject({
      status: 'ACTIVE',
      config_version: 2,
      radius_m: 250,
      iana_timezone: 'America/Chicago',
    });
  });

  it('rejects invalid input with the codes the screens translate', async () => {
    const { api, organizationId } = await ownerWithOrganization();
    await expect(
      api.createProject(projectInput(organizationId, { radiusM: 149 })),
    ).rejects.toMatchObject({
      code: 'RADIUS_OUT_OF_BOUNDS',
    });
    await expect(
      api.createProject(projectInput(organizationId, { ianaTimezone: 'Mars/Base' })),
    ).rejects.toMatchObject({ code: 'INVALID_TIMEZONE' });
    await expect(
      api.createProject(
        projectInput(organizationId, {
          workWindows: [
            { weekday: 1, local_start_time: '20:00', local_end_time: '04:00' },
            { weekday: 2, local_start_time: '03:00', local_end_time: '10:00' },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: 'OVERLAPPING_WORK_WINDOWS' });
  });

  it('delivers an invitation only to the invited verified e-mail', async () => {
    const { api: ownerApi, organizationId } = await ownerWithOrganization();
    const projectId = await ownerApi.createProject(projectInput(organizationId));
    const inviteeEmail = uniqueEmail('super');
    await ownerApi.inviteStaff({
      projectId,
      email: inviteeEmail.toUpperCase(),
      role: 'SUPER',
      emergencyDesignated: true,
      canConfigureProject: false,
      canAssignStaff: false,
      canApproveCorrections: false,
    });
    const pending = await ownerApi.getProject(projectId);
    expect(pending.invitations.map((i) => i.email)).toEqual([inviteeEmail]);

    const outsider = new SupabaseSiteMusterApi((await staffClient(uniqueEmail('outsider'))).client);
    expect(await outsider.myInvitations()).toEqual([]);
    await expect(outsider.getProject(projectId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      outsider.acceptInvitation(pending.invitations[0]?.id ?? crypto.randomUUID()),
    ).rejects.toMatchObject({ code: 'INVITATION_NOT_FOUND' });

    const invitee = new SupabaseSiteMusterApi((await staffClient(inviteeEmail)).client);
    const [invitation] = await invitee.myInvitations();
    expect(invitation).toMatchObject({ project_id: projectId, project_role: 'SUPER' });
    await invitee.acceptInvitation(invitation?.invitation_id ?? '');
    const seen = await invitee.getProject(projectId);
    expect(seen.permissions).toEqual({ can_configure: true, can_assign_staff: false });
    expect(seen.invitations).toEqual([]);
    await expect(invitee.acceptInvitation(invitation?.invitation_id ?? '')).rejects.toMatchObject({
      code: 'INVITATION_NOT_ACTIVE',
    });
  });

  it('gives a worker session no project data and no project creation', async () => {
    const client = newClient();
    const phone = uniquePhone();
    await client.auth.signInWithOtp({ phone });
    await client.auth.verifyOtp({ phone, token: await latestSmsCode(phone), type: 'sms' });
    const worker = new SupabaseSiteMusterApi(client);
    expect(await worker.listProjects()).toEqual([]);
    expect(await worker.listOrganizations()).toEqual([]);
    await expect(worker.createProject(projectInput(crypto.randomUUID()))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});
