import type { SiteMusterApi } from '../api/types';

/**
 * Web preview only (tools/ui-preview): no push on web. The preview shows the same honest state a
 * build without push set up shows ("not set up in this build"); nothing is ever registered.
 */
export type MusterAlertPermission = 'granted' | 'undetermined' | 'denied';
export type MusterAlertRegistration = 'REGISTERED' | 'NOT_CONFIGURED' | 'DENIED' | 'FAILED';

export interface MusterNotificationAction {
  kind: 'IM_SAFE' | 'OPEN';
  musterId: string;
  projectId: string;
  responseId: string;
}

export async function configureMusterNotifications(_text: {
  channelName: string;
  safeButton: string;
}): Promise<void> {}

export async function musterAlertPermission(): Promise<MusterAlertPermission> {
  return 'granted';
}

export async function requestMusterAlertPermission(): Promise<MusterAlertPermission> {
  return 'granted';
}

export function easProjectId(): string | null {
  return null;
}

export function resetMusterAlertRegistrations(): void {}

export async function registerMusterAlerts(
  _api: SiteMusterApi,
  _userId: string,
): Promise<MusterAlertRegistration> {
  return 'NOT_CONFIGURED';
}

export async function revokeMusterAlerts(_api: SiteMusterApi): Promise<void> {}

export function musterActionFromResponse(_response: unknown): MusterNotificationAction | null {
  return null;
}
