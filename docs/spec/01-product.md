# 01 — V1 product, workflows, and acceptance

## Purpose and measurable outcome

SiteMuster replaces daily calls to subcontractor foremen for estimated manpower with a shared **mobile-first** record of project attendance. Its phone detection is approximate and must never be represented as a verified physical headcount. The superintendent can reconcile detected, kiosk, foreman, manual, and visitor activity and obtain explicit subcontractor confirmation. Every main workflow must run from one iOS/Android app; no web administration dependency.

**Launch terms:** free, unlimited registered projects and workers, no per-worker charge, later per-active-project billing without billing implementation. Roles: GC owner/admin, PM, superintendent, safety manager, subcontractor supervisor, worker, separate platform administrator service account. A person can hold multiple roles and participate in multiple GC organizations.

## V1 modules — implement, do not replace with mock UI

1. Phone-first auth: workers SMS OTP; GC staff verified email + TOTP MFA; supervised roster identity for no-phone workers; persistent login and session recovery.
2. Organizations/project creation, invite staff, assign authorized role; circular map geofence, IANA project timezone, one or more windows, 24/7 setting, project states DRAFT/ACTIVE/PAUSED/COMPLETED/ARCHIVED.
3. Orientation session and project enrollment: supervisor dynamic QR (60s), session-limited printed static QR (120-minute session); identity, company affiliation, trade, emergency contact, approved orientation/disclosure; employer confirmation and bulk approval separate, max 100 per operation.
4. Background geofence with phone-based entry/exit, 10-minute dwell, privacy, site-only approximate map coordinates when permitted; unavailable/unknown statuses are first-class.
5. No-phone/denied-location fallbacks: attended kiosk scans (dynamic or printed worker badge), foreman bulk roster action, superintendent manual corrections and supervised onboarding.
6. Visitor/inspector/delivery arrival and departure via attended kiosk; visitors always separate from workforce headcount, included in muster snapshot.
7. Super mobile: per-project estimated onsite, uncertain, authorized confirmed, arrivals, departures, subcontractors, roster, map, pending enrollments, stale status, close-out.
8. Daily reports by company with foreman CONFIRM/DISPUTE/CORRECTION; unresolved items and basic worker personal daily/weekly time CSV export with estimated/non-payroll labeling.
9. Active Muster Mode: event snapshot and targeted push + in-app response + physical verification via kiosk/foreman + signed closeout; distinctions between self-safe and physically verified.
10. English and Spanish throughout worker and staff UX, push templates and basic reports. Legal translation is human-approved before production.
11. Minimal operator-controlled platform-admin backend/CLI (not admin UI): org status search, device token revocation, invite resend, system health only; MFA and audit.
12. Staging and production isolation, telemetry, automatic tests, native builds, reviewer demo (synthetic only), deployment/runbook and 30-workday field pilot checklist.

**Explicitly excluded V1.1:** floor-plan files or floor positioning, polygon geofence UI, advanced CSV/PDF exports and platform admin UI. No construction CRM, payroll, budgeting, scheduling, RFI, marketing site or billing.

## Mobile navigation

**GC/superintendent tabs:** Home (selected project), Projects, Workforce, Map, More (Orientation, Reports, Muster, account/settings). **Worker tabs:** Home, My Projects, Time History, Profile. Foreman sees company-only roster and pending report confirmations. Kiosk is an authenticated attendant mode on a supervised staff phone/tablet; it cannot be a publicly unlocked app with privileged project records. Roles may coexist; explicit organization/project context selector and cache wipe on switch/revocation.

## Canonical user journeys and exceptional paths

**GC activation:** verify staff email + TOTP → organization record (idempotent) → new project with address and circular radius → timezone and schedule → invite site staff → open QR orientation. Retry/timeout does not create duplicate organizations/projects. Similar names/addresses warn but do not automatically block.

