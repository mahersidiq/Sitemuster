# Rate-limit inventory (Milestone 12)

Spec 09 requires rate limits on enrollment, SMS codes, badge issue and scan, invites, operator functions, attendance ingestion and report exports. On suspicious activity the system should flag and alert, and never erase evidence automatically.

This page lists every limit in the system. `tests/security/rate-limit-inventory.test.ts` fails if a bucket in the migrations is missing here, or if a bucket listed here no longer exists.

## How limits work

- **Server-side only.** Limits are counted in the database (`app_private.rate_limit_buckets`, fixed windows), keyed by an id the server derived itself: the signed-in user, the worker, the phone (device) or the kiosk actor. A client cannot pick its own key.
- **At the limit.** The call is refused with `RATE_LIMITED`. Edge Functions answer HTTP 429 (with `Retry-After` where the wait is known), and the app shows the translated "too many attempts" message in English or Spanish. Nothing is half-written: refusals happen before any change.
- **Flag, never erase (decision #133).**
  - When a subject reaches a limit, the hourly privacy job (and every operator health check) copies that bucket into `app_private.security_flags` before old buckets are purged.
  - Open flags cannot be edited or deleted.
  - The operator lists them with `npm run operator -- flags --reason "…"` and records a review with `flag-review <id> --note "…"`.
  - Flags never block anyone by themselves. They carry pseudonymous ids and counts only.
- **Old buckets.** Buckets older than two days are deleted by the hourly job, after flagging.

## Database limits

| Spec area | Bucket | Limit | Per | Where |
|---|---|---|---|---|
| Enrollment | `orientation_join` | 30 a minute | signed-in person | `preview_orientation`, `complete_orientation` (QR scan → PENDING enrollment) |
| Badge issue | `badge_issue` | 30 a minute | staff member | `issue_printed_badge` |
| Badge scan, kiosk, crew, manual, visitor, muster check-ins | `operations_minute` | 120 requests a minute | kiosk/foreman/staff actor | `ingest-operations` (`edge_operation_rate_limit`); each badge 30-second step is also single-use per project and phone |
| | `operations_hour` | 3,000 events an hour | kiosk/foreman/staff actor | same |
| Kiosk setup | `kiosk_register` | 30 an hour | staff member | `register_kiosk` |
| Invites | `invitation_hour` | 30 an hour | inviting staff member | every insert into `organization_invitations` (trigger) |
| Operator functions | `operator_minute` | 60 a minute | operator | every `operator_*` RPC (`assert_operator`) |
| Attendance ingestion | `location_ingest_minute` | 60 uploads a minute | phone | `ingest-location-batch` (`edge_device_rate_limit`) |
| | `location_ingest_hour` | 600 location events an hour | phone | same (a batch that does not fit is refused whole) |
| | `device_renew_hour` | 12 an hour | phone | `device-renew` |
| | `device_activate_hour` | 10 an hour | person | `device-activate` (new in M12; also refused once account deletion was requested) |
| Report exports | `attendance_export_hour` | 300 an hour | worker | `my_attendance` (the worker's hours screen and CSV export; new in M12) |
| | `report_hour` | 240 an hour | staff member or foreman | `daily-reports` (checked before any report is generated; new in M12) |
| Address lookups (paid Google API) | `address_lookup_minute` | 30 a minute | person | `address-search`, `address-resolve` |
| | `address_lookup_hour` | 300 an hour | person | same |
| Consent | `consent_change` | 30 an hour | worker | `set_my_location_consent`, `renew_my_consent` |
| Account deletion | `account_delete` | 5 a day | person | `account-delete` |
| Push registration | `push_token_hour` | 20 an hour | person | every insert into `push_tokens` (trigger) |
| Muster start | `muster_start_hour` | 20 an hour | person | every insert into `muster_events` (trigger); a real emergency is never more than a few starts |
| Reviewer demo simulation | `demo_simulation_hour` | 120 an hour | staff member | `demo-simulate` (`begin_demo_simulation`; only allowlisted demo projects, new in M13) |

## Sign-in codes (Supabase Auth)

Local values live in `supabase/config.toml`. Hosted values are set in the dashboard (`docs/setup/HUMAN_CHECKLIST.md` §3, §3b, §4).

| Spec area | Setting | Value | Per |
|---|---|---|---|
| SMS code | `auth.sms.max_frequency` | one code every 60 s | phone number |
| SMS code | `auth.rate_limit.sms_sent` | 400 an hour (orientation needs ≥ 200 sign-ins an hour) | project (cost ceiling) |
| Email code (staff) | `auth.email.max_frequency` | one code every 60 s | email address |
| Sign-in requests | `auth.rate_limit.sign_in_sign_ups` | 30 per 5 minutes | IP address |
| Code checks | `auth.rate_limit.token_verifications` | 30 per 5 minutes | IP address |
| Session refresh | `auth.rate_limit.token_refresh` | 150 per 5 minutes | IP address |

Codes expire after 600 s. Answers never reveal whether an account exists (Supabase Auth behaviour, checked in Milestone 03).

Spec 09 also asks for limits "by device and organization" on SMS codes. Before sign-in there is no device credential and no organization to count against, so the per-number, per-IP and per-project limits above apply (decision #132). Two further protections are human setup steps: Twilio SMS Pumping Protection (Fraud Guard) and a US-only geographic permission (`HUMAN_CHECKLIST.md` §4).

## Not rate-limited, on purpose

- **Reads behind row-level security** (dashboard, roster, map, muster board) are bounded by the caller's own permissions, refreshed by Realtime Broadcast plus refetch rather than polling, and limited at the platform level by Supabase.
- **I'M SAFE and other muster responses** travel through the operations outbox and count against `operations_*`. An emergency answer is never refused for any other reason.
