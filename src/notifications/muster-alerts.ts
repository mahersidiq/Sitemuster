import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { AndroidImportance, AndroidNotificationVisibility } from 'expo-notifications';
import { Platform } from 'react-native';

import {
  MUSTER_ANDROID_CHANNEL,
  MUSTER_NOTIFICATION_CATEGORY,
  MUSTER_SAFE_ACTION,
} from '@sitemuster/shared';

import type { SiteMusterApi } from '../api/types';
import { installationHash } from '../device/device-store';

/**
 * Muster alerts on the phone (docs/spec/12 step 3; Milestone 11). Push is optional: the in-app
 * I'M SAFE button, the roster, the foreman and the attended kiosk work without it, and nothing
 * ever waits for an alert. A notification only carries opaque ids, never names or locations.
 *
 * - Android: a high-importance "muster" channel. iOS/Android: a MUSTER category with an I'M SAFE
 *   button that opens the app and needs the phone unlocked (decision #121), so a lock-screen tap
 *   by someone else cannot answer for the worker.
 * - The Expo push token needs the EAS project id. Without it (development before the EAS project
 *   exists) registration reports NOT_CONFIGURED and sends nothing; production never fakes it.
 */

export type MusterAlertPermission = 'granted' | 'undetermined' | 'denied';

export type MusterAlertRegistration = 'REGISTERED' | 'NOT_CONFIGURED' | 'DENIED' | 'FAILED';

export interface MusterNotificationAction {
  kind: 'IM_SAFE' | 'OPEN';
  musterId: string;
  projectId: string;
  /** Identifies this one tap, so a re-delivered response is never queued twice. */
  responseId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let handlerInstalled = false;

/**
 * Shows a muster alert even while the app is open, and (re)creates the channel and the I'M SAFE
 * button in the current language. Safe to call again after a language change.
 */
export async function configureMusterNotifications(text: {
  channelName: string;
  safeButton: string;
}): Promise<void> {
  if (!handlerInstalled) {
    handlerInstalled = true;
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
      }),
    });
  }
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(MUSTER_ANDROID_CHANNEL, {
      name: text.channelName,
      importance: AndroidImportance.MAX,
      sound: 'default',
      enableVibrate: true,
      vibrationPattern: [0, 600, 300, 600],
      // The alert text names no person and no place, so it may show on the lock screen.
      lockscreenVisibility: AndroidNotificationVisibility.PUBLIC,
    });
  }
  await Notifications.setNotificationCategoryAsync(MUSTER_NOTIFICATION_CATEGORY, [
    {
      identifier: MUSTER_SAFE_ACTION,
      buttonTitle: text.safeButton,
      options: { opensAppToForeground: true, isAuthenticationRequired: true },
    },
  ]);
}

export async function musterAlertPermission(): Promise<MusterAlertPermission> {
  const status = await Notifications.getPermissionsAsync();
  if (status.granted) return 'granted';
  return status.canAskAgain ? 'undetermined' : 'denied';
}

/** Asks once, after the explanation card; no critical-alert entitlement in V1. */
export async function requestMusterAlertPermission(): Promise<MusterAlertPermission> {
  const status = await Notifications.requestPermissionsAsync({
    ios: { allowAlert: true, allowSound: true, allowBadge: false },
  });
  if (status.granted) return 'granted';
  return status.canAskAgain ? 'undetermined' : 'denied';
}

/** The EAS project id the Expo push token is issued for, or null when this build has none. */
export function easProjectId(): string | null {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: unknown } } | undefined;
  const id = extra?.eas?.projectId;
  return typeof id === 'string' && id.trim() !== '' ? id : null;
}

/**
 * People this app run already registered. Sign-out clears it together with the server-side
 * revocation (review on PR #11), so signing back in registers the phone again.
 */
const registeredThisRun = new Set<string>();

/** Test hook. */
export function resetMusterAlertRegistrations(): void {
  registeredThisRun.clear();
}

/**
 * Registers this phone's Expo push token for the signed-in person, once per sign-in (never
 * throws).
 */
export async function registerMusterAlerts(
  api: SiteMusterApi,
  userId: string,
): Promise<MusterAlertRegistration> {
  try {
    if ((await musterAlertPermission()) !== 'granted') return 'DENIED';
    const projectId = easProjectId();
    if (!projectId) return 'NOT_CONFIGURED';
    if (registeredThisRun.has(userId)) return 'REGISTERED';
    const token = await Notifications.getExpoPushTokenAsync({ projectId });
    await api.registerPushToken({
      installationId: await installationHash(),
      token: token.data,
      platform: Platform.OS === 'ios' ? 'IOS' : 'ANDROID',
    });
    registeredThisRun.add(userId);
    return 'REGISTERED';
  } catch (error) {
    console.warn(
      'muster alerts: not registered',
      error instanceof Error ? error.message.slice(0, 120) : 'unknown',
    );
    return 'FAILED';
  }
}

/**
 * Sign-out: this person's alerts stop on this phone (server-side revocation), and the next
 * sign-in registers again. The local memory is cleared first, even when the phone is offline.
 */
export async function revokeMusterAlerts(api: SiteMusterApi): Promise<void> {
  registeredThisRun.clear();
  await api.revokeMyPushTokens(await installationHash());
}

/** What a tapped muster notification asks for; null for anything that is not a muster alert. */
export function musterActionFromResponse(
  response: Notifications.NotificationResponse | null | undefined,
): MusterNotificationAction | null {
  if (!response) return null;
  const data = (response.notification.request.content.data ?? {}) as Record<string, unknown>;
  if (data.type !== 'MUSTER') return null;
  const musterId = typeof data.muster_id === 'string' ? data.muster_id : '';
  const projectId = typeof data.project_id === 'string' ? data.project_id : '';
  if (!UUID.test(musterId) || !UUID.test(projectId)) return null;
  return {
    kind: response.actionIdentifier === MUSTER_SAFE_ACTION ? 'IM_SAFE' : 'OPEN',
    musterId,
    projectId,
    responseId: `${response.notification.request.identifier}|${response.actionIdentifier}`,
  };
}
