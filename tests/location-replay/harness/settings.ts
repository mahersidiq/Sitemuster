import type { AttendanceConfig } from '@sitemuster/shared';

/** The stored settings JSON of a configuration version (both replay backends). */
export function settingsOf(config: AttendanceConfig): Record<string, unknown> {
  return {
    geofence_radius_m: config.radiusM,
    exit_hysteresis_m: config.exitHysteresisM,
    entry_dwell_seconds: config.entryDwellSeconds,
    max_horizontal_accuracy_m: config.maxHorizontalAccuracyM,
    location_fresh_seconds: config.locationFreshSeconds,
    presence_unknown_seconds: config.presenceUnknownSeconds,
    queue_auto_reconcile_age_hours: config.lateReviewHours,
    max_device_clock_skew_seconds: config.maxClockSkewSeconds,
    work_window_grace_minutes: config.workWindowGraceMinutes,
    shift_closeout_grace_minutes: config.closeoutGraceMinutes,
    always_open_24h_review_open_hours: config.alwaysOpenReviewHours,
    operates_24_7: config.operates24x7,
    work_windows: config.windows.map((window) => ({
      ...window,
      crosses_midnight: window.local_end_time < window.local_start_time,
    })),
  };
}
