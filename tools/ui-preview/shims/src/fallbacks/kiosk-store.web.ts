/** WEB RENDER ONLY (tools/ui-preview): in-memory kiosk ids. The app uses kiosk-store.ts. */
const ids = new Map<string, string>();

export async function loadKioskId(projectId: string): Promise<string | null> {
  return ids.get(projectId) ?? null;
}

export async function saveKioskId(projectId: string, kioskDeviceId: string): Promise<void> {
  ids.set(projectId, kioskDeviceId);
}
