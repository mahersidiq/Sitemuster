import { createNativeSessionStorage } from '../auth/native-storage';
import type { ControllerState } from './controller';
import { type TrackingPlan, TrackingPlanSchema } from './plan';
import type { TrackingStore } from './service';

/**
 * Tracking state on the phone: the controller state (mode, projects inside, monitored fences —
 * site centers only, never the worker's positions) and the last downloaded plan, kept in the
 * AES-256-GCM encrypted store (decision #13) so the Android headless task can resume after the
 * app was closed. Cleared at sign-out.
 */
const CONTROLLER_KEY = 'sitemuster.tracking.controller.v1';
const PLAN_KEY = 'sitemuster.tracking.plan.v1';

function parseState(raw: string | null): ControllerState | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as ControllerState;
    return Array.isArray(value.inside) && Array.isArray(value.fences) ? value : null;
  } catch {
    // A corrupt blob is treated as "no saved state": the tracker re-arms from the server plan.
    return null;
  }
}

export function createNativeTrackingStore(): TrackingStore {
  const storage = createNativeSessionStorage();
  return {
    load: async () => parseState(await storage.getItem(CONTROLLER_KEY)),
    save: (state) => storage.setItem(CONTROLLER_KEY, JSON.stringify(state)),
    loadPlan: async () => {
      const raw = await storage.getItem(PLAN_KEY);
      if (!raw) return null;
      try {
        const parsed = TrackingPlanSchema.safeParse(JSON.parse(raw));
        return parsed.success ? (parsed.data as TrackingPlan) : null;
      } catch {
        // Unreadable cache: download the plan again when online.
        return null;
      }
    },
    savePlan: (plan) => storage.setItem(PLAN_KEY, JSON.stringify(plan)),
    clear: async () => {
      await storage.removeItem(CONTROLLER_KEY);
      await storage.removeItem(PLAN_KEY);
    },
  };
}
