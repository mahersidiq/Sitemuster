import { beforeEach, describe, expect, it } from '@jest/globals';
import type { NotificationResponse } from 'expo-notifications';

import type { SiteMusterApi } from '../api/types';
import {
  easProjectId,
  musterActionFromResponse,
  registerMusterAlerts,
  resetMusterAlertRegistrations,
  revokeMusterAlerts,
} from './muster-alerts';

type Globals = typeof globalThis & {
  __easProjectId?: string;
  __notifications?: { permission: { granted: boolean; canAskAgain: boolean } };
};

const MUSTER = '9a000000-0000-4000-8000-0000000000a1';
const USER = '99999999-9999-4999-8999-999999999999';
const PROJECT = '0a000000-0000-4000-8000-0000000000a1';

beforeEach(() => {
  resetMusterAlertRegistrations();
});

const response = (actionIdentifier: string, data: Record<string, unknown>) =>
  ({
    actionIdentifier,
    notification: { request: { identifier: 'n-1', content: { data } } },
  }) as unknown as NotificationResponse;

describe('what a tapped alert asks for', () => {
  it('I’M SAFE button vs a plain tap; ids only', () => {
    const data = { type: 'MUSTER', muster_id: MUSTER, project_id: PROJECT, member_id: 'm1' };
    expect(musterActionFromResponse(response('IM_SAFE', data))).toEqual({
      kind: 'IM_SAFE',
      musterId: MUSTER,
      projectId: PROJECT,
      responseId: 'n-1|IM_SAFE',
    });
    expect(
      musterActionFromResponse(response('expo.modules.notifications.actions.DEFAULT', data))?.kind,
    ).toBe('OPEN');
  });

  it('ignores other notifications and malformed ids', () => {
    expect(musterActionFromResponse(null)).toBeNull();
    expect(musterActionFromResponse(response('IM_SAFE', { type: 'OTHER' }))).toBeNull();
    expect(
      musterActionFromResponse(
        response('IM_SAFE', { type: 'MUSTER', muster_id: 'x', project_id: PROJECT }),
      ),
    ).toBeNull();
  });
});

describe('push registration (never fakes a token)', () => {
  const api = (calls: unknown[], revoked: unknown[] = []) =>
    ({
      registerPushToken: async (input: unknown) => {
        calls.push(input);
      },
      revokeMyPushTokens: async (installationId: unknown) => {
        revoked.push(installationId);
      },
    }) as unknown as SiteMusterApi;

  const allowAndConfigure = () => {
    const notifications = (globalThis as Globals).__notifications;
    if (notifications) notifications.permission = { granted: true, canAskAgain: true };
    (globalThis as Globals).__easProjectId = 'eas-project-test';
  };

  it('no permission: nothing is registered', async () => {
    const calls: unknown[] = [];
    expect(await registerMusterAlerts(api(calls), USER)).toBe('DENIED');
    expect(calls).toEqual([]);
  });

  it('no EAS project id in this build: NOT_CONFIGURED, nothing sent', async () => {
    const notifications = (globalThis as Globals).__notifications;
    if (notifications) notifications.permission = { granted: true, canAskAgain: true };
    const calls: unknown[] = [];
    expect(easProjectId()).toBeNull();
    expect(await registerMusterAlerts(api(calls), USER)).toBe('NOT_CONFIGURED');
    expect(calls).toEqual([]);
  });

  it('registers the Expo token for this installation; a server refusal is FAILED, not success', async () => {
    allowAndConfigure();
    const calls: { installationId: string; token: string; platform: string }[] = [];
    expect(await registerMusterAlerts(api(calls), USER)).toBe('REGISTERED');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.token).toBe('ExponentPushToken[testtoken0001]');
    expect(calls[0]?.platform).toBe('IOS');
    expect(calls[0]?.installationId).toMatch(/^[0-9a-f]{64}$/);
    const refusing = {
      registerPushToken: async () => {
        throw new Error('PUSH_TOKEN_INVALID');
      },
    } as unknown as SiteMusterApi;
    resetMusterAlertRegistrations();
    expect(await registerMusterAlerts(refusing, USER)).toBe('FAILED');
  });

  it('registers once per sign-in; sign-out revokes and the next sign-in registers again (review on PR #11)', async () => {
    allowAndConfigure();
    const calls: unknown[] = [];
    const revoked: unknown[] = [];
    const server = api(calls, revoked);
    expect(await registerMusterAlerts(server, USER)).toBe('REGISTERED');
    expect(await registerMusterAlerts(server, USER)).toBe('REGISTERED');
    expect(calls).toHaveLength(1);
    await revokeMusterAlerts(server);
    expect(revoked).toHaveLength(1);
    expect(await registerMusterAlerts(server, USER)).toBe('REGISTERED');
    expect(calls).toHaveLength(2);
  });

  it('an offline sign-out still forgets the registration on the phone', async () => {
    allowAndConfigure();
    const calls: unknown[] = [];
    expect(await registerMusterAlerts(api(calls), USER)).toBe('REGISTERED');
    const offline = {
      revokeMyPushTokens: async () => {
        throw new Error('NETWORK');
      },
    } as unknown as SiteMusterApi;
    await expect(revokeMusterAlerts(offline)).rejects.toThrow('NETWORK');
    expect(await registerMusterAlerts(api(calls), USER)).toBe('REGISTERED');
    expect(calls).toHaveLength(2);
  });
});
