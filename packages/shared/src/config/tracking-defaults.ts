/**
 * Locked global defaults from docs/spec/06-config-defaults.md (decision #17).
 * These values are copied verbatim from the spec table; changing any of them requires a spec
 * change first. Per-project overrides are written as complete, immutable config versions (M04).
 */
export const TRACKING_DEFAULTS = Object.freeze({
  geofence_min_radius_m: 150,
  geofence_max_radius_m: 2000,
  geofence_radius_m: 150,
  exit_hysteresis_m: 50,
  entry_dwell_seconds: 600,
  min_qualified_inside_fixes: 2,
  max_horizontal_accuracy_m: 75,
  location_fresh_seconds: 600,
  presence_unknown_seconds: 1200,
  ios_native_region_budget: 15,
  android_native_region_budget: 75,
  queue_auto_reconcile_age_hours: 72,
  max_device_clock_skew_seconds: 300,
  raw_fix_retention_hours_after_close: 24,
  moving_sample_target_seconds: 90,
  stationary_sample_target_seconds: 300,
  onsite_distance_filter_m: 25,
  foreground_position_recheck_cooldown_seconds: 300,
  native_stationary_stop_timeout_seconds: 300,
  work_window_grace_minutes: 60,
  orientation_session_minutes: 120,
  orientation_screen_qr_rotation_seconds: 60,
  worker_app_badge_ttl_seconds: 30,
  sms_otp_digits: 6,
  sms_otp_expiry_seconds: 600,
  sms_resend_cooldown_seconds: 60,
  orientation_bulk_approve_max: 100,
  minimum_orientation_sms_capacity_per_hour: 200,
  shift_closeout_grace_minutes: 60,
  foreman_confirm_deadline_local: '12:00',
  /** ISO weekdays, Monday = 1 ... Sunday = 7. Default Monday–Saturday. */
  workweek_default: Object.freeze([1, 2, 3, 4, 5, 6]),
  work_window_default: Object.freeze({ local_start_time: '06:00', local_end_time: '18:00' }),
  operates_24_7_default: false,
  always_open_24h_review_open_hours: 16,
  always_open_24h_review_stale_minutes: 20,
  location_ingest_max_batch_events: 25,
  location_ingest_max_payload_bytes: 262144,
  location_ingest_max_requests_per_minute_per_device: 60,
  location_ingest_max_events_per_hour_per_device: 600,
  device_upload_credential_lifetime_days: 30,
  device_upload_renew_before_expiry_days: 7,
  device_upload_rotation_overlap_hours: 24,
  credential_expiry_reminder_days: Object.freeze([7, 3, 1]),
  credential_expiring_roster_flag_days: 3,
  geofence_sdk_max_local_queue_age_days: 4,
  reported_worker_history_retention_years_with_documented_basis: 2,
  worker_profile_deletion_max_days: 30,
  operations_ingest_max_events: 100,
  operations_ingest_max_payload_bytes: 262144,
  foreman_bulk_max_workers: 100,
} as const);

export type TrackingDefaults = typeof TRACKING_DEFAULTS;

/** Native fence radius = inner geofence radius + exit hysteresis (decision #45). */
export function nativeFenceRadiusMeters(geofenceRadiusM: number, exitHysteresisM: number): number {
  return geofenceRadiusM + exitHysteresisM;
}

/** True when a radius is inside the server hard bounds (150–2000 m inclusive). */
export function isRadiusWithinHardBounds(radiusM: number): boolean {
  return (
    Number.isFinite(radiusM) &&
    radiusM >= TRACKING_DEFAULTS.geofence_min_radius_m &&
    radiusM <= TRACKING_DEFAULTS.geofence_max_radius_m
  );
}
