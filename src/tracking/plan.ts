import { z } from 'zod';

import {
  addDays,
  configFromSettings,
  localDateOf,
  selectNativeRegions,
  TRACKING_DEFAULTS,
  windowInstances,
} from '@sitemuster/shared';

import type { GateFence } from './gate';

/**
 * The worker's own tracking plan (`my_tracking_plan`, decision #89): which fences this phone
 * registers, whether onsite coordinates are released for this build (decision #90) and why other
 * approved projects are not monitored. Project centers are site addresses, not personal data.
 */
const CenterSchema = z.object({ lat: z.number(), lng: z.number() });

export const TrackingPlanProjectSchema = z.object({
  project_id: z.uuid(),
  project_name: z.string(),
  iana_timezone: z.string(),
  config_version_id: z.uuid(),
  version_number: z.number().int(),
  effective_at: z.string(),
  settings: z.record(z.string(), z.unknown()),
  identifier: z.string().min(1).max(128),
  center: CenterSchema,
  radius_m: z.number().positive(),
  native_radius_m: z.number().positive(),
});
export type TrackingPlanProject = z.infer<typeof TrackingPlanProjectSchema>;

export const CREDENTIAL_STATUSES = ['OK', 'EXPIRING', 'EXPIRED', 'NONE'] as const;
export const NOT_MONITORED_REASONS = [
  'EMPLOYER_NOT_VERIFIED',
  'PROJECT_NOT_ACTIVE',
  'CONSENT_MISSING',
  'NO_DEVICE',
  'NOT_BOUND',
] as const;

export const TrackingPlanSchema = z.object({
  device_id: z.uuid().nullable(),
  platform: z.enum(['IOS', 'ANDROID']).nullable(),
  credential: z.object({
    status: z.enum(CREDENTIAL_STATUSES),
    expires_at: z.string().nullable(),
  }),
  coordinates_allowed: z.boolean(),
  projects: z.array(TrackingPlanProjectSchema),
  not_monitored: z.array(
    z.object({
      project_id: z.uuid(),
      project_name: z.string(),
      reason: z.enum(NOT_MONITORED_REASONS),
    }),
  ),
});
export type TrackingPlan = z.infer<typeof TrackingPlanSchema>;

export function gateFences(plan: Pick<TrackingPlan, 'projects'>): GateFence[] {
  return plan.projects.map((project) => ({
    projectId: project.project_id,
    identifier: project.identifier,
    center: project.center,
    radiusM: project.radius_m,
    nativeRadiusM: project.native_radius_m,
  }));
}

export function regionBudget(platform: 'ios' | 'android'): number {
  return platform === 'ios'
    ? TRACKING_DEFAULTS.ios_native_region_budget
    : TRACKING_DEFAULTS.android_native_region_budget;
}

/**
 * Native region selection (docs/spec/03 "Recovery and geofence scheduling"): current presence
 * first, then proximity, then the next scheduled shift; the rest are shown as not monitored.
 */
export function selectMonitoredProjects(input: {
  plan: Pick<TrackingPlan, 'projects'>;
  insideProjectIds: readonly string[];
  lastPosition: { lat: number; lng: number } | null;
  now: number;
  budget: number;
  distance: (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => number;
}): { monitored: string[]; unmonitored: string[] } {
  const candidates = input.plan.projects.map((project) => {
    const config = configFromSettings({
      configVersionId: project.config_version_id,
      projectId: project.project_id,
      versionNumber: project.version_number,
      effectiveAt: project.effective_at,
      settings: project.settings,
      center: project.center,
      radiusM: project.radius_m,
      exitHysteresisM: project.native_radius_m - project.radius_m,
    });
    const next = config.operates24x7
      ? null
      : windowInstances(
          config,
          project.iana_timezone,
          addDays(localDateOf(input.now, project.iana_timezone), -1),
          9,
        ).find((window) => window.end > input.now);
    return {
      projectId: project.project_id,
      distanceM: input.lastPosition ? input.distance(input.lastPosition, project.center) : null,
      activeSession: input.insideProjectIds.includes(project.project_id),
      nextShiftInMs: config.operates24x7 ? 0 : next ? Math.max(0, next.start - input.now) : null,
    };
  });
  const selection = selectNativeRegions(candidates, input.budget);
  return { monitored: selection.monitored, unmonitored: selection.unmonitored };
}
