import { getRandomBytes } from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { z } from 'zod';

import { base64UrlEncode, sha256Hex } from '@sitemuster/shared';

import type { SiteMusterApi } from '../api/types';

/**
 * The worker phone's device credentials (decision #27/#43): returned once by `device-activate`,
 * kept only in the OS secure keystore (AFTER_FIRST_UNLOCK so they work at a locked kiosk line and
 * in the background), bound to the signed-in user and wiped on sign-out. The badge is generated
 * from these offline.
 */
const DEVICE_KEY = 'sitemuster.device.v1';
const INSTALLATION_KEY = 'sitemuster.installation.v1';
const BADGE_PROJECTS_KEY = 'sitemuster.badge-projects.v1';
const OPTIONS = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK };

const StoredDeviceSchema = z.object({
  userId: z.string(),
  deviceId: z.uuid(),
  badgeSecret: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  uploadToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  uploadExpiresAt: z.string(),
});
export type StoredDevice = z.infer<typeof StoredDeviceSchema>;

const BadgeProjectsSchema = z.array(z.object({ id: z.uuid(), name: z.string() }));
export type BadgeProject = z.infer<typeof BadgeProjectsSchema>[number];

async function readJson<T>(key: string, schema: z.ZodType<T>): Promise<T | null> {
  const raw = await SecureStore.getItemAsync(key, OPTIONS);
  if (!raw) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** A random per-installation identifier; only its SHA-256 leaves the phone. */
export async function installationHash(): Promise<string> {
  let id = await SecureStore.getItemAsync(INSTALLATION_KEY, OPTIONS);
  if (!id) {
    id = base64UrlEncode(getRandomBytes(32));
    await SecureStore.setItemAsync(INSTALLATION_KEY, id, OPTIONS);
  }
  return sha256Hex(id);
}

export async function loadDevice(userId: string): Promise<StoredDevice | null> {
  const stored = await readJson(DEVICE_KEY, StoredDeviceSchema);
  return stored && stored.userId === userId ? stored : null;
}

/** Activates this phone for the signed-in worker (replacing any previous phone server-side). */
export async function activateThisDevice(
  api: SiteMusterApi,
  userId: string,
  appVersion: string,
): Promise<StoredDevice> {
  const response = await api.activateDevice({
    platform: Platform.OS === 'android' ? 'ANDROID' : 'IOS',
    installation_hash: await installationHash(),
    app_version: appVersion,
  });
  const device: StoredDevice = {
    userId,
    deviceId: response.device_id,
    badgeSecret: response.badge_secret,
    uploadToken: response.upload_token,
    uploadExpiresAt: response.upload_expires_at,
  };
  await SecureStore.setItemAsync(DEVICE_KEY, JSON.stringify(device), OPTIONS);
  return device;
}

/** Approved projects remembered for offline badge display (ids and names only). */
export async function saveBadgeProjects(projects: BadgeProject[]): Promise<void> {
  await SecureStore.setItemAsync(BADGE_PROJECTS_KEY, JSON.stringify(projects), OPTIONS);
}

export async function loadBadgeProjects(): Promise<BadgeProject[]> {
  return (await readJson(BADGE_PROJECTS_KEY, BadgeProjectsSchema)) ?? [];
}

export async function wipeDeviceCredentials(): Promise<void> {
  await SecureStore.deleteItemAsync(DEVICE_KEY, OPTIONS);
  await SecureStore.deleteItemAsync(BADGE_PROJECTS_KEY, OPTIONS);
}
