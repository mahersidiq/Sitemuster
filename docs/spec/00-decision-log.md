# SiteMuster binding decisions — rounds 1–4

All items below are accepted final decisions. A numbered decision overrides earlier draft language; detailed specs cannot weaken it. `V1.1` is expressly out-of-scope.

**1.** Mandatory no-phone attendance: attended kiosk scans, foreman bulk crew check-in/out, superintendent manual entry. Sources GEOFENCE, KIOSK_DYNAMIC_BADGE, KIOSK_PRINTED_BADGE, FOREMAN, MANUAL; every mutation records actor, device, time, confidence, event UUID and original source. No-phone workers enrolled through supervised identity workflow.

**2.** English and Spanish at launch; expo-localization, i18next, react-i18next, explicit first-launch choice, persistent language switch, all UI/push/reports localized. Human-approve Spanish legal content.

**3.** Worker primary login: Supabase Phone Auth with Twilio six-digit OTP, 10-minute expiry, 60-second resend cooldown, abuse throttles and throughput >=200 orientation sign-ins/hour tested; worker email optional. Staff: verified email + mandatory TOTP MFA. No-phone workers use supervised roster and kiosk badge, not invented SMS accounts.

**4.** 120-minute Orientation Session; rotating supervisor QR 60 seconds, bulk approval <=100 workers. Orientation QR produces ORIENTATION_COMPLETED only; project APPROVED and employer VERIFIED are distinct administrator actions. Printed static QR allowed only while session open; it also never auto-approves.

**5.** Per-project work windows with shifts and grace; default Monday–Saturday 06:00–18:00 project time, 60-minute grace. Entry needs 10-minute dwell and two good fixes. Outside schedule becomes UNSCHEDULED_PENDING; authorized person approves overtime. 24/7 sites bypass schedule restriction, not dwell.

**6.** At scheduled shift/window end plus 60 minutes, any stale open sessions become UNRESOLVED with last_seen_at, not fabricated exits; close-out screen and foreman verification. For 24/7, open session with >=20 minutes stale and duration >=16 hours becomes UNRESOLVED for close-out review; this is a review trigger, not a departure.

**7.** Each day's trade/contractor report gets foreman CONFIRM, DISPUTE, SUBMIT_CORRECTION; due 12:00 next local workday, silence NOT_CONFIRMED. Evidence only, not automatic back-charge entitlement.

**8.** Workers can see personal daily/weekly per-project estimated hours, request corrections, export basic personal CSV. Label as estimated onsite presence, not payroll/compensable hours.

**9.** Visitor/inspector/delivery driver attended kiosk check-in/out, limited info, emergency roster, separate visitor count and no participation in trade labor totals.

**10.** Project-specific versioned consent, EN/ES, configurable GC notice, accepted terms version/user/project/time, refusal/revocation supported, not for payroll; union/CBA/state monitoring-law and GC/subcontractor DPA reviews. Raw coordinate retention maximum 24h after closed session; ordinary attendance two years ONLY where documented legal/contractual basis warrants, otherwise shorter/delete. Legal hold policy and account deletion.

**11.** Exact stack mandated in CLAUDE.md: Expo/React Native/TypeScript; expo-router; Transistorsoft v5; expo-sqlite; expo-secure-store; supabase-js; TanStack Query; Zod; react-hook-form/resolvers; react-native-maps; expo-camera; react-native-qrcode-svg; i18next/react-i18next/expo-localization; Sentry; Maestro; pgTAP/Supabase CLI; Vitest/Jest/RNTL.

**12.** Transistorsoft react-native-background-geolocation v5 native background engine for V1, with licensed Android release; stopOnTerminate:false, startOnBoot:true, enableHeadless:true Android; native persistent HTTP sync. Force-stop/OEM restrictions cannot be defeated; kiosk fallback and unknown status. Avoid expo-location as main engine.

