# Observability and alerting (Milestone 12)

How the person running SiteMuster sees that the system is healthy without seeing anyone's location, contacts or attendance. Every source below is coordinate-free.

## 1. Operator health check (primary)

Run it from a trusted computer. You sign in with your email code and your authenticator; every run is recorded with your reason.

```bash
npm run operator -- health --reason "daily health check"
```

| Field | Meaning | Look into it when |
|---|---|---|
| `environment` | `development`, `staging` or `production` (the database marker) | It is not the project you meant |
| `jobs[]` | Each scheduled job, its last status and end time | `last_status` is not `succeeded`, or `last_end` is older than twice the schedule |
| `location_receipts_last_hour` | Phone location uploads accepted / duplicate / rejected | Rejected keeps rising, or accepted drops to 0 during working hours |
| `operations_last_hour` | Kiosk, crew, manual, visitor and muster records accepted / duplicate / rejected | Rejected rises (phones keep them queued, so nothing is lost, but people wait) |
| `quarantine_last_day` | Rejected location records kept without coordinates for review | Any sudden increase (a phone or app version sending invalid data) |
| `sessions.open`, `sessions.unresolved` | Attendance sessions now open; sessions needing a person's review | Unresolved keeps growing (nobody is reviewing) |
| `active_musters` | Musters not yet closed | A muster stays active long after the drill or incident |
| `reports_waiting` | Daily reports waiting for the foreman's answer | It keeps growing past the noon deadlines |
| `account_deletions.pending`, `oldest_requested_at` | Deletion requests not yet processed (normally about a day) | The oldest is more than 2 days old; the legal limit is 30 days |
| `security_flags_open` | Open flags by limit (someone reached a rate limit) | Not empty: run `npm run operator -- flags --reason "…"` and review each |
| `secrets_overdue` | Expired QR sessions, revoked badge keys and revoked push tokens not yet deleted | Not all 0: the hourly privacy job is not running |
| `organizations`, `active_projects`, `approved_enrollments`, `active_devices` | Size of the deployment | For capacity planning only |

The health check never returns names, phone numbers, email addresses, coordinates or attendance (pgTAP `029_security_privacy`, `030_secrets_rate_limits`).

## 2. Scheduled jobs (pg_cron)

| Job | Schedule | Does | Notes |
|---|---|---|---|
| `sitemuster-attendance-sweep` | every minute | Applies the time rules: unknown after 20 minutes, end-of-shift close-out, 24/7 review, visitor close-out | Does nothing on a database marked `development` |
| `sitemuster-report-deadline-sweep` | every 5 minutes | Marks unanswered daily reports NOT_CONFIRMED after the noon deadline | Same |
| `sitemuster-privacy-maintenance` | hourly at :17 | Runs these in order: deletes raw location fixes 24 h after receipt; flags reached rate limits, then purges old buckets; deletes old quarantine rows and reviewed flags; deletes expired QR/badge/push secrets; processes due account deletions | Runs in every environment |

You can also check the jobs in the SQL editor: `select jobname, schedule, active from cron.job;` and `select * from cron.job_run_details order by runid desc limit 20;`.

## 3. Logs

- **Edge Functions** write one JSON line per refusal or failure, with a request id, outcome code, counts and truncated ids only. Every line passes the privacy scrubber (`supabase/functions/_shared/log.ts`; `tests/security/edge-logging.test.ts`). They appear under Supabase → Edge Functions → Logs. A person reporting a problem can quote the request id shown in error responses.
- **Database**: refusals carry codes (`FORBIDDEN`, `RATE_LIMITED`, `LEGAL_NOTICE_NOT_APPROVED`, …), never data.
- **Audit**:
  - `app_private.audit_logs` records customer actions: approvals, corrections, muster, reports, consent and deletions. A database constraint keeps it coordinate-free.
  - `platform_operator_actions` records every operator call. It is append-only.

## 4. Crash reports (mobile)

Sentry receives crashes from the app with:
- no screenshots, no view hierarchy and no default personal data;
- every event scrubbed of coordinates, phone numbers, emails, codes, tokens, badge and QR payloads (`tests/security/crash-report-privacy.test.ts`).

Development builds without a DSN send nothing. A production build cannot be made without one.

## 5. Alerts

V1 has no paging service. Until one is chosen (a human decision with its own account), alerting is:

1. **Daily:** run the health check (§1). Act on any "look into it when" condition.
2. **Sentry alert rules** (human setup, `HUMAN_CHECKLIST.md` §6): email the owner on a new issue and on a crash spike.
3. **Supabase usage and log alerts** where the plan offers them: Edge Function 5xx rate, database CPU and disk.
4. **Twilio and Google** usage alerts at the monthly budget (`HUMAN_CHECKLIST.md` §4, §5). A sudden SMS spike is the classic sign of SMS-pumping fraud.

Not verified here: alert delivery itself (it needs those accounts). Everything in §1–§4 exists and is tested locally.

## 6. Incidents

Spec 09 requires a separate incident response and breach notification process. Its contacts are configured privately during human setup, never in this repository. Technical first steps for a suspected compromise of a phone or account:

```bash
npm run operator -- revoke-device <device id> --reason "<ticket>"
```

```bash
npm run operator -- mfa-reset <user id> --reason "<ticket, identity verified out of band>"
```

Revoking a phone stops its uploads, badges and kiosk use at once. Flags and audit rows are never deleted automatically, so the evidence stays available.
