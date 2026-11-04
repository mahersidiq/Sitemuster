import * as SecureStore from 'expo-secure-store';

/**
 * The kiosk registration id of this phone per project, kept in the OS keystore so a kiosk that
 * restarts offline can keep recording (it is an id, not a secret; the server re-checks it).
 */
const OPTIONS = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK };
const keyFor = (projectId: string) => `sitemuster.kiosk.${projectId}.v1`;

export async function loadKioskId(projectId: string): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(keyFor(projectId), OPTIONS);
  } catch {
    return null; // keystore not readable yet (before first unlock): register again online
  }
}

export async function saveKioskId(projectId: string, kioskDeviceId: string): Promise<void> {
  await SecureStore.setItemAsync(keyFor(projectId), kioskDeviceId, OPTIONS);
}
