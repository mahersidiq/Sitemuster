# 12 — Active Muster Mode (V1 supplemental emergency accountability)

## Non-negotiable principle

The app is **NOT** a certified emergency evacuation or life-safety solution. A push receipt or worker tapping "I'M SAFE" does not establish that they are physically accounted for at an approved assembly point. The UI must never silently change SELF_REPORTED_SAFE to VERIFIED_ACCOUNTED.

## Roles and triggers

Only a GC project-super/safety manager explicitly delegated emergency role (plus authorized org owner when assigned) may START/CLOSE a muster. Foreman can physically verify **own company** workers, supervised kiosk attendant can scan at assembly location, workers can self-report their own identity, visitors can be manually/kiosk verified. Platform operator has no access to muster PII. Limit one ACTIVE muster per project unless incident commander explicitly starts distinct event; concurrent tap must be idempotent.

## Start transaction

1. Operator selects project -> Muster -> Start Muster and confirms seriousness; record incident label, actor, local/UTC time.
2. In a transaction freeze snapshot of currently approved enrolled workforce and workers recently detected onsite/presence unknown (do not silently omit unavailable people), along with all open visitor visits. Store source, latest detection time, employer, and initial status `UNACCOUNTED` or `STATUS_UNKNOWN` as applicable, plus snapshot digest/version.
3. Trigger project-scoped push/in-app message to eligible worker devices: **Emergency muster — tap I'M SAFE** with bilingual locale. Interactive notification action can respond where supported (lock screen); in-app action always available. Notified/failed push status is audit/communication metadata only; no implied presence.
4. Open mobile live dashboard with counts by verification type, visitor counts, company breakdown and stale/uncontactable flags. Require no network dependency to continue physical roster checks; queue kiosk/foreman actions in `expo-sqlite` if offline.

## Response state machine

- `UNACCOUNTED`: on snapshot and not yet reported/verified.
- `SELF_REPORTED_SAFE`: response from worker's own authenticated app/notification, without physical verification.
- `VERIFIED_ACCOUNTED`: safety manager, authorized foreman or attended muster kiosk physically confirms matching identity at approved assembly location; record verifying actor and method. May supersede SELF_REPORTED_SAFE, never reverse without explicit audited correction.
- `STATUS_UNKNOWN`: record couldn't be reliably resolved because roster/conflicting identity/device unavailable; explicitly show separately.

All changes append immutable `muster_responses` with event UUID, who, which worker/visitor, method, time, device/outbox status and reason. No unauthenticated user may submit muster verification; kiosk uses signed worker badge (dynamic or marked printed) + human check, not GPS alone.

## Workers, visitors and failure modes

- A worker without phone is accounted for via foreman or attended kiosk; no assumption they cannot be onsite.
- A visitor/driver/inspector from visitor kiosk appears on separate muster snapshot with host and sign-in time; physical confirmation needed.
- Push may be late, blocked, denied or offline. App must not wait for notification delivery; safety team uses roster and physical checks.
- Worker not currently detected may nonetheless be included if in approved roster and last known state requires review; incident commander sees source and last seen.
- Time-sensitive UI must function with local offline queue for physical checks; when offline, badge and verification entries display PENDING_SYNC until server ACK, and counts label local/unverified vs server authoritative.
- Multiple foremen verifying one worker: idempotency and event ordering keep one current status, retain both actor audit entries.
- Foreman cannot verify workers outside approved company roster.

## Close-out and immutable report

Authorized commander presses Close Muster; must review unaccounted/unknown counts and explicitly acknowledge incomplete accounting, enter closing note, and confirm. Server writes `ended_at`, closed report with immutable snapshot, event times, responder identities, verification methods, unaccounted and unknown workers, visitor figures and push delivery limitations. Prevent edits to closed event; corrections create signed append-only amendment. Basic V1 screen/shareable textual summary; no advanced PDF report generator (V1.1).

## Acceptance tests

- Start -> 2 workers + 1 visitor -> one I'M SAFE, one foreman physically verified, visitor kiosk scanned: counters stay separated.
- Self-response cannot become verified without authorized human physical action.
- Push outage leaves in-app/kiosk/foreman functional.
- Non-role and cross-org request denied; platform operator denied sensitive roster.
- Two concurrent start attempts cannot create duplicate active event.
- Offline muster scans synchronize once with event UUID and server receipt.
- Close stores audited immutable report including unresolved personnel.
- All interfaces and notification content available EN/ES, with approved legal notice.
