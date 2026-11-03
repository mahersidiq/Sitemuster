# 06 — Global numeric defaults, per-project overrides and immutable versions

## Storage contract

Create `project_tracking_config_versions` with immutable `(project_id,version_number,effective_at,created_by,settings_json,sha256)` rows and current `projects.config_version_id`. A new override writes the **complete merged configuration as a new version**, validates all bounds server-side and atomically changes the project's current pointer. Version 1 is created with project. Every event stores the effective `config_version_id`; an attendance session snapshots it at opening. Changes apply to **new sessions**, not an already-open session, and never rewrite a historical report. Add `project_work_windows` rows attached to version. Audit who/when/why for changes, preserve historical geofence center and radius by config version.

## Mandatory initial defaults

| Key | Initial value | Override / behavior |
|---|---|---|
| `geofence_min_radius_m` | **150 m** | Server hard lower bound, not overridable below 150 |
| `geofence_max_radius_m` | **2,000 m** | Server hard upper bound |
| `geofence_radius_m` | **150 m** | Project may set 150–2000 m; warn overlap |
| `exit_hysteresis_m` | **50 m** | Added to radius for the single native fence (native radius = radius + hysteresis); EXIT needs no coordinates |
| `entry_dwell_seconds` | **600 s (10 min)** | Project override through new version; never zero without a separate reviewed release |
| `min_qualified_inside_fixes` | **2** | Fixed V1; fixes >=600 s apart |
| `max_horizontal_accuracy_m` | **75 m** | For auto attendance fix; worse goes to unknown/review |
| `location_fresh_seconds` | **600 s (10 min)** | Marker live until 10 min; then stale |
| `presence_unknown_seconds` | **1,200 s (20 min)** | Stale monitoring -> PRESENCE_UNKNOWN, not departed |
| `ios_native_region_budget` | **15** | iOS OS ceiling 20; prioritization mandatory |
| `android_native_region_budget` | **75** | Android OS typical ceiling ~100; SDK scheduling mandatory |
| `queue_auto_reconcile_age_hours` | **72 h** | Older events durable but require human review, never silently drop |
| `max_device_clock_skew_seconds` | **300 s (5 min)** | Flag/qualify against server clock, do not fabricate timestamp |
| `raw_fix_retention_hours_after_close` | **24 h** | Maximum; regular purge of unresolved raw fixes too |
| `moving_sample_target_seconds` | **90 s** | Target only, native/OS may defer; battery-aware |
| `stationary_sample_target_seconds` | **300 s (5 min)** | Target only, not timer guarantee |
| `onsite_distance_filter_m` | **25 m** | Target SDK option |
| `foreground_position_recheck_cooldown_seconds` | **300 s (5 min)** | Recheck after app foreground/reboot/rearm/sync with stale fix |
| `native_stationary_stop_timeout_seconds` | **300 s** | SDK stop/pause motion target |
| `work_window_grace_minutes` | **60 min** | Applied before/after scheduled window; not automatic session closure |
| `orientation_session_minutes` | **120 min** | Static printed QR only valid while session open |
| `orientation_screen_qr_rotation_seconds` | **60 s** | Interactive displayed QR, session-scoped |
| `worker_app_badge_ttl_seconds` | **30 s** | HMAC time-step length for the offline in-app badge; server accepts current step ±1 relative to kiosk observed time; each (device, step, project) redeemable once |
| `sms_otp_digits` | **6** | Twilio/Supabase auth; do not hardcode OTP values |
| `sms_otp_expiry_seconds` | **600 s** | OTP auth expiration |
| `sms_resend_cooldown_seconds` | **60 s** | Rate-limit IP/phone/device; avoid enumeration |
| `orientation_bulk_approve_max` | **100** | Max selected worker enrollments in one operation |
| `minimum_orientation_sms_capacity_per_hour` | **200** | Configured provider throughput pilot precondition, not SDK default |
| `shift_closeout_grace_minutes` | **60 min** | At shift end+60 stale open sessions UNRESOLVED |
| `foreman_confirm_deadline_local` | **12:00 next project workday** | No answer -> NOT_CONFIRMED |
| `workweek_default` | **Monday–Saturday** | Sunday excluded by default |
| `work_window_default` | **06:00–18:00 local** | Multiple shifts per weekday supported |
| `operates_24_7_default` | **false** | If true no scheduled-hours gating; 10-minute dwell remains |
| `always_open_24h_review_hours` | **16 h open + >=20 min stale** | For 24/7 projects, mark UNRESOLVED for manual closeout, not exit |
| `location_ingest_max_batch_events` | **25** | SDK native HTTP `maxBatchSize` |
| `location_ingest_max_payload_bytes` | **262,144 (256 KiB)** | Reject too large, fail without loss |
| `location_ingest_max_requests_per_minute_per_device` | **60** | HTTP 429 + retry |
| `location_ingest_max_events_per_hour_per_device` | **600** | HTTP 429 + retry |
| `device_upload_credential_lifetime_days` | **30 days** | 32 random bytes, SHA-256 hashed DB, revocable |
| `device_upload_renew_before_expiry_days` | **7 days** | Renew on foreground, silent push or SDK headless task, whichever first; never depends on one path |
| `device_upload_rotation_overlap_hours` | **24 h** | Previous token still accepted after rotation so in-flight batches are not lost |
| `credential_expiry_reminder_days` | **7, 3, 1** | Visible localized push reminders; roster flag CREDENTIAL_EXPIRING at <=3 days |
| `geofence_sdk_max_local_queue_age_days` | **4 days** | SDK persists at least >72h pending; older event human review; user sees loss risk if queue exceeds TTL |
| `reported_worker_history_retention` | **2 years when documented basis exists** | Otherwise shorter/deletion policy based on counsel/project |
| `worker_profile_deletion_max_days` | **30 days** | Except specifically recorded legal holds |

## Work windows and midnight behavior

`project_work_windows` contains one or more `(weekday, local_start, local_end, crosses_midnight)` tuples under the version; a window starting Monday 20:00 and ending Tuesday 04:00 counts as Monday's shift across midnight. Use IANA zone conversion to UTC with DST and ambiguous local-time handling. If `operates_24_7=true`, set no shift restriction, still use entry dwell, permission, precision, enrollment and other rules. Project-local next **workday** for foreman due date derived from configured schedule; 24/7 projects use next calendar day at 12:00 local.

## Versioning example

V1 project saved with radius=150m and Mon–Sat 06:00–18:00 -> `config_version_id=v1`. A worker begins at 07:00 with v1. Superintendent changes to radius 250m at 09:00 -> new `v2` effective 09:00; worker's open session and its exit evaluation continue with v1. Next new attendance session uses v2. Reports link to the actual versions; never retroactively recalculate to new radius. Mobile sync must atomically replace active geofences and mark configuration updating when receipt isn't confirmed. Keep historical v1 geofence identifier resolvable for v1 open-session exit events until that session is closed; new v2 entrants must never be evaluated using old v1 boundaries.

## Authority and access

Only delegated GC admins/assigned project staff may create a new version; workers, foremen and platform admins cannot set configuration. A 24/7 change, reduction in dwell/accuracy or geofence enlargement requires explicit confirmation and audit reason. Invalid/missing version on an incoming event => durable rejection + review, not fallback to newest settings.