**13.** iOS SecureStore AFTER_FIRST_UNLOCK, no biometric gating for background upload; store AES-256-GCM key there and large auth sessions encrypted in SQLite. Separate server-revocable 30-day device credential, renew <=7 days left (multi-path renewal per #44); native HTTP never depends on unlocking UI or 30-second background JS session refresh. Fail closed on expiry/revoke.

**14.** iOS Always permission requested after When In Use explanation; Full Accuracy required for automatic attendance. DesiredAccuracy.High, 25m distanceFilter, Fitness activity, pausesLocationUpdatesAutomatically true, showsBackgroundLocationIndicator true and UIBackgroundModes location. User alerted to OS background reminders. Continuous onsite updates only with authorized session; OS does not provide guaranteed 2-minute wakeups.

**15.** Android 10+ separate background permission, Android 11+ Settings path, 12+ precise gating, 13+ notification permission, 14+ foreground-service location permission/type with visible notification when service used. Google Play declaration/video, OEM restriction instructions, no promise of recovery from force-stop.

**16.** Already-inside reconciliation: evaluate qualified current position on initial arm/rearm, project change, app foreground, reboot recovery and after sync if most recent fix >5 minutes old; apply dwell, never backdate without first qualified evidence.

**17.** Lock numeric global config and per-project override in 06-config-defaults.md, with source-defined min/max, dwell, precision, freshness, queue age, retries, work windows and sampling values. Never silently invent thresholds.

**18.** Deterministic GPX/JSON location trace replay harness with >=55 fixtures is primary automated location-engine test. Hidden dev-only simulated entry/exit screen; no simulation compiled into production. Owner conducts physical iOS/Android tests using written checklist.

**19.** Private Supabase Realtime Broadcast via realtime.send/broadcast_changes and realtime.messages RLS; topic project:{uuid}; payload only IDs/aggregate counts/version, no worker names/contacts/coords; clients invalidate TanStack Query cache and fetch authorized records.

**20.** Two separate Supabase Pro projects staging/prod; Twilio SMS costs and abuse budgets tracked. Three-project/150-worker pilot planning estimate $51–$120/month, reserve $150–$200/month excluding one-time SDK/license/dev devices and labor; costs indicative, no price promise.

**21.** Deliver permanent CLAUDE.md, numbered docs/spec/00..12, short scoped docs/tasks/milestone-01..13. Claude Code reads necessary specs per task, opens one PR, stops. No single huge prompt.

**22.** Do not upload or reuse starter ZIP; clean GitHub repository, written specs as source of truth; old desktop-first prototype intentionally excluded.

**23.** Separate queues: Transistorsoft native SQLite + HTTP owns location/geofence events only; expo-sqlite outbox owns kiosk, foreman, manual, visitor, muster, and other offline operational mutations. Unified sync UI, no duplicated ownership.

**24.** POST /functions/v1/ingest-location-batch; custom 32-byte random device bearer token stored SHA-256 hashed, JWT verify disabled only on this Edge Function; server resolves worker/device/project from credential. SDK batch max 25 and 256 KB; 60 requests/min/device, 600 events/hour/device; unique event_uuid idempotency. Result accepted|duplicate|rejected with reason; 2xx only after entire batch durably terminal because SDK acks whole batch, 429/503 retries, 401 rejects invalid credentials.

**25.** Arrival = timestamp of first qualified inside fix only after second qualified fix >=10 minutes later. ARRIVING excluded from counted headcount. Departure = timestamp of corroborated EXIT event, not last inside fix; absent reliable exit store interval/uncertain state. Keep last_confirmed_inside_at separately.

**26.** Work windows are multiple per-project shifts, may cross midnight, and 24/7 flag disables schedule restriction but not dwell. All boundaries UTC internally with project-local IANA conversion.

**27.** One active personal tracking device per worker. Activating new device atomically revokes old upload credential, flags current session for reconciliation, rejects old device events; shared kiosk has independent device registration.

**28.** In-app account deletion revokes sessions and credentials immediately, deletes profile/emergency contacts within 30 days; raw fixes follow 24h retention; retain and pseudonymize attendance only where justified by legal/contractual basis or hold, else delete. Pseudonymous records remain access restricted.

**29.** Immutable project_tracking_config_versions, effective_at and author; every attendance event and session stores config_version_id; changes affect new sessions only, no retroactive recalc.

**30.** Google Places Autocomplete (New) + Geocoding via authenticated Edge Function, server API key; Expo Push Service + expo-notifications; expo-print/expo-sharing selected for future advanced PDF/basic native sharing; working IDs com.sitemuster.app.dev and com.sitemuster.app, do not buy Transistorsoft release license until name/bundle cleared.

**31.** V1 active Muster Mode: authorized safety manager/super triggers snapshot, pushes to eligible workers, in-app and lock-screen I'M SAFE where supported, kiosk assembly scans, foreman physical checks, separate VERIFIED_ACCOUNTED/SELF_REPORTED_SAFE/UNACCOUNTED/STATUS_UNKNOWN and visitor roster; immutable close/report. Self response never physical verification; not certified life-safety.

**32.** Minimal V1 platform_admin backend/CLI operations: organization lookup limited metadata, revoke device credential, resend invite, status; MFA, audit every action, no worker coords/contacts or impersonation. Admin UI V1.1.

**33.** At Milestone 01 select latest stable compatible Expo SDK and exact dependencies, record actual versions in CLAUDE.md, commit npm package-lock, no mid-build SDK upgrades except dedicated upgrade PR.

**34.** V1: auth, org/project/circular geofence, orientation/bulk approval, native location, kiosk/foreman/manual, visitors, mobile dashboard/map, muster, daily report/foreman confirmation, basic worker hours CSV, EN/ES, admin CLI. V1.1 excluded: floor plans, advanced CSV/PDF reports, admin UI, polygon geofences.

**35.** Every PR has plain-English summary, phone manual test steps/expected outcomes, green CI, unverified items, UI proof if needed; Claude Code never merges own PR and stops after each milestone.

**36.** Human checklist documents ordered GH, Expo/EAS, Supabase staging/prod, Twilio/A2P, Google Cloud, Sentry, Apple, Google Play, brand, Transistorsoft, secret destinations. Missing service mocked behind typed dev interface; production fails closed.

**37.** scripts/setup-dev.sh bootstraps workspace safely; GitHub Actions ubuntu runner uses Docker/supabase start and pgTAP/RLS/integration; Claude Code reports test execution environment honestly.

**38.** Reviewer-only synthetic demo organization and server-gated simulated entry/exit; clear labeling not real GPS, safe seeded credentials, Apple review notes and Google background-location video script. No simulation writes to live customer data or proves native behavior.

**39.** Custom-auth Edge Function derives worker/device/project from credential before ANY privileged operation, scopes every read/write and disallows untrusted organization/project IDs; cross-project tenant tests mandatory.

**40.** Claude Code drafts EN/ES legal disclosures; Spanish drafts marked requires human review in docs/legal/TRANSLATION_REVIEW.md, reviewed/approved statuses and version/reviewer/audit. No production consent using unapproved ES legal text.

**41.** Thirteen scoped PR milestones in docs/tasks, location deterministic engine before dashboard, kiosk/foreman fallback before muster. Every milestone includes acceptance, human dependencies and stop-after-PR rule.

**42.** Remaining five risks: worker consent refusal => fully functional fallback; false precise headcounts => explicit uncertain/manually verified statuses & pilot; orientation bottleneck => 100 workers/hour throughput rehearsal; multiple employer/project identity fraud => device uniqueness, server memberships/audit; free users not paying => before >10 pilot GCs obtain >=3 written willingness-to-pay expressions at named future project price. No V1 billing.

## Post-review fixes (binding, override earlier text)

**43.** Worker in-app badge is generated OFFLINE on the worker phone: 30-second HMAC time-step code from a per-device `badge_secret` issued at device activation. Kiosk queues scans; server verifies MAC, ±1 step window and single use on sync. Reason: gate kiosks have the worst reception. Replaces the server-issued badge JWT and the `worker-badge` endpoint.

**44.** Device upload credential renewal is multi-path (foreground, silent push, SDK headless task), with 7/3/1-day visible reminders, roster `CREDENTIAL_EXPIRING` flag, 24h old-token overlap and mandatory `BackgroundGeolocation.setConfig` header update after rotation. Reason: workers whose tracking works never open the app.

**45.** One native fence per project with radius = `geofence_radius_m + exit_hysteresis_m`. Native EXIT carries `accuracy` but no coordinates; hysteresis is enforced by the fence geometry itself. Reason: resolves conflict between exit corroboration and the no-offsite-coordinates rule.

**46.** Supabase CLI version pinned in `supabase/.cli-version`; CI rejects `latest`.

**47.** Build tool is **Claude Code**, not Codex. Repository rules file is `CLAUDE.md`. Every reference to the coding agent means Claude Code. Workflow unchanged: one milestone per PR, stop, human merges.

## Two accepted QR amendments (B revised by #43)

**QR amendment A:** Dynamic QR on superintendent phone rotates 60 seconds by default. Printed static orientation QR valid only while its 120-minute session is open; both produce ORIENTATION_COMPLETED, never automatic worker or company approval.

**QR amendment B (revised, see #43):** Worker in-app badge is an offline-capable 30-second HMAC time-step code derived from a per-device badge secret, single-use per (device, step, project), verified server-side. Printed badge is an opaque permanent identifier, source KIOSK_PRINTED_BADGE, attended/operator-confirmed, lower confidence; no pretense of anti-buddy-punch perfection.

## Owner decisions after the spec package (binding)

**48.** Autonomy mode (owner decision, 2026-11-03). Overrides ONLY three rules: (1) "stop after each milestone" (#21, #35, #41, CLAUDE.md workflow step 4, `docs/tasks/HOW-TO-RUN.md`); (2) "Claude Code never merges its own PR" (#35, #47, CLAUDE.md workflow steps 2 and 6, "Never `gh pr merge`"); (3) "start in plan mode and wait for the owner's OK". Claude Code runs milestones 01 through 13 in order without waiting. For each milestone it writes a short plan into the PR description, implements on branch `milestone-NN-<name>`, runs every check locally, opens a PR, watches CI and fixes failures until green. It may squash-merge its own PR ONLY when ALL are true: required CI checks are green; the milestone's acceptance tests pass; the PR checklist is fully filled in; no security, privacy, RLS or cross-tenant test is failing or skipped. Never force-push `main`, never bypass branch protection, never disable or delete a test or CI step to get green, never weaken a spec to pass. Every other rule in CLAUDE.md and `docs/spec/` stays binding (locked stack, banned patterns, privacy rules, the 55+ replay fixtures, EN/ES, no fake success).
- Missing account, secret, license or device: build behind the typed dev-only adapter the spec defines, mark it **NOT VERIFIED** in the PR and in `docs/PROGRESS.md`, add the exact setup step to `docs/setup/HUMAN_CHECKLIST.md` if missing, and continue. Production config fails closed and never falls back to a mock.
- Spec ambiguity or conflict: instead of stopping, choose the option safest for privacy and data integrity, record it as a new numbered decision in this log with the reasoning, note it in the PR, and continue.
- Stop and ask the owner ONLY if continuing would require a real secret, real money, publishing anything, or deleting/rewriting merged history.
- State lives outside the agent's context in `docs/PROGRESS.md`, updated after every milestone (status, what was built, local vs CI test results, NOT VERIFIED list, decisions added, next step). After a context reset, re-read CLAUDE.md and `docs/PROGRESS.md` and resume; never redo merged work.

**49.** Staging (EAS `preview`) builds use the development bundle identifier `com.sitemuster.app.dev`; only production uses the reserved `com.sitemuster.app`. Reason: the spec defines only these two IDs; inventing a third ID would need store registration, and staging must never share the production identifier (safest for data integrity: a staging build can never overwrite or be mistaken for the production app).

**50.** Supabase CLI pinned to **2.122.1** (latest patch of the mature v2 line), not 3.0.0. Reason: 3.0.0 was a new major released one day before Milestone 01; migrations and `supabase test db` behaviour are data-integrity critical, so the mature line is safer. Upgrading requires a dedicated PR (decision #46 still applies: never `latest`).

**51.** Fail closed at build time AND at runtime: evaluating `app.config.ts` with `APP_ENV=production` throws unless `EXPO_PUBLIC_SUPABASE_URL` (https), `EXPO_PUBLIC_SUPABASE_ANON_KEY` and `EXPO_PUBLIC_SENTRY_DSN` are set; staging requires the Supabase values. Any `EXPO_PUBLIC_*` variable whose name looks like a server secret (service role, token, server key, pepper, encryption key, password, private, secret) aborts the build. The app shows a blocking localized configuration screen if the runtime check fails. Reason: spec requires production to refuse to run on mocks; checking at both layers removes the chance of shipping a silently degraded build.

**52.** PR screenshots are produced by rendering the real React Native screens through React Native Web in headless Chromium (`tools/ui-preview/`), in a throw-away copy of the repo, and are always labelled "web render". Reason: the Linux build agent has no iOS simulator or Android emulator; labelling prevents a web render from being mistaken for device evidence. Physical-device checks stay `NOT_EXECUTED_PHYSICAL_DEVICE` until the owner runs them.

**53.** Org-level access interpretation for the "O" column: an organization **OWNER** may read every project of their organization (with MFA); an organization **ADMIN** reads a project's roster/locations only when also assigned to that project through `project_staff`. Emergency contacts and muster control always require a project-level SAFETY role or an explicit `emergency_designated` assignment, even for owners. Reason: "admin has delegated restrictions" and "Assigned/owner" are ambiguous; the narrowest reading protects worker location and emergency data best.

**54.** One owner-only push token store (`app_private.push_tokens`, optionally linked to a device) replaces the two overlapping conceptual tables `push_tokens` and `device_push_tokens`. Reason: storing the same Expo token twice doubles the personal-data surface for no functional gain; silent-renew and visible pushes both resolve through the device link.

**55.** Raw onsite fixes expire at most **24 hours after receipt** (`expires_at <= received_at + 24 h`, enforced by a table constraint) and live in daily partitions that are dropped whole. Reason: spec requires deletion within 24 h of a closed session AND a ≤24 h purge for unresolved sessions; because a session always closes after its fixes are received, "24 h after receipt" satisfies both rules at once and never needs a later update.

**56.** `APPROVED` enrollment requires a recorded `ORIENTATION_COMPLETED` for that worker and project (database trigger). Employer verification stays a separate administrator action (`employer_status`), so the state "approved but pending employer" (replay fixture #9) can exist; attendance eligibility (Milestone 06/07) requires BOTH approval and employer verification when a company is claimed. Reason: spec 05 asks approval to require confirmed company, while decision #4 and fixture #9 require the two to be distinct steps; enforcing both at the attendance gate is the safest reading that keeps both.

**57.** Clients never write tables directly. `authenticated` has SELECT only (column-level, RLS-filtered); `anon` has nothing; `service_role` has no table privileges — all mutations run through audited SECURITY DEFINER functions (exposed RPCs or Edge Functions calling them). Server-only data (credentials, badge secrets, receipts, raw fixes, quarantine, outbox receipts, audit) lives in the unexposed `app_private` schema. Local `auto_expose_new_tables = false`. Reason: removes whole classes of RLS mistakes and enforces "service-role powers only within scoped transactions" (#39).

**58.** Tracking-affecting settings (radius, hysteresis, dwell, 24/7 flag, work windows) are stored only in immutable config versions; `projects` keeps identity, lifecycle and the pointer `config_version_id`. Emergency contacts rely on Supabase's encrypted storage plus strict RLS (no additional column encryption in V1). Reason: a single source of truth prevents retroactive recalculation (#29); field-level encryption is "where justified" in spec 05 and adds key-management risk without changing who can read the data.

**59.** Local SMS codes are captured by a development-only Auth `send_sms` hook defined in `supabase/seed.sql` (local Docker/CI only — never applied to hosted projects); the local Twilio slot is enabled with obvious non-secret placeholders only because the local Auth server refuses phone sign-in otherwise. Hosted projects configure Twilio in the dashboard and must NOT configure this hook; if it were configured there, sending fails closed because the function does not exist. Reason: lets SMS OTP be tested end-to-end without hardcoded OTP numbers (`test_otp`) that could be pushed to production by mistake.

**60.** Staff sign-in is passwordless: a 6-digit email code (10-minute validity, 60-second resend) followed by a mandatory authenticator (TOTP) step; at most two authenticators per account (primary + backup). Losing every authenticator is handled by supervised identity re-verification and an audited operator reset (operator CLI, Milestone 12) — never by email alone. Reason: spec requires "verified email + TOTP" and "passwordless account recovery"; passwords add phishing/reuse risk without benefit.

**61.** The app caches the caller's own access summary (roles only, no PII beyond IDs) inside the encrypted session store so a signed-in worker can keep using offline features without signal; it is labelled stale and refreshed when online. The server never trusts it. If no cache exists, the app shows an explicit offline screen instead of guessing. Reason: gate kiosks and sites have poor reception (decision #43) while authority must stay server-side.

**62.** The chosen UI language is stored on-device before sign-in, then saved to `worker_profiles.primary_language` (workers; used for SMS/push templates) and to the auth user metadata (everyone) after sign-in. SMS templates are bilingual in one message because the provider cannot localize per recipient. Reason: spec 08 "save language in profile"; one bilingual SMS avoids sending a wrong-language code.

**63.** Edge Functions import shared code from `packages/shared/src` by relative path and third-party modules through a per-function `deno.json` import map that points at the lockfile-pinned `node_modules` copies (e.g. `zod`, `@noble/hashes`); functions never fetch packages from npm/JSR at runtime. `SITEMUSTER_ENV` selects behaviour: only the exact value `development` enables the labelled development address adapter; `staging`, `production`, a missing or any other value is treated as production and fails closed (HTTP 503 `CONFIGURATION_ERROR`) without Google keys. Address lookups are limited to MFA staff who may configure projects, 30 per minute and 300 per hour per user (`public.address_lookup_allowed`). Because the functions read those modules from `node_modules`, `npm ci` must run before `supabase start` (CI database job) and before `supabase functions deploy`. Reason: one audited version of every library shared by app and server (the spec's shared Zod contracts), deterministic offline-capable local/CI runs, and no accidental mock in hosted projects; rate limits bound paid-API abuse.

**64.** Per-project overrides in V1 are limited to: site radius **150–2,000 m**, entry dwell **300–3,600 s** (never zero), maximum horizontal accuracy **20–100 m**, the 24/7 flag and work windows (≤ 42, no overlaps including overnight and Sunday→Monday wrap). Exit hysteresis stays **50 m** and every other value stays at the spec default. Changes that can count more people or count them sooner need explicit confirmation plus an audited reason: switching 24/7 on or off, reducing dwell, loosening accuracy, enlarging the circle, and **moving the centre** (> 1 m). Every save requires a reason. Reason: spec 06 names the sensitive changes but not all bounds; a moved circle carries the same false-arrival risk as an enlarged one, so it is treated the same way.

**65.** The person who creates a project is assigned to it as **PM with configuration and staffing delegation** (explicit, auditable), and projects start as **DRAFT**. Only an organization OWNER/ADMIN may grant elevated powers (emergency role, configuration, staffing, correction approval), even when a PM may invite staff; only the OWNER may invite organization ADMINs. Lifecycle: DRAFT→ACTIVE/ARCHIVED, ACTIVE⇄PAUSED, ACTIVE/PAUSED→COMPLETED, COMPLETED→ARCHIVED; completing or archiving needs a reason; completed/archived projects cannot change settings. Reason: spec 02 role matrix with least privilege; no silent privilege escalation through delegation chains.

**66.** Staff invitations are accepted **in the app**: the invitee signs in with the invited e-mail (verified e-mail code + MFA) and accepts it under "Invitations". V1 sends no invitation e-mail or link, and the inviter is told so on screen. Pending invitation e-mails are visible only to people who may manage the project's staff. Reason: a forwarded e-mail link would be a bearer credential; binding acceptance to the verified e-mail plus MFA is safer, and no e-mail provider is configured yet (checklist `EM`).

**67.** The site time zone is an **explicit choice** in the project wizard (the phone's zone and the US zones are offered, none is preselected) and is validated by the server against the database's IANA list (`INVALID_TIMEZONE`). Reason: shift gating, close-out deadlines and reports use the project zone; silently defaulting to the phone's zone is wrong when an office sets up a site in another state.

**68.** Overlap warnings compare the new circle with the current circles (radius + exit hysteresis) of the caller's own non-archived projects plus a 50 m margin; similar names use trigram similarity ≥ 0.5 within the same organization. Both are advisory and never reveal another organization's sites. Reason: spec 01 "warn but do not automatically block"; cross-tenant isolation.

**69.** Orientation sessions, enrollment approval and employer confirmation are allowed to the organization **OWNER** or staff **assigned** to the project as PM, SUPER or SAFETY (an org ADMIN must also be assigned, consistent with #53); the assigned kiosk ATTENDANT may additionally do supervised no-phone onboarding and printed-badge issuance. Only ACTIVE projects can run orientation, one open session per project (starting a new one closes the previous). A session's rotating secret and printed code live only in the unexposed `app_private` schema while the session is open (so the supervisor phone can re-display them after a restart) and are purged on close or expiry. Reason: spec 02 matrix with least privilege; short-lived secrets with no long-term copy.

**70.** A deployment-environment marker `app_private.settings.environment` decides whether draft legal notices may be acknowledged: an **unmarked database is production** and refuses any notice that is not APPROVED (`CONSENT_NOTICE_NOT_APPROVED`). The local/CI seed marks `development`; the owner marks staging (HUMAN_CHECKLIST §3). Reason: TRANSLATION_REVIEW requires production to refuse unapproved notices; failing closed by default prevents a forgotten setting from collecting consent against draft text.

**71.** Device activation and badge redemption run only inside Edge Functions: `edge_activate_device`, `edge_badge_device` and `edge_redeem_badge_step` are executable by `service_role` only, and the user id comes from the Auth server (`/auth/v1/user`), never from the request. `device-activate` returns the 32-byte badge secret (stored AES-256-GCM encrypted with the device id as authenticated data) and the background upload token (stored as SHA-256) exactly once; it also revokes the previous device, its secrets, upload tokens and bindings. Platform attestation (App Attest / Play Integrity) is not available yet: the installation is identified by the SHA-256 of a random per-install id (NOT VERIFIED). Reason: spec 11 `device-activate`; one active personal device (#27); no client path can write device credentials.

**72.** Rate limits must count failed attempts: functions that check orientation codes return code failures as data (`{ "error": "ORIENTATION_CODE_INVALID" }`) instead of raising, because a raised error rolls back the transaction — including the rate-limit counter. Other validation errors still raise. Reason: otherwise wrong guesses would never be throttled (found while writing the M05 tests).

**73.** Orientation QR formats: rotating `SMO1.<session>.<60-second step>.<HMAC>` computed on the supervisor phone (works offline) and accepted for the current step ±1; printed `SMS1.<session>.<32 random bytes>` with only its SHA-256 on the session row. Both lead only to ORIENTATION_COMPLETED and a PENDING enrollment. Joining requires an employer (an existing project company or a new name, created PENDING and never self-verified); changing the claimed employer resets employer confirmation; one emergency contact per worker is kept (replaced on update). Reason: QR amendment A and decision #4; minimal data.

**74.** On the phone, device credentials (badge secret, upload token) are kept only in the OS secure keystore (`AFTER_FIRST_UNLOCK`), bound to the signed-in user and wiped on sign-out; the names of approved projects are remembered so the badge opens without signal. Printed badges: one active per worker, opaque `SMP1.` code from 24 random bytes, hash only, issued only for APPROVED enrollments, re-issue cancels the previous one; printing goes through the phone's share sheet as a PNG (`expo-file-system` added at the SDK-pinned version because `expo-print` is V1.1). Reason: decision #43, QR amendment B, locked stack.

**75.** A new acknowledgement of a newer notice version closes (`withdrawn_at`) the previous active consent row for that worker and project, and supervised acknowledgements for no-phone workers are stored as `SUPERVISED` with the reading supervisor as `reviewing_actor`. Reason: one active consent per worker/project (unique index) with a full history; TRANSLATION_REVIEW test 5 (no fabricated digital consent).

**76.** Findings from the automated code review of merged PRs #1–#4 are fixed in Milestone 05 (new migration `20261104130100_review_fixes.sql`, merged migrations stay immutable), each with a regression test: (1) crash-report scrubbing also redacts coordinates inside JSON-serialized or keyed text; (2) foreman location/emergency grants cover only workers of the company that carries the grant; (3) last-owner protection locks the organization row so concurrent owner removals cannot both succeed; (4) an access check that finishes after sign-out can no longer restore a session, the offline access cache is used only for the same signed-in user, and stale access is re-checked when the app returns to the foreground (plus a retry button); (5) a PM with staffing delegation can no longer invite SUPER or SAFETY, whose implicit powers (configuration, emergency role) only an organization owner/admin may grant; (6) platform operators keep no delegated-PM powers; (7) screens stop showing previously loaded data once the server refuses access, and authorization refusals are not retried. From Milestone 05 on, the automated review of each PR is read and its real findings fixed before merging. Reason: security and privacy findings must not wait for a later milestone.


**77.** Findings from the automated review of PR #5 itself are fixed before merging it: (1) a valid orientation scan returns a **join pass** — 32 random bytes, only its SHA-256 stored in `app_private.orientation_join_grants`, bound to the signed-in person and the session, valid until the session ends — and `complete_orientation` accepts only that pass, so a worker who takes several minutes to fill in the form and read the notice is not locked out when the 60-second QR rotates; a pass cannot be used by another person, and it expires when the session closes (the row is kept, already expired, so a late submit is told the session ended; a person's expired passes are deleted on their next scan); (2) starting orientation locks the project row and the database allows only one OPEN session per project (partial unique index), so two supervisors starting at the same moment leave one session; (3) issuing a printed badge locks the worker row and the database allows only one active printed badge per worker (partial unique index), so concurrent issuance — also from different projects — leaves one active badge. Each fix has pgTAP coverage and the two races have a two-connection backend test. Reason: the pass keeps the QR's short life (screenshots expire quickly) without turning reading time into a failure; invariants that matter for security belong in the database, not only in function logic.

**78.** Attendance architecture (Milestone 06): the attendance **rules** exist once, as a pure TypeScript engine in `packages/shared/src/attendance` (no clocks, randomness or I/O). Edge Functions (Milestones 07–08) and the deterministic replay harness run the same code. The database is the **transactional reconciler**: `edge_attendance_load` returns one (project, worker) track with its configuration versions, eligibility, duplicate event uuids and latest map position; `edge_attendance_commit` applies the engine's output atomically under an advisory lock with an optimistic revision (a stale revision or an event-uuid race answers `conflict`, the caller reloads and retries). The database enforces the invariants that make contradictory state impossible: one OPEN/PENDING_APPROVAL/UNRESOLVED session per project and worker, no overlapping sessions (exclusion constraint), sessions/events/tracks tied to one project and worker, immutable session identity, coordinate-free persisted state. Both functions are service-role only. Reason: one rules implementation cannot drift; invariants that protect counts and privacy belong in the database.

**79.** Session lifecycle: a new session can never start while an UNRESOLVED one is open — the reconciler first bounds the old one (`ENDED_UNVERIFIED`, new status: ended, end time unverified, `end_latest_at` = the new session's start, excluded from definite hours, close-out review). An UNRESOLVED session keeps evidence-backed bounds only (`end_earliest_at` = last confirmed inside time; `end_latest_at` = an observed EXIT or the next session's start). No departure time is ever invented. Reason: spec 05 requires one open-or-unresolved session per worker with explicit reconciliation; the bounded status lets a returning worker be counted again without losing yesterday's review item.

**80.** Time rules (engine `advanceTo`, mirrored by the SQL sweep using instants the engine stores — `closeout_at`, `authorize_at`, `candidate_closeout_at` — so no calendar or DST logic exists in SQL): GPS-only presence becomes PRESENCE_UNKNOWN after `presence_unknown_seconds` (20 min) without evidence (not counted, not departed); a session supported by a witnessed entry (kiosk, foreman, manual) stays counted until an exit or close-out. Close-out instant: end of the authorized window the session started in (windows that follow within the 60-min grace are chained, e.g. a split lunch shift) + 60 min; 24/7 sites and unscheduled sessions: start + 16 h. At close-out a stale session becomes UNRESOLVED; a fresh one continues (no exit at the shift boundary). An unscheduled session is authorized automatically only if the worker is still evidenced on site when the next window (minus grace) begins; the earlier part awaits approval. An arrival that never completes its dwell lapses to PRESENCE_UNKNOWN until that shift's close-out, then OFFSITE (never counted, no session). The sweep runs every minute through `pg_cron` (job `sitemuster-attendance-sweep`); on databases marked `development` it does nothing so tests drive it explicitly. Parity: every replay fixture also runs against the real database with time advanced only by the SQL sweep. Reason: spec 04/06 rules with a single source of DST truth.

**81.** Arrival and departure details: the dwell needs two qualified fixes (inside the site circle, accuracy ≤ limit, not mock or implausible) ≥ `entry_dwell_seconds` apart with no evidence gap ≥ 20 min in between (a gap restarts the dwell); fixes in the 50 m band keep an observation alive but never qualify it; a configuration change during the dwell restarts it under the new version, and an ENTER through an old version's fence never starts an arrival (spec 06). A native EXIT gives a definite departure only when its accuracy is within the limit **and** it follows presence evidence by less than 20 min with no monitoring restart in between; otherwise the session becomes DEPARTURE_PENDING with bounds (spec 04: "delayed" or uncorroborated exits). An EXIT contradicted by later inside evidence (out-of-order delivery) is flagged and not applied. Silence inside an open session is recorded as an evidence gap and excluded from estimated hours; delayed evidence that shows the worker was not actually stale at close-out re-opens the session. Losing location permission, precise location or the location provider puts a GPS session into review (UNRESOLVED); a phone restart or replacement breaks continuity (presence unknown until the next qualified fix, gap recorded). Reason: never infer presence or departure from silence; same result for on-time and delayed delivery.

**82.** Witnessed evidence: a kiosk scan, foreman confirmation or manual entry opens a session immediately or corroborates the open one — one person is never counted twice. A witnessed exit ends the session; afterwards GPS cannot restart attendance until the phone reports a new native ENTER (a phone left in the site office). A scan-out more than 16 h after all other evidence is recorded for review instead of closing a session. Printed badges carry LOW confidence and a weaker-evidence note. Manual entries by authorized staff are authorized immediately (never pending approval); every manual change keeps the original record and writes an audited correction. Kiosk and foreman entries outside authorized windows are UNSCHEDULED_PENDING like GPS. Reason: spec 04 sources/confidence; staff authorization is explicit, kiosk attendants and foremen cannot approve overtime.

**83.** Late and skewed records: anything received more than 72 h after it was observed is stored durably for human review and never changes attendance; a record whose device time is more than 5 min ahead of the server receipt time is held for review (CLOCK_SKEW_REVIEW). A device clock that is *behind* cannot be told apart from queue delay for native SDK batches (the SDK sends no per-request device time); Milestone 07 adds clock-offset reporting if the SDK allows it. Reason: spec 06 thresholds, no silent backdating.

**84.** Kiosk clock: the operations request (Milestone 08) carries the kiosk's send time; the measured offset (send time vs server receipt) detects a wrong kiosk clock in either direction. When the offset exceeds 5 min the badge is verified against the corrected time (so a valid badge is not rejected) and the scan is recorded REVIEW_REQUIRED only — never silently verified (spec 07). Reason: an offline kiosk's old `observed_at` is legitimate; only the send-time offset measures the clock itself.

**85.** Device-record privacy and normalization: coordinates are accepted only inside one of the device's bound native fences (site radius + 50 m), otherwise the record is rejected `COORDINATES_NOT_PERMITTED` and nothing about the position is stored; geofence and provider-change records carrying coordinates are rejected; a fence identifier the device is not bound to is rejected `PROJECT_NOT_AUTHORIZED` without reading any other project; a fix inside two overlapping projects is marked ambiguous for both (derived per-project event uuids) and never counted automatically; mock-location fixes and implausible jumps (> 50 m/s after subtracting both accuracy circles) are flagged and ignored. The latest map position is written in the same commit, expires after `presence_unknown_seconds` and is deleted on exit, review or revocation. Reason: spec 03/11 privacy gate; backend discarding is in addition to (never instead of) the phone's egress gate.

**86.** Replay contract (Milestone 06): `tests/location-traces` fixtures may use optional extensions (project windows/24-7/status, other projects, other workers, device budget/credential age, and new inputs: manual attendance, overtime approval, visitors, project status, credential revoked, silent push, app force-stopped). 59 of the 60 named scenarios are covered; scenario 47 (contractor report disputed) belongs to Milestone 10 with the report feature, and the muster scenarios (49, 50) assert only that muster responses never change attendance (muster semantics: Milestone 11). The harness simulates the phone and kiosks from the spec (native queue, egress gate, region budget, credential renewal, offline outbox); real-device behaviour remains NOT_EXECUTED_PHYSICAL_DEVICE. Reason: required ≥ 55 fixtures without claiming features that do not exist yet.

**87.** Basic counts (`attendance_counts`, project staff only): estimated on site = OPEN sessions whose worker is ONSITE_ESTIMATED, computed live so stale GPS presence shows as unknown before the next sweep; manually verified = counted people with witnessed evidence; plus unknown, arriving, unscheduled pending, departure pending, unresolved sessions, approved roster and visitors (never part of workforce totals). Day summaries (daily unique, estimated worker seconds, peak overlap, unresolved segments, time pending approval) are attributed per project-local calendar day (23/24/25 h around DST). Reason: spec 04 aggregations; every number is an estimate, never a guaranteed headcount.

**88.** Findings from the automated review of PR #6 itself are fixed before merging it: (1) approving an unscheduled session that is still PENDING_APPROVAL replaces the pending deadline (the next window minus grace) with the authorized close-out — the end of the window it runs into plus close-out grace, capped at start + 16 h — so an early 04:00 entry approved at 04:05 stays counted into the 06:00 shift instead of becoming UNRESOLVED at 05:00 (fixture `approved-early-unscheduled-keeps-shift`, replayed in memory and against the database); (2) day summaries unite uncertain intervals before adding them up, because an evidence gap that starts at the last confirmed inside fix lies inside the unresolved tail: the same time is no longer counted twice and one stretch is one unresolved segment (unit regression test). Reason: decisions #6 and #80 (close-out only after the authorized window) and spec 04 (no overstated estimates).

**89.** Device ↔ project bindings are derived state, kept in sync by database triggers (enrollment status and employer status, consent accepted or withdrawn, phone activated or deactivated, project status or configuration). A worker's one active phone is bound exactly to the projects where attendance may be recorded: approved enrollment, verified employer when a company is claimed, an active acknowledgement of the notice, and an ACTIVE project. The fences a phone may report are the CURRENT configuration version of each bound project plus the version of a still-open session, so that session's exit stays resolvable. An old boundary is never accepted for a new arrival, and a coordinate inside a superseded circle is not "inside a bound fence". This tightens the Milestone 06 harness, which accepted every version. Reason: spec 06 "keep historical v1 identifier resolvable for v1 open-session exit… new v2 entrants must never be evaluated using old v1 boundaries"; spec 11 "unbound IDs rejected"; minimization.

**90.** Continuous onsite coordinates are a release-gated feature. They are allowed in development and staging (synthetic data, test devices). In production they are allowed only for a platform and exact app version with a recorded real-device privacy sign-off (`app_private.location_privacy_signoffs`, written only by the database owner after the network-capture procedure in HUMAN_CHECKLIST §10). Without a sign-off the phone stays in TRACKING_LIMITED: geofence-only, coordinate-free ENTER/EXIT. GPS alone then never confirms an arrival, and kiosk and foreman check-ins count the worker. The server also refuses any coordinate from such a phone (`COORDINATES_NOT_PERMITTED`). Reason: spec 03 "if not verifiable, turn OFF the raw coordinate uploader… show TRACKING_LIMITED" and the Milestone 07 acceptance "SDK privacy not verified ⇒ live GPS feature release BLOCKED rather than falsely accepted"; the sign-off is per build because the egress behaviour is per build.

**91.** The native SDK runs in two modes and the egress gate runs in JavaScript.
- **Offsite:** `persistMode = GEOFENCE`, `autoSync = true`. Only coordinate-free geofence records exist, rendered through the coordinate-free geofence template, so the SDK may upload them on its own.
- **Onsite** (after an ENTER, released builds only): `persistMode = ALL` and `autoSync = false`, set in the same call. JavaScript prunes the native queue before every sync, destroying any location record that is not inside exactly one bound native fence. Offsite or overlapping positions never leave the phone.
- **Going offsite:** stop persisting positions first, switch to geofence-only, prune, then re-enable autoSync and sync.
- Queued geofence records are kept even though the SDK stores them with their trigger position: the template strips it on the wire.

This deviates from spec 11's `http.autoSync=true` while on site, because a static native template cannot filter positions (spec 03 "WARNING"). Records wait in the native queue whenever JavaScript cannot run; that costs latency, never privacy. The simulated SDK test captures the HTTP wire for a whole day (commute, arrival, work, exit, drive home): no offsite coordinate is sent. A negative control (autoSync left on while on site) does leak, which proves the test can detect a leak. Real-device proof stays a release gate (#90).

**92.** Device secret renewal on the phone uses the SDK's native `authorization` refresh:
- `accessToken` and `refreshToken` = the device secret; `refreshUrl` = `device-renew`; FORM field `refresh_token`.
- `expires` = the epoch second when renewal is due (expiry − 7 days). The SDK refreshes headlessly and sends `Authorization: Bearer <secret>` itself.
- This replaces a static `headers.Authorization`; the request header on the wire is the same. The SDK's interpretation of `expires` must be confirmed on a device (NOT VERIFIED). If it differs, the fallback is the foreground renewal.
- Foreground renewal: in the last 7 days, with the current secret; after expiry, with the signed-in session.
- After any renewal the SDK gets the new secret before the app stores it. The previous secret keeps working for 24 h. Only the newest secret can renew (`SUPERSEDED`), so a stale copy cannot mint more secrets. A secret the SDK refreshed while the app was closed is adopted at the next start.
- Renewal by push (silent pushes and the 7/3/1-day reminders) ships with the push pipeline in Milestone 11.
- `project_tracking_health` already gives staff the CREDENTIAL_EXPIRING/EXPIRED roster flags; the roster UI comes in Milestone 09.

Reason: spec 03/decision #44 (workers whose tracking works never open the app).

**93.** `ingest-location-batch` details:
- HTTP 200 only when every named record is durably terminal; anything else is 503 for the whole batch.
- A uuid already stored for the same phone is `duplicate`. A uuid owned by another phone is `rejected: EVENT_UUID_CONFLICT`, quarantined and never acknowledged as that phone's duplicate.
- A record without a valid uuid is quarantined and left out of the results. A batch where no record has a uuid is 422.
- Rate limits: every request counts toward 60 per minute; events count toward 600 per hour only when the batch is accepted (Retry-After: 60).
- Rejections and their sanitized quarantine copies are written in one transaction.
- The location template renders a plain fix's event as an empty string and booleans as quoted strings (valid JSON even if a platform leaves a tag empty). The server canonicalizes exactly these forms.
- The replay harness posts every simulated batch through this production handler: 81 fixtures, in memory and against the database.

Reason: spec 11 (the SDK deletes the whole batch on 2xx).

**94.** Signing out revokes the phone server-side while the session is still valid (`revoke_my_device`: upload and badge secrets revoked, phone inactive, bindings follow). It also stops tracking on the phone and drops the native queue and the cached plan. An offline sign-out still wipes everything on the phone; the server-side secret then ends at its expiry or at the next activation. Activating a new phone flags the worker's active sessions DEVICE_REPLACED through MONITORING REPLACED evidence. This is best effort after the committed activation (retried three times, logged), so a successful activation is never turned into a failure. Reason: spec 03 "revoke on new phone, logout…"; decision #27.

**95.** Permission and provider changes reach the server without coordinates. The SDK's own provider-change records are disabled because they would carry a position. Instead, when location permission becomes unusable (not Always, not Precise, or services off) or usable again, the app sends one coordinate-free `providerchange` record directly to `ingest-location-batch` with the device secret. Only changes are sent; a failed send is retried at the next start. The normalizer turns it into MONITORING UNAVAILABLE or RESTARTED. The native queue never holds these records, so queue ownership stays exclusive (decision #23). The server never infers a departure from them. If a report cannot be sent, silence leads to PRESENCE_UNKNOWN after 20 minutes. Reason: spec 03 "If permission removed or Precise disabled, set MONITORING_UNAVAILABLE".

**96.** The on-phone egress gate fails closed. If a prune or a single-record delete fails (a native queue or bridge error), nothing else in that batch may upload. The explicit sync is skipped and reported as `EGRESS_GATE_FAILED`. A configuration change that would switch SDK autoSync on is applied with autoSync off. The SDK also never starts with autoSync on: `ready()` always gets `autoSync: false`, and arming turns it on only after its prune. Every offsite heartbeat and resync now runs prune → autoSync on → sync, so uploads resume only after a successful prune. Disarming turns autoSync off before it drops the queue. Reason: spec 03 and CLAUDE.md "no persistent or transmitted offsite movement trail". Sending a position the gate could not check would break that even if the server then discarded it. (PR #7 review.)

**97.** The phone keeps the secret the SDK actually holds.
- **Cold start.** The SDK can refresh its upload secret natively, also while the app is closed, and nothing in JavaScript sees that. So before `ready()` the app reads the SDK's persisted authorization (`getState()`, which needs no location access). It adopts that secret only if both hold:
  - The app's record (encrypted store) says the SDK was last given this same device's secret. After a sign-out and a new activation, the SDK still holds the old phone's revoked secret.
  - It differs from the secret that record names (SHA-256 only). After a renewal the SDK never received, the SDK holds the replaced secret.

  The app updates the record whenever it gives the SDK a secret, adopts one, or sees a native refresh. Sign-out clears it. If the SDK's configuration cannot be read, the app uses its own copy and reports it; it never guesses.
- **Ordering.** The SDK always gets a renewed secret before the app stores it, also on a cold start, where the order is `ready()` first, then storage.
- **Renewing on mismatch.** When a freshly downloaded plan names an active credential whose expiry differs from the held secret's, the phone renews at once. This covers, for example, a renewal response that never arrived. Otherwise the held secret would stop working when its 24-hour overlap ended, while the UI still showed it as valid. If that renewal fails, the key is shown as EXPIRING (at most one day), never OK.
- **Sign-out during a start.** `stop()` cancels starts that are running or queued: a start checks for cancellation after every await and stops before any write. `stop()` then runs after them. A start in flight at sign-out can no longer save the plan, renew, store a secret or re-arm tracking.
- **Verification.** Reading `getState()` before `ready()` on real phones is checked by the device sign-off (checklist §10).

Reason: decision #44 (zero loss across renewal). (PR #7 review.)

**98.** Operational outbox answers (Milestone 08, additive to spec 11).
- **Request.** It carries `client_sent_at` (decision #84).
- **Results.** Each result may also carry:
  - `worker_id`: kiosk scans, only when the scan was authorized;
  - `review`: stored but held for review, e.g. a wrong kiosk clock;
  - `original_status`.
- **Receipts.** Every terminal result is stored once in `operational_outbox_receipts` with its worker, per-worker children and review flag. A re-sent operation (the phone lost the answer) gets `duplicate`, plus the outcome, worker and children it got the first time. The kiosk then still shows the right person and result.
- **Another person's id.** An operation id already held by another person is refused as `EVENT_UUID_CONFLICT` and never acknowledged as theirs.
- **No role on the project.** An operation for a project the caller has no role on is refused as `PROJECT_NOT_AUTHORIZED`. Its receipt references no project, so nothing is written against that project.
- **Store failure.** The whole request answers 503 and nothing is acknowledged. The outbox resends; already-applied parts answer `duplicate` (badge redemption, reconciler event uuids and visit idempotency keys are all idempotent).
- **Muster.** Muster operations are refused (`OPERATION_NOT_SUPPORTED`) until Milestone 11.
- **Wiring.** The Edge Function entry files are not type-checked by `tsc`, so every database-row mapper lives in the shared core, where it is typed and unit tested.

Reason: spec 01 "receive authoritative success or conflict state"; spec 11 "removes only accepted or durable rejected/duplicate".

**99.** Who may record what (role matrix, made exact for V1):
- **Kiosk.** An assigned ATTENDANT with MFA scans anyone approved. A foreman whose GC granted kiosk use (`foreman_project_grants.can_operate_kiosk`) scans only their own company's crew and never handles visitors.
- **Visitor desk.** Assigned ATTENDANT with MFA.
- **Manual correction.** Organization OWNER or assigned PM/SUPER, with MFA. SAFETY corrects only "if delegated"; V1 has no delegation mechanism, so it does not.
- **Foreman crew sign-in/out.** A verified foreman of a company approved on the project, for that company's enrolled workers only.
- **Kiosk revocation.** The project's configurers, or the attendant the kiosk is assigned to.

Worker and foreman correction requests belong to the daily-report flow (Milestone 10). The `ingest-operations` Edge Function asks `operation_context` with the caller's own JWT, so these rules live in SQL only. Reason: spec 02; the narrowest reading where the matrix is silent.

**100.** A kiosk checks attendance eligibility before it consumes a badge step. The rule is decision #56: approved enrollment, verified employer when a company is claimed, and an active acknowledgement. `edge_operation_workers` reports it, and pgTAP asserts it matches the reconciler's rule for every seeded worker. A worker who is not yet eligible is refused as `NOT_APPROVED` without spending that 30-second code. A printed badge is refused as `BADGE_REVOKED` when replaced or cancelled, and as `BADGE_INVALID` when unknown. Only the SHA-256 of a printed code ever reaches the database. Reason: spec 11 badge order; a refused scan should not burn the next attempt.

**101.** Visitors and foreman batches:
- **Visitor ids.** A new visitor gets a UUID chosen by the kiosk, so the kiosk can sign them out even while offline. The server creates the record on first sign-in. An id already used on another project is refused (`VISITOR_ID_CONFLICT`), never reused. Without a visitor id, the id is derived from the operation id, so a resend is idempotent.
- **Visitor host.** The host must be active staff on the project.
- **Foreman batch results.** Each named worker gets a child result whose idempotent id is `deriveUuid('foreman-member', operation|worker)`. The batch reads:
  - `accepted` when at least one worker was recorded (`SOME_WORKERS_REJECTED` when some were refused);
  - `rejected` when none was (the shared reason when there is one);
  - `duplicate` when all were already recorded.
- **Clock skew.** A foreman phone clock more than 5 minutes off holds the crew records for review, as for kiosks.

Reason: spec 01 "visitor separate"; spec 11 "per-worker outcome … not a partial silent success".

**102.** The operational outbox on the phone:
- **Storage.** It uses its own expo-sqlite file and its own AES-256-GCM key in the OS keystore, separate from the session key, so a session reset never destroys unsent work. Each row belongs to the signed-in person who recorded it and is sent only with that person's session.
- **Sending.** An operation is validated with the shared schema and stored before anything is sent. Operations go oldest first, at most 100 per request and about 200 KiB.
- **Settling.** Only a terminal answer settles an operation. Network failure, 401, 429, 5xx or a missing per-operation answer keeps it queued.
- **Retries.** Sends happen right away, on foreground, every minute while something waits, and on Sync now. Outbox retries are not location polling.
- **Retention.** Settled entries stay visible for 24 hours, then leave the phone.
- **Unreadable rows.** Rows whose key is gone (reinstall) are removed and reported.
- **Sign-out.** Signing out with unsent operations needs an explicit choice: send now, or discard knowingly.
- **No badge key.** Without the badge key the Edge Function answers 503 `CONFIGURATION_ERROR` to every request (fails closed), and the outbox keeps everything.

Reason: CLAUDE.md "no data-loss outbox"; spec 07 "Kiosk offline during rush".

**103.** Kiosk registration and evidence handling:
- **Registration.** A phone registers as a project's kiosk with a public id derived from its installation and the project, so the same phone at two projects cannot be linked. An attendant taking over the shift re-registers the same kiosk; the operator change is audited. A revoked kiosk stays revoked. The kiosk id is kept in the keystore so a kiosk restarted offline keeps recording.
- **What the kiosk does.** It never checks a badge: it holds no secrets, records its own time and queues the scan.
- **Printed badges.** A printed badge needs an explicit face-and-name confirmation on screen before it is recorded, and stays labelled "Printed badge".
- **Names.** When an accepted scan names a worker the kiosk's cached list does not know (approved at the gate after the kiosk opened), the list is reloaded.

Reason: spec 02 "Kiosk device has unique device registration"; spec 07 printed-badge row.
