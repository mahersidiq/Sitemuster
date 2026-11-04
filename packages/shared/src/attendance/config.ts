import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { TRACKING_DEFAULTS } from '../config/tracking-defaults.ts';
import { ms } from './time.ts';
import type { AttendanceConfig, WorkWindowSpec } from './types.ts';

/**
 * Builds the engine view of one immutable configuration version from the stored
 * `settings_json` (Milestone 04 `app_private.build_settings`) plus the version's geofence row.
 * Missing keys fall back to the locked spec defaults; a missing version is never replaced by
 * the newest one (docs/spec/06: "Invalid/missing version … durable rejection + review").
 */
export function configFromSettings(input: {
  configVersionId: string;
  projectId: string;
  versionNumber: number;
  effectiveAt: string;
  settings: Record<string, unknown>;
  center: { lat: number; lng: number };
  radiusM?: number;
  exitHysteresisM?: number;
}): AttendanceConfig {
  const s = input.settings;
  const num = (key: string, fallback: number): number => {
    const value = s[key];
    const parsed = typeof value === 'string' ? Number(value) : value;
    return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : fallback;
  };
  const windows = Array.isArray(s.work_windows)
    ? (s.work_windows as unknown[]).flatMap((w): WorkWindowSpec[] => {
        if (!w || typeof w !== 'object') return [];
        const window = w as Record<string, unknown>;
        if (
          typeof window.weekday !== 'number' ||
          typeof window.local_start_time !== 'string' ||
          typeof window.local_end_time !== 'string'
        ) {
          return [];
        }
        return [
          {
            weekday: window.weekday,
            local_start_time: window.local_start_time.slice(0, 5),
            local_end_time: window.local_end_time.slice(0, 5),
          },
        ];
      })
    : [];
  return {
    configVersionId: input.configVersionId,
    projectId: input.projectId,
    versionNumber: input.versionNumber,
    effectiveAt: input.effectiveAt,
    center: input.center,
    radiusM: input.radiusM ?? num('geofence_radius_m', TRACKING_DEFAULTS.geofence_radius_m),
    exitHysteresisM:
      input.exitHysteresisM ?? num('exit_hysteresis_m', TRACKING_DEFAULTS.exit_hysteresis_m),
    entryDwellSeconds: num('entry_dwell_seconds', TRACKING_DEFAULTS.entry_dwell_seconds),
    maxHorizontalAccuracyM: num(
      'max_horizontal_accuracy_m',
      TRACKING_DEFAULTS.max_horizontal_accuracy_m,
    ),
    locationFreshSeconds: num('location_fresh_seconds', TRACKING_DEFAULTS.location_fresh_seconds),
    presenceUnknownSeconds: num(
      'presence_unknown_seconds',
      TRACKING_DEFAULTS.presence_unknown_seconds,
    ),
    lateReviewHours: num(
      'queue_auto_reconcile_age_hours',
      TRACKING_DEFAULTS.queue_auto_reconcile_age_hours,
    ),
    maxClockSkewSeconds: num(
      'max_device_clock_skew_seconds',
      TRACKING_DEFAULTS.max_device_clock_skew_seconds,
    ),
    workWindowGraceMinutes: num(
      'work_window_grace_minutes',
      TRACKING_DEFAULTS.work_window_grace_minutes,
    ),
    closeoutGraceMinutes: num(
      'shift_closeout_grace_minutes',
      TRACKING_DEFAULTS.shift_closeout_grace_minutes,
    ),
    alwaysOpenReviewHours: num(
      'always_open_24h_review_open_hours',
      TRACKING_DEFAULTS.always_open_24h_review_open_hours,
    ),
    operates24x7: s.operates_24_7 === true,
    windows,
  };
}

/** The version in force at an instant: latest `effectiveAt` ≤ t (ties: highest version). */
export function configAt(configs: Iterable<AttendanceConfig>, at: string): AttendanceConfig | null {
  const t = ms(at);
  let best: AttendanceConfig | null = null;
  let earliest: AttendanceConfig | null = null;
  for (const config of configs) {
    if (!earliest || config.versionNumber < earliest.versionNumber) earliest = config;
    if (ms(config.effectiveAt) > t) continue;
    if (
      !best ||
      ms(config.effectiveAt) > ms(best.effectiveAt) ||
      (ms(config.effectiveAt) === ms(best.effectiveAt) && config.versionNumber > best.versionNumber)
    ) {
      best = config;
    }
  }
  return best ?? earliest;
}

/**
 * Deterministic UUID (version 5 layout, SHA-256 based) for records the engine creates, so a
 * retried or replayed batch always produces the same session ids in memory and in the database.
 */
export function deriveUuid(namespace: string, name: string): string {
  const hex = bytesToHex(sha256(new TextEncoder().encode(`${namespace}|${name}`))).slice(0, 32);
  const variant = ((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}
