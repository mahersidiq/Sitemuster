# 04 — Attendance, presence, review and reporting rules

## Core data separations

**Enrollment**: pending/completed/approved/rejected/revoked. **Consent**: version, accepted/withdrawn. **Monitoring**: not armed/armed/permission blocked/device unknown. **Presence**: ARRIVING, ONSITE_ESTIMATED, UNSCHEDULED_PENDING, PRESENCE_UNKNOWN, DEPARTURE_PENDING, OFFSITE, UNRESOLVED. **Attendance**: provisional, confirmed-by-system, manual/foreman/kiosk witnessed, disputed, corrected. **Muster**: entirely separate from attendance. Do not collapse them into a single boolean `is_on_site`.

## Sources and confidence

| Source enum | Meaning | Audit requirements |
|---|---|---|
| `GEOFENCE` | Native phone evidence + dwell; approximate | device ID, observed/received times, config version, accuracy, signal confidence |
| `KIOSK_DYNAMIC_BADGE` | Attended scan of worker's offline-capable 30s HMAC in-app badge | kiosk operator, project device, (device, time_step) single-use, identity confirmation |
| `KIOSK_PRINTED_BADGE` | Attended scan of static printed opaque badge | operator, printed flag, visual identity check, buddy-punch warning |
| `FOREMAN` | Authorized foreman identifies named own-company crew on/off site | actor, employee IDs, reason and per-worker confirmation method |
| `MANUAL` | Authorized superintendent corrective entry | actor, explicit reason, audited before/after, optional approval |
| `VISITOR_KIOSK` | Separate visitor entry/exit, never workforce counted | attendant, visitor ID, organization, host, purpose |

Original source retained permanently with attendance event. Any approval is an additional correction/verification event, not overwriting original source. Duplicate event cannot multiply a headcount.

## GPS arrival algorithm

1. Approved enrollment and consent required; area overlaps and high error reject auto-count.
2. Native ENTER or already-inside qualified fix => `ARRIVING`; log first qualified inside timestamp, not counted yet.
3. Second qualified onsite fix >=10 minutes after first, accuracy <=75m and consistent within configured geofence; stable context/shift; server transaction validates current config version.
4. If confirmed, create session `arrival_at=first_qualified_inside_at` (not time of second fix). The dashboard then counts as `ONSITE_ESTIMATED`, with explicit observed vs confirmed-at timestamps.
5. Outside authorized shift + grace => `UNSCHEDULED_PENDING`, never auto-count until authorized person approves overtime; do not discard evidence.
6. A location within 150m of geofence center can still be outside property. GPS status is **estimated**, not verified physical attendance.

## GPS departure algorithm

- A native EXIT from the buffered fence (radius + hysteresis, see `03-location-engine.md`) whose payload `accuracy` <= `max_horizontal_accuracy_m` produces `departure_at=exit_observed_at`. The EXIT payload contains NO coordinates; corroboration = buffered native fence + reported accuracy + state consistency. Accuracy worse than the limit or missing ⇒ `DEPARTURE_PENDING` with `departure_earliest_at=last_confirmed_inside_at`, `departure_latest_at=exit_observed_at`. Do NOT use last inside location time as departure.
- If EXIT is missing, delayed, contradicts inside fixes or overlaps another geofence, set `DEPARTURE_PENDING`/`UNRESOLVED`. For ranges of uncertainty, save `departure_earliest_at` and `departure_latest_at` only when actual evidence supports bounds; keep `departure_at=NULL` unless verified.
- A dropped phone signal => `PRESENCE_UNKNOWN`, never departed. On location permission withdrawal, stop sharing and put attendance in review.
- Restart/first launch already-inside creates new monitored observation without backdating hours.

## Kiosk / foreman / manual state transitions

- Each scanned event is `ENTRY` or `EXIT` with individual named worker, project, operator and single-use operational outbox UUID.
- Dynamic badge validated server-side (on receipt or later sync) against device badge secret HMAC, worker's active device, approved project enrollment, ±1 time-step window relative to kiosk observed_at, and (device, step, project) replay, with operator-attended kiosk mode. Works with BOTH phones offline. Printed badge always flagged weaker evidence; printed code never directly authenticates a privileged account.
- Foreman may bulk-select only approved members of **own** company; batch returns per-member accepted/duplicate/rejected, never blindly turns whole batch green. If offline show Pending Sync, not Confirmed.
- Manual correction needs reason, actor, event history and proper role. Any existing GPS open session is reconciled rather than creating contradictory active sessions. Maximum one active session per worker per project, enforced with partial unique DB index/transaction.
- Worker without smartphone may have managed roster identity and printed badge; no fabricated SMS/consent claim. Signed paper or in-person acknowledgment recorded by operator under reviewed legal procedures.

## Work shifts, grace and 24/7

- Project shift rules are a **list** of local weekday+start/end windows and may cross midnight; default Mon–Sat 06:00–18:00; grace 60 minutes before/after for authorized detection. 24/7 projects bypass schedule restriction but retain dwell+accuracy.
- Shift boundary does not force a fabricated exit. At end +60m, stale open sessions become `UNRESOLVED`, and end-of-day close-out opens for super/foreman. On 24/7 sites, any still-open session >=16h with >=20m stale becomes review-required UNRESOLVED; never automatic departure.
- All persisted times are UTC; local presentation and next-workday noon computed in project IANA zone and DST-aware (e.g., overnight shift crossing DST). Server records zone and shift snapshot when session starts.

## Aggregations

- `approved_roster_count`: currently approved enrollments (not presence).
- `estimated_onsite_count`: unique non-conflicting approved worker sessions with current supporting evidence, including kiosk/foreman/manual when acknowledged; show breakdown by source.
- `presence_unknown_count`: approved people whose last meaningful evidence is stale >=20m or contradictory, not automatically offsite.
- `manually_verified_count`: independently confirmed named physical presence at time of verification (not deduced from GPS).
- `daily_unique_count`: unique enrolled worker IDs with accepted session evidence overlapping selected local calendar day.
- `peak_estimated_count`: max overlapping supported sessions, with confidence caveat; exclude unresolved ambiguous intervals where duration cannot be bounded.
- `estimated_worker_hours`: sum of accepted definite intervals; unresolved segments excluded and separately itemized. Distinct from payroll/compensable work hours.
- Visitors always separate from subcontractor labor counts, but show in emergency roster and visitor subtotal.
- Never double-count worker if GPS and kiosk independently report same presence; synthesize one worker presence with corroborating evidence/events.

## Report and confirmation lifecycle

- Per-project daily company report created from authoritative sessions, with source, corrections and uncertainty visible.
- Foreman receives `PENDING_CONFIRMATION`; can `CONFIRM`, `DISPUTE`, `SUBMIT_CORRECTION`. Submission due 12:00 PM next local workday by configured work windows; non-response `NOT_CONFIRMED`, not auto-approved.
- Correction request produces proposed adjustments, original record remains auditable; GC staff can resolve and reissue report with incremented version, keeping prior confirmation history.
- Do not describe report as contract-proof, back-charge entitlement, certified payroll or guaranteed headcount.
- Worker gets daily/weekly own per-project estimated duration and **basic personal CSV** through native share, own corrections and status. No advanced PDF reporting in V1.

## Config snapshots and event truth

Every event stores `config_version_id`; every attendance session has `config_version_id` selected at session start; if config changes mid-session, old rules continue until it ends. Historical reports show applied version. No retroactive recalc. Daily report revisions and manual corrections always audit actor/reason/time.