**Worker with phone:** receive project link or scan live/static orientation QR → verify 6-digit SMS (10-minute validity; 60-second resend) → enter name, employer/trade, emergency contact, select language → consent to project disclosure → orientation completed → await actual enrollment approval and employer confirmation → enable tracking only after authorized approval → automatic presence where OS permits. No automatic authorization from having a code.

**Worker without phone:** attended kiosk/foreman records minimal supervised identity, employer, approved enrollment, emergency contact and orientation disclosure acknowledgment; a printed opaque badge is issued with custody policy; foreman/kiosk creates per-visit attendance without phone GPS; worker may claim/merge identity later after verified authentication. Never fabricate phone or email.

**Worker denies tracking:** account/enrollment work normally, worker can request kiosk, foreman or manual source. Do not coerce permissions, omit worker from roster or invent presence.

**Kiosk day:** attendant authenticates; chooses project; scans the worker's offline-capable 30-second in-app badge (generated on the worker's phone with no network required) OR printed badge (flag source and verify face/name) → choose ENTRY/EXIT → add deterministic unique event ID to expo-sqlite operational outbox → receive authoritative success or conflict state; kiosk offline status conspicuous, later sync, no offline 'verified by server' claim. Visitors have distinct short form.

**Foreman day:** authorized foreman selects only own active company members, records named entry/exit with timestamp, optional onsite physical confirmation and reason. Bulk actions are one batch with per-worker idempotency. GC can see foreman-source confidence, not GPS equivalence.

**Location day:** arm monitored region, detect current-position already-inside, ENTER creates ARRIVING, two eligible fixes >=10m apart confirm session beginning with first fix's timestamp; no headcount during dwell; outside schedule creates UNSCHEDULED_PENDING; 24/7 bypasses hours check only; exit timestamp uses qualifying observed EXIT, unknown when not reliable. Device lost => PRESENCE_UNKNOWN, not automatic checkout. Approximate map shows timestamp+accuracy, never precise floor.

**Daily close-out:** shift end+60m marks stale sessions UNRESOLVED, GC reviews with foreman; reports due by 12:00 next project workday for explicit company confirmation; no answer NOT_CONFIRMED. 24/7 sites use 16h open session +20m staleness to request review, never assumed departure.

**Safety incident:** authorized manager triggers muster; immutable roster snapshot of approved & recently present + visitors; worker push and in-app self-report => SELF_REPORTED_SAFE, physical kiosk/foreman confirmation => VERIFIED_ACCOUNTED; UNKNOWN and UNACCOUNTED distinctly tracked. Complete immutable report on close. Supplement only: not emergency dispatch, not certified life-safety equipment.

**Account exit/deletion:** immediate revoke sessions/device + project visibility, prevent background upload, remove identifying profile/contact within 30 days, raw fixes purge after session closes within 24h; attendance only retained where lawful basis/hold warrants pseudonymization, otherwise deleted. Display worker's own export before deletion.

## Product metrics and pilot gates

- 100 workers enrolled in a 60-minute supervised drill using multiple attendants; SMS failures use fallback.
- Target >=80% successful registration/attendance through any supported method in initial adoption pilot. This is adoption target, **not GPS headcount accuracy**.
- Track true physical verification, GPS estimated, uncertain, missing, foreman disputed, manual corrected separately.
- Field pilot: one project minimum, at least two subcontractors, representative iOS/Android phone mix, manually verified daily reference counts; log detected-event latency, false entries/exits, battery impact, missing events and correction burden.
- Before expanding beyond 10 pilot GCs, obtain >=3 written expressions of willingness to pay at a specified eventual project price. No pricing/payment UI in V1.

## Availability & status UX

Always show server sync freshness and classification; an offline device is not 'absent'; a stale map marker is not 'live'; self-safety acknowledgement is not physical muster verification. Every emergency/security-sensitive action requires project authorization. No employee outside-site movement trail is stored or displayed.
