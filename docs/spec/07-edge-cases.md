# 07 — Complete edge-case / failure matrix

Every row is a required behavior; every simulated case has a deterministic fixture or integration test, and native-only cases have a physical-device checklist. No GPS-only workaround may suppress attendance fallbacks. Existing Round 1–4 cases are additive, not replacements.

| Scenario | Locked behavior | Mandatory validation |
|---|---|---|
| Worker denies background location | Account/orientation allowed; GPS auto-attendance off; visible kiosk/foreman/manual fallback; no false present count | permission-denied trace + phone manual |
| Worker grants foreground-only location | Explain Always upgrade; do not claim background geofence enabled; allow fallback | permission-state unit + platform manual |
| Worker switches iOS Precise OFF or Android approximate | Block GPS auto attendance; monitoring unavailable; fallback | reduced-accuracy phone manual |
| Worker disables location services | Detect when next allowed, report unavailable; no guessed exit | provider-change replay |
| Worker closes/terminates iOS app | Use supported native lifecycle; document force-quit limitation; no guaranteed restart | physical iPhone test |
| Android force-stop | Cannot promise boot/service restart from force-stop; status unknown; kiosk/foreman | physical Android test |
| Android OEM battery killer | Provide OEM instructions and detect stale signal; don't bypass user restrictions | Samsung/Xiaomi/OEM test |
| Worker reboots phone | On supported Android resume native queue after unlock; iOS delayed OS wake; reevaluate already inside | native restart checklist |
| Worker replaces phone | Atomically revoke old personal device, issue new scoped credential, reconcile open session, reject old uploads | device race integration |
| Worker loses phone | Presence becomes unknown after freshness, retain roster, revoke credential via staff service | revocation test |
| Phone battery dies | Last seen recorded; unknown, not departed; closeout review | 20m silence replay |
| Worker has no smartphone | Supervised identity enrollment + printed badge/kiosk/foreman paths; no fake auth | no-phone E2E |
| Worker has smartphone but no email | Worker SMS OTP works; email optional | SMS signup E2E |
| Worker has no SMS-capable phone | Supervised kiosk identity; no invented phone number | supervised kiosk scenario |
| No internet onsite | Native SDK queue location; expo-sqlite outbox operations; offline visible, later idempotent sync | airplane-mode replay |
| Events arrive out of order | State machine orders with observed+received times, clock skew, config snapshot, flags conflict | trace permutations |
| Duplicate native geofence ENTER | Unique event UUID + session unique prevents double count | duplicate ENTER replay |
| Duplicate geofence EXIT | No double closure; duplicate ACK | duplicate EXIT replay |
| Worker leaves and reenters | Separate sessions; no overlapping open sessions | two visits replay |
| Worker crosses midnight | UTC interval, local reporting daily overlaps correct | 23:00–04:00 replay |
| Worker crosses DST boundary | Elapsed hours based on UTC, exact local zone day attribution | DST fold/gap tests |
| Worker at property/geofence edge | 150m min radius, 50m hysteresis, 10m dwell + <=75m accuracy; ambiguous => review | GPS jitter replay |
| Two active project geofences overlap | Ambiguous project => no auto double count; select and validate assignment | two-project trace |
| Worker has 30+ enrolled sites | Prioritize 15 iOS/75 Android active native regions; show monitoring coverage limitation | scheduler tests |
| Two workers share a phone | Phone does not establish simultaneous distinct attendance; use individual kiosk/foreman | shared device identity test |
| Worker leaves phone in vehicle | GPS evidence marked estimated; kiosk/foreman physical check needed | physical-reference pilot |
| Worker disables tracking mid-shift | No invented exit; stop sharing and mark unknown/unresolved | permission revocation trace |
| Worker terminated or unenrolled | Reject future events, terminate access, reconcile existing sessions without invention | revoke while queued test |
| Worker switches subcontractor | Preserve historical employer snapshot, verify new affiliation | membership update integration |
| Superintendent adjusts worker time | Append reason/actor/old/new audit; version report | correction integrity test |
| Worker enrolled with multiple GCs | Per-project consent/access; correct app context and config versions | cross-tenant RLS |
| Supabase/backend unavailable | Queues retain events, read UI clearly stale, retry; no false success | 503+recovery trace |
| Realtime disconnects | Refetch authoritative status after reconnect; stale marker not live | channel reconnect test |
| Worker signs out onsite | Stop authorized sharing, revoke credential when appropriate, unresolved session | logout onsite test |
| Device local time incorrect | Store server receipt and observed; skew >5min flag, no silent backdate | clock skew replay |
| Orientation QR leaks | Time-boxed session, static only during open, no auto approval, revoke/rotate | expired QR integration |
| Dynamic orientation QR replay | 60s rotation; expired rejected, still needs actual approval | QR replay test |
| Printed static orientation poster | Valid only while current 120m session open; ORIENTATION_COMPLETED only | session-end test |
| In-app badge screenshot/buddy punching | 30s HMAC time-step badge, single use per step, attended kiosk; distinguish from proof of worker body | badge replay test |
| Worker phone has no signal at gate kiosk | Badge is generated offline from the device badge secret; kiosk queues scan in outbox as PENDING_SYNC; server verifies HMAC + step window on sync | offline badge test (worker + kiosk both offline) |
| Kiosk clock wrong | Server compares kiosk observed_at to received_at; skew >5 min => badge accepted only as REVIEW_REQUIRED, never silently verified | kiosk skew test |
| Printed badge copied/buddy punching | Flag KIOSK_PRINTED_BADGE + human face/name check, lower confidence, audit kiosk actor | printed badge E2E |
| Worker geolocation spoofed | Detect impossible speed, mock flag, suspicious jumps; audit flag, no tamper-proof claim | spoof trace |
| Project archived/completed | Stop new monitoring and enrollment; preserve authorized records | lifecycle integration |
| Project boundary modified mid-shift | Immutable versions; existing session uses old config; new sessions use new | config replay |
| Worker deletes account | Immediate revoke, >=24h raw purge, profile/contact erase <=30d, retain only justified pseudonymous time | deletion integration |
| Map provider fails | Attendance works; map fallback indicates unavailable | map adapter failure |
| Push provider fails | Muster in-app and kiosk work; don't rely on push for accountability | notification failure test |
| Permission revoked in phone settings | App recovers state when allowed, stop sending current coords; record unknown | native settings manual |
| Worker enters before approval | No accepted worker attendance until eligible, orientation still recorded | approval gate test |
| Worker enrolls already onsite | Arm/rearm current qualified fix+10m dwell, no invented earlier arrival | already-inside replay |
| App updated during shift | Pending queues and sessions persist; config migration safe | upgrade E2E |
| HTTP mutation retries | Unique UUID, single server effect per event | replay identical API |
| Project owner leaves organization | Secure transfer, at least one owner; no orphaned tenant | last-owner test |
| Work performed Sunday/off hours | UNSCHEDULED_PENDING; staff approval before count, no silent rejection | overtime replay |
| 24/7 worker shift lasts 20h and device stale | 16h+20m stale prompts unresolved review; no invented exit | 24-7 trace |
| Shift spans midnight and DST | Versioned windows, local weekday and UTC sessions stable | window engine fixtures |
| Exit event with no coordinate confidence | Duration remains uncertain, last inside != exit; manual closeout | uncertain departure replay |
| SDK native batch has one malformed event | Durably quarantine rejected record then 200 batch only if all terminal, no poison infinite retry | mixed batch API test |
| SDK 2xx ACK for mixed results | SDK deletes whole batch; durable terminal outcomes for every record before 200 | SDK contract mock |
| Credential for project A tries B | Resolve from credential, reject mismatched geofence, no B read/write/ack | cross-project Edge integration |
| Device credential expires in background | Multi-path renew (foreground / silent push / SDK headless), 7-3-1 day reminders, roster CREDENTIAL_EXPIRING flag; at expiry report unavailable, no unbounded unapproved collection | token expiry test |
| Worker never opens app for 30+ days | Silent-push renew attempted; visible reminders; foreman sees roster flag before expiry | expiry-without-foreground test |
| Token renewed while 25 records queued | setConfig header swap + 24h old-token overlap; zero loss, zero duplicate | mid-queue rotation test |
| Device credential stolen | Only hash stored server, rotate/revoke, abuse rate limits, device forensic audit | credential compromise test |
| Background task runs while iPhone locked | SecureStore AFTER_FIRST_UNLOCK with native upload credential; no WhenUnlocked JS access needed | locked iOS device test |
| iPhone restarted but not first unlocked | No key access until first unlock; no false sync guarantees | boot-before-unlock checklist |
| Native SDK uploads offsite EXIT coordinate | Geofence template strips coords; HTTP trace shows no offsite data; disable continuous coords if not proven | network payload privacy test |
| Continuous onsite tracking still sends fix after exit | Native egress gate + mode transition; if unproven block live location release | delayed callback network trace |
| Multiple tracking queues disagree | SDK owns GPS only; app outbox owns operations, independently idempotent; combined status | queue ownership integration |
| Kiosk offline during rush | Durable expo-sqlite queue; per-worker results; attendant sees unsynced records | kiosk offline E2E |
| Foreman submits same crew twice | Per-person event UUIDs; dedupe; no double count | bulk idempotence test |
| 100 workers arrive at 6:30 AM | Scale SMS throughput >=200 signins/hour, concurrent multiple kiosk attendants, batch approval <=100 | 60-minute enrollment rehearsal |
| Twilio OTP unavailable/rate-limited | Supervised onboarding + badge; disable SMS retry storms and show bounded resend | OTP provider failure |
| Foreman disputes headcount | Report version + reason + proposed correction; no automatic modification | report dispute E2E |
| Foreman ignores daily report | NOT_CONFIRMED at local noon next workday, never auto-approved | deadline scheduler test |
| Visitor sign-in unclosed | Separate visitor visit unresolved and muster appearance | visitor closeout test |
| Visitor has no app | Attended kiosk still works; no push requirement | visitor kiosk E2E |
| Worker says I'm Safe remotely | SELF_REPORTED_SAFE only; physical verification separate | muster status test |
| Push muster notification missing | In-app roster plus kiosk and foreman physical verification; never auto-safe | push outage muster |
| Muster fired twice concurrently | Transactionally enforce no conflicting active event or explicit separate event; auditable | concurrent muster test |
| Review simulation tries live project | Server-only demo-org allowlist, fail closed, synthetic roster only | demo cross-tenant test |
| Spanish consent has not been reviewed | Staging drafts allowed, production can't enroll on unapproved legal text | legal approval gate test |
| Platform admin tries worker GPS query | Deny and audit, no accidental view grants | platform-admin RLS |
| SDK/Expo version changes during build | Dedicated upgrade PR with CI/native validation; otherwise pinned lockfile | dependency CI |
| CI Docker unavailable in the local Claude Code environment | CI ubuntu runner does supabase start/pgTAP; PR blocked if unavailable in Actions | CI runner proof |
| Native device tests unperformed | Do not mark pilot done; separate manual checklist and gate store release | release checklist |

## Failure handling escalation

Severity 0 (security, privacy or false emergency claim): deny operation, log sanitized audit and block release. Severity 1 (lost events, duplicate payroll-like time, cross-tenant): preserve queue, flag for reconciliation and block production. Severity 2 (map/provider down): keep attendance available and report degraded status. Never silently skip failed work.

## Deterministic replay coverage

Milestone 06 creates at least **55** GPX/JSON fixtures with frozen wall-clock+UTC time, network toggles, event order permutations, schedule/config version, and expected state/session/count outputs. Every location/attendance row above must map to an automated test when simulatable; non-simulatable OS/device scenarios require a labeled manual checklist in Milestone 13.
