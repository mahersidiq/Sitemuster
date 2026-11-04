import { base64UrlEncode, sha256Hex } from '@sitemuster/shared';

import type { SiteMusterApi } from '../api/types';

/**
 * WEB RENDER ONLY (tools/ui-preview): in-memory stand-in for the phone keystore so the badge
 * screen can be screenshotted. The native app always uses src/device/device-store.ts.
 */
export interface StoredDevice {
  userId: string;
  deviceId: string;
  badgeSecret: string;
  uploadToken: string;
  uploadExpiresAt: string;
}
export interface BadgeProject {
  id: string;
  name: string;
}

let device: StoredDevice | null = null;
let projects: BadgeProject[] = [];
const installation = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));

export async function installationHash(): Promise<string> {
  return sha256Hex(installation);
}

export async function loadDevice(userId: string): Promise<StoredDevice | null> {
  return device && device.userId === userId ? device : null;
}

export async function activateThisDevice(
  api: SiteMusterApi,
  userId: string,
  appVersion: string,
): Promise<StoredDevice> {
  const response = await api.activateDevice({
    platform: 'IOS',
    installation_hash: await installationHash(),
    app_version: appVersion,
  });
  device = {
    userId,
    deviceId: response.device_id,
    badgeSecret: response.badge_secret,
    uploadToken: response.upload_token,
    uploadExpiresAt: response.upload_expires_at,
  };
  return device;
}

export async function saveBadgeProjects(next: BadgeProject[]): Promise<void> {
  projects = next;
}

export async function loadBadgeProjects(): Promise<BadgeProject[]> {
  return projects;
}

export async function wipeDeviceCredentials(): Promise<void> {
  device = null;
  projects = [];
}
