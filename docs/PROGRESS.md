# SiteMuster build progress (autonomy mode, decision #48)

**Resume rule:** after any context reset, re-read `CLAUDE.md`, then this file, then continue from "Next step". Never redo merged work. Merged history is never rewritten.

## Milestone status

| # | Milestone | Status | PR | Notes |
|---|---|---|---|---|
| 01 | Clean repository, locked stack and CI | done (NOT VERIFIED items) | [#1](https://github.com/mahersidiq/Sitemuster/pull/1) | squash-merged under #48 after CI green |
| 02 | Database, RLS and role matrix | done (NOT VERIFIED items) | [#2](https://github.com/mahersidiq/Sitemuster/pull/2) | squash-merged under #48 after CI green |
| 03 | Authentication, MFA and English/Spanish | done (NOT VERIFIED items) | [#3](https://github.com/mahersidiq/Sitemuster/pull/3) | squash-merged under #48 after CI green |
| 04 | GC organizations, projects, shifts and circles | done (NOT VERIFIED items) | [#4](https://github.com/mahersidiq/Sitemuster/pull/4) | squash-merged under #48 after CI green |
| 05 | Orientation sessions, badges, approval | done (NOT VERIFIED items) | [#5](https://github.com/mahersidiq/Sitemuster/pull/5) | squash-merged under #48 after CI green and the automated review |
| 06 | Attendance state machine and deterministic replay | done (NOT VERIFIED items) | [#6](https://github.com/mahersidiq/Sitemuster/pull/6) | squash-merged under #48 after CI green and the automated review (`edbe76f`) |
| 07 | Native tracking and custom device ingestion | done (NOT VERIFIED items) | [#7](https://github.com/mahersidiq/Sitemuster/pull/7) | squash-merged under #48 after CI green and the automated review (`d509baf`) |
| 08 | Kiosk, foreman, manual and visitor fallbacks | in review | (PR pending) | |
| 09 | Mobile superintendent dashboard and map | not started | | |
| 10 | Daily reports, foreman confirmation and worker CSV | not started | | |
| 11 | Active Muster Mode | not started | | |
| 12 | Security, privacy, resilience and operator CLI | not started | | |
| 13 | Native release preparation, review demo and field pilot | not started | | |

## Milestone 01 — Clean repository, locked stack and CI

**What was built**
- Expo SDK 58 + React Native 0.88.1 + TypeScript 6 (strict) app at the repo root with `expo-router`; npm workspace `packages/shared` (`@sitemuster/shared`).
- Every locked-stack library installed at exact versions (manifest in `CLAUDE.md`), lockfile committed; `expo-print` intentionally not installed (V1.1).
- `packages/shared`: enums mirrored from the spec, locked numeric defaults (`06-config-defaults.md`), Zod contracts from `11-api-contracts.md` (native ingest envelope/records/response, operations outbox, offline badge, Broadcast), replay fixture schema (`10-testing.md`), provider interfaces + typed `Fake*` adapters that refuse to construct outside development/test, fail-closed provider selection, privacy scrubber (coordinates, phones, emails, OTPs, tokens, badges, names, emergency contacts), base64url/SHA-256 helpers.
- App shell: explicit first-launch EN/ES choice (device language only suggests), persistent language switch (SecureStore, `AFTER_FIRST_UNLOCK`), sign-in wireframe with real sign-in visibly disabled, worker tabs (Home, My Projects, Time History, Profile) and staff tabs (Home, Projects, Workforce, Map, More) reachable only through a development-only preview, guarded routes, blocking localized configuration-error screen when staging/production config is missing, Sentry init with scrubbing hooks.
- `app.config.ts`: APP_ENV-based IDs (`com.sitemuster.app.dev` dev/staging, `com.sitemuster.app` production reservation), production fail-closed checks, secret-name leak guard.
- Supabase CLI scaffold: `supabase/.cli-version` = 2.122.1, `config.toml` (studio/analytics off), pgTAP security baseline.
- CI: `.github/workflows/ci.yml` unchanged from the spec package; every step it calls now runs real tests.
- `tools/ui-preview/`: reproducible web-render screenshot capture (decision #52).

**Test results (local, Linux container, Node 22.23.4)**
- `npm run typecheck`, `npm run lint` (ESLint + shellcheck), `npm run format:check`: pass.
- `test:unit` Vitest 92/92 + Jest mobile-unit 7/7; `test:integration` Vitest 9/9 + Jest router integration 8/8; `test:security` 58/58; `test:i18n` 10/10; `test:location-replay` 3/3 (fixture contract only — engine replay is Milestone 06).
- `npx expo config --json`: pass. `npm audit --audit-level=high`: pass (moderate/low dev-tooling advisories only).
- Supabase local stack (Docker) `supabase start` + `supabase db reset --local` + `supabase test db`: 4/4 pgTAP pass.
- `expo prebuild --no-install` with all planned native plugins (scratch copy): iOS + Android projects generated.
- GitHub Actions run 41744884117: `code-quality` success (all 11 check steps), `database` success (`supabase test db`: Files=1, Tests=4, PASS). Audit: 41 advisories, 0 high/critical.

**NOT VERIFIED (Milestone 01)**
- Native binary compile and launch on a physical iPhone/Android (needs Expo/EAS account — HUMAN_CHECKLIST §2): `NOT_EXECUTED_PHYSICAL_DEVICE`.
- Sentry event delivery (no Sentry project yet — §6).
- Screenshots are web renders, not device captures (decision #52).
- Spanish UI copy is AI-drafted UI text (not legal text); manual Spanish comprehension test before pilot (spec 08).

**Decisions added:** #48 (owner, autonomy mode), #49 staging bundle ID, #50 Supabase CLI 2.122.1, #51 build+runtime fail-closed config, #52 labelled web-render screenshots.

**Next step:** done — Milestone 02 started.

## Milestone 02 — Database, RLS and role matrix

**What was built**
- 8 migrations: PostGIS; private `app_private` schema; deny-by-default privileges; 40 enums (mirrored 1:1 in `packages/shared`, parity-tested); 35 client-readable tables + 12 server-only tables covering organizations, projects, immutable config versions/work windows/circular geofences, staff, invitations, workers, emergency contacts, companies/membership, foreman grants, legal notice versions, orientation, enrollments, consents, devices/bindings, hashed upload credentials, badge secrets, nonce redemptions, push tokens, kiosks, badges, coordinate-free location receipts, quarantine, 24 h raw-fix partitions, latest positions, attendance events/sessions/presence/corrections, outbox receipts, visitors, daily reports/confirmations, muster events/snapshot/responses, operator actions, audit log.
- RLS: SELECT-only policies (35) built on SECURITY DEFINER helpers that derive identity from the JWT; staff access requires MFA (`aal2`); column grants hide phones/emails/auth links/hashes; no client writes, no `anon` or `service_role` table access.
- Integrity triggers: immutable config versions/geofences/windows/events/confirmations/responses/receipts/audit (retention purge path only), last-owner protection, server-computed config/notice digests, timezone validation, binding/consent/muster consistency, approval-requires-orientation.
- Realtime: private `project:{uuid}` receive policy on `realtime.messages`; helper predicates for staff and verified foremen.
- Privileged functions: `create_organization` (MFA + verified email, idempotent, audited), `resolve_upload_credential` (revocation/expiry/overlap), raw-fix partition maintenance and purge, audit writer.

**Test results (local)**
- `supabase db reset` + `supabase test db` (CLI 2.122.1, Docker): **12 files, 203 pgTAP tests pass** — two-tenant isolation, PM/SUPER/SAFETY/ATTENDANT/ADMIN/OWNER matrix, MFA enforcement, foreman and worker boundaries, platform operator denial, device credentials, uniqueness/immutability/privacy constraints, realtime authorization, org creation, raw-fix retention. Sanity run confirmed assertions fail when wrong.
- npm checks: typecheck, lint, format pass; unit 92 + 7, integration 51 + 8 (adds DB↔TS enum parity), security 64 (adds migration static scan), i18n 10, replay contract 3.
- GitHub Actions run 41748240221: `code-quality` success; `database` success (`supabase test db`: Files=12, Tests=203, PASS).

**NOT VERIFIED (Milestone 02)**
- Migrations not applied to real Supabase staging/production (no accounts — HUMAN_CHECKLIST §3). Data API/Realtime dashboard settings in §3 are manual owner steps.
- Realtime end-to-end delivery through the Realtime server (policy and predicates tested in SQL; live channel test arrives with Milestone 09).

**Decisions added:** #53 org OWNER vs ADMIN access, #54 single push-token store, #55 raw fixes ≤24 h after receipt, #56 approval requires orientation / attendance requires approval + employer verification, #57 no client writes + `app_private` + no service-role table access, #58 settings only in versions; emergency contacts protected by RLS + platform encryption.

**Next step:** done — Milestone 03 started.

## Milestone 03 — Authentication, MFA and English/Spanish

**What was built**
- Worker sign-in: SMS 6-digit code (Supabase Phone Auth), E.164 normalization, masked destination, wrong/expired code messages, server-driven 60 s resend cooldown with countdown, SMS-down fallback message pointing to kiosk/foreman.
- Staff sign-in: passwordless 6-digit email code → mandatory TOTP enrollment (QR + setup key) or challenge on every sign-in; staff screens open only at aal2.
- Encrypted session store: AES-256-GCM (`@noble/ciphers`) ciphertext in `expo-sqlite`, random per-install key in `expo-secure-store` (AFTER_FIRST_UNLOCK); slot-bound envelopes; tamper/orphan/locked-key handling; key rotation; wipe on sign-out.
- Role-aware routing from the server `get_my_access()` summary: worker shell, staff shell (MFA), choose-context (both), join-project (worker without profile), no-organization (verified staff), operator refusal, explicit offline screen; encrypted cached access for offline use (stale-labelled).
- Language: first-launch choice persists; saved to the worker profile (`set_my_language`) and auth metadata after sign-in.
- Server: `get_my_access`, `get_my_profile`, `set_my_language` owner-only RPCs; local Auth config (bilingual SMS/email templates, 60 s cooldowns, 600 s email codes, TOTP on, ≤2 factors, 400 SMS/h); development SMS capture hook in `seed.sql` (local only).
- Recovery guidance screen; supervised no-phone identity design (`docs/design/no-phone-identity.md`).

**Test results (local)**
- `supabase test db`: 13 files, **216** pgTAP tests pass (adds owner-only RPC checks).
- `npm run test:backend` against the real local Auth server: **8/8** — SMS sign-in, wrong code, 60 s cooldown, expired code, single-use code, phone-only user blocked from staff RPC; staff email code → aal1 denied → TOTP enroll → aal2 → org created → next sign-in requires TOTP; email cooldown.
- Vitest unit **143**, integration 51, security 64, i18n 10, replay 3; Jest mobile-unit 7 + mobile-integration **18** (10 new sign-in flow tests); typecheck/lint/format/expo config/audit pass. Flaky tamper test found and fixed (25 consecutive passes).
- Web-render screenshots (`docs/screenshots/m03`) captured against the local Auth server.
- GitHub Actions run 41751877095: `code-quality` success; `database` success — pgTAP 216 pass and `npm run test:backend` 8/8 against the CI Supabase stack.

**NOT VERIFIED (Milestone 03)**
- Real Twilio SMS delivery, A2P 10DLC and ≥200 sign-ins/hour provider throughput (HUMAN_CHECKLIST §4).
- Real staff email delivery — needs an SMTP provider (new checklist §3b `EM`).
- Hosted Supabase Auth settings (checklist §3) not applied; no hosted projects yet.
- Physical-device checks: SecureStore AFTER_FIRST_UNLOCK behaviour, SMS autofill, restart/session restore on iOS/Android, `@supabase/supabase-js` URL handling on Hermes (`NOT_EXECUTED_PHYSICAL_DEVICE`).
- Staff MFA reset for lost authenticators is a documented supervised process; the operator tooling arrives in Milestone 12.

**Decisions added:** #59 local SMS capture hook (seed-only) + placeholder provider slot, #60 passwordless staff email code + TOTP (≤2 factors, supervised reset), #61 encrypted offline access cache, #62 language persistence + bilingual SMS template.

**Next step:** done — Milestone 04 started.

## Milestone 04 — GC organizations, projects, shifts and circles

**What was built**
- Database (migration `20261104120000_m04_projects_config.sql`): `create_project` (idempotent, DRAFT, version 1 with circle + work windows, creator assigned PM with delegation, audited), `update_project_config` (new immutable version N+1 under a row lock; open sessions keep their version; sensitive changes need confirmation + reason), `set_project_status` lifecycle with reasons, `check_project_site` overlap/similar-name warnings (own organization only), staff invitations (`invite_project_staff`, `invite_org_admin`, `list_my_invitations`, `accept_invitation` bound to the verified e-mail + MFA, `revoke_invitation`, `remove_project_staff`), `list_my_projects`, `get_project_detail` (pending invitation e-mails only for staff managers), `address_lookup_allowed` (MFA staff with configuration rights, 30/min + 300/h), server-side bounds (radius 150–2,000 m, dwell 300–3,600 s, accuracy 20–100 m, ≤ 42 non-overlapping windows incl. overnight), explicit codes (`NAME_REQUIRED`, `INVALID_TIMEZONE`, `INVALID_COORDINATES`, …).
- Edge Functions `address-search` / `address-resolve` (Google Places (New) autocomplete + Geocoding, JWT verified, rate-limited through the database, Zod-validated). Without keys: labelled development adapter only when `SITEMUSTER_ENV=development`; any hosted value fails closed (503).
- App: typed API layer (`src/api`), organization creation, Projects tab, 4-step new-project wizard (name → address + native map circle with draggable pin + radius stepper → explicit site time zone + shifts incl. overnight / 24-7 → review with advisory overlap/similar-name warnings), project page (site, schedule, settings history, lifecycle, staff + pending invitations), settings editor (new version, sensitive-change confirmation, reason), staff/admin invitation screens, invitations inbox. Retrying a create after a lost response never duplicates (idempotency keys).
- `app.config.ts`: `react-native-maps` plugin (Apple Maps on iOS, Google Maps on Android); production build is refused without `GOOGLE_MAPS_ANDROID_API_KEY` and refuses a server key reused as the map key.
- EN/ES strings for every new screen; dynamic-key coverage test.

**Test results (local, Linux container)**
- `supabase test db`: 14 files, **281** pgTAP tests pass (020_projects_config: 65 — creation, idempotency, v1/v2 immutability with an open session keeping v1, bounds, sensitive confirmations, lifecycle, overlap/similar names within one tenant, invitations, delegation limits, list/detail isolation incl. GC B and workers, address-lookup authorization).
- `npm run test:backend` against the local Supabase stack: **16/16** — adds the app's real API class end-to-end (GC activation, v2, lifecycle, invitation only for the invited verified e-mail, worker gets nothing), Edge Functions in the real Deno runtime, DB↔shared defaults parity.
- Vitest unit **170**, integration **51**, security **75** (adds a real iOS + Android bundle build with planted canary secrets: no server key and no direct Google endpoint in the bundles), i18n **12**, replay contract **3**; Jest mobile-unit **7**, mobile-integration **27** (10 new project/organization/invitation flows incl. Spanish and a lost-response retry).
- typecheck, ESLint + shellcheck, Prettier, `expo config`, `npm audit --audit-level=high`: pass.
- Web-render screenshots (`docs/screenshots/m04`, 22 images, EN + ES) captured against the local stack, including the local Edge Function address adapter.
- GitHub Actions run 41759095284 (head `c53264a`): `code-quality` success (unit 170 + 7, integration 51 + 27, security 75 incl. the iOS/Android bundle canary scan, i18n 12, replay 3, expo config, audit: 0 high/critical); `database` success (pgTAP Files=14, Tests=281, PASS; `npm run test:backend` 16/16 incl. Edge Functions in the CI Supabase stack). The first run failed because `supabase start` bundles the Edge Functions before `npm ci` had installed their pinned imports; the database job now installs dependencies first (no test or step removed).

**NOT VERIFIED (Milestone 04)**
- Real Google Places/Geocoding results — no Google Cloud project or keys yet (HUMAN_CHECKLIST §5). Local/CI use the labelled development adapter through the real Edge runtime.
- Native map rendering (Apple Maps / Google Maps), pin dragging and Android Maps key restrictions on real phones (`NOT_EXECUTED_PHYSICAL_DEVICE`); screenshots show a labelled schematic map (web render).
- Hosted deployment of the migration and Edge Functions (no hosted Supabase projects yet; checklist §3 lists the deploy steps).
- Time-zone formatting under Hermes on devices (verified with Node's ICU only).
- Spanish UI copy is AI-drafted UI text; the manual Spanish comprehension test is still required before pilot.
- No invitation e-mail is sent (by design, decision #66); invitees accept in the app.

**Decisions added:** #63 Edge import maps + `SITEMUSTER_ENV` fail-closed + address rate limits, #64 override keys/bounds and sensitive changes (incl. moving the circle), #65 creator-as-PM, DRAFT start, delegation limits and lifecycle, #66 in-app invitations bound to the verified e-mail, #67 explicit site time zone, #68 tenant-scoped advisory overlap/similar-name warnings.

**Next step:** done — Milestone 05 started.

## Milestone 05 — Orientation sessions, badges, approval

**What was built**
- Database (migration `20261104130000_m05_orientation_badges.sql`): orientation sessions (120 min, one open per ACTIVE project, idempotent start, close/expiry purge the session secrets), rotating 60-second code verified with HMAC (±1 step) and printed code verified by hash; worker join (`preview_orientation`, `complete_orientation`) → ORIENTATION_COMPLETED + versioned DIGITAL acknowledgement + PENDING enrollment (never approval), employer required (existing project company or new PENDING company), one emergency contact; production refuses draft notices (`CONSENT_NOTICE_NOT_APPROVED`, unmarked DB = production); staff roster without phone/e-mail/emergency data; bulk approval ≤ 100 with a result per person; separate employer confirmation; reject/revoke with reason; supervised no-phone workers (managed identity, SUPERVISED acknowledgement naming the supervisor); printed badges (opaque `SMP1.` code, hash only, approved workers only, re-issue cancels the old one); service-role-only device activation (one active phone per worker, revokes previous secrets/tokens/bindings) and badge-step redemption (accepted / duplicate / replay); rate limits that count failed code attempts.
- Draft EN/ES worker location disclosures (`docs/legal/drafts`, DRAFT_REQUIRES_HUMAN_REVIEW, hashes in TRANSLATION_REVIEW.md).
- Edge Functions: `orientation-session` (START/CLOSE), `enrollment-bulk-approve` (≤ 100), `device-activate` (badge secret AES-256-GCM encrypted with BADGE_SECRET_ENCRYPTION_KEY bound to the device id, upload token hashed, both returned once; development key only in development, fail closed elsewhere); `badge-core` verifier for the kiosk sync (Milestone 08).
- App: worker join by QR scan (camera for QR only) or typed code → details → disclosure (DRAFT label) → done; worker home/My Projects with honest statuses; offline 30-second badge from the phone keystore (works without signal after one-time activation); emergency contact editing; staff orientation screen (live QR computed on the phone + printable QR shared as PNG via the share sheet); roster/approvals with select-all ≤ 100, per-person results, employer confirmation, reject with reason; no-phone onboarding with the notice read in the worker's language; printed badge issue/share/cancel. Native camera permission text in EN/ES; device credentials wiped on sign-out.

**Test results (local, Linux container)**
- `supabase test db`: 16 files, **382** pgTAP tests pass (`021_orientation_badges`: 87 — who may start sessions, ±1-step rotating code, forged/expired/foreign codes, printed code only while open, PENDING-only joins, notice gating incl. production refusal, closed/expired sessions, rate limit counting failures, roster privacy, bulk 101 refused / 100 with per-person results, employer confirmation, managed no-phone worker, printed badge hash/re-issue/revoke, service-role-only device activation, previous device revoked, badge replay, join pass bound to the person and the open session, one open session per project, one active printed badge per worker; `022_review_fixes`: 13 — delegated PMs cannot invite SUPER/SAFETY, platform operators lose delegated powers, foreman grants limited to the granting company).
- `npm run test:backend` against the local stack (Auth, PostgREST, Postgres, Edge runtime): **21/21** — adds the M05 flow: staff starts orientation via Edge, worker joins with a code computed by the app's own code (TS ↔ SQL HMAC parity), stays PENDING, Edge bulk approval, device activation (secret stored only encrypted), offline badge verified once and its replay rejected; printed QR rejected after close; workers refused by staff Edge Functions; activation refused without a worker profile; plus two-connection races proving an organization always keeps an owner, and that concurrent orientation starts / printed-badge issues leave one open session / one active badge.
- Vitest unit **190**, integration 51, security **75**, i18n **18** (adds native permission texts EN/ES, legal-draft integrity), replay 3; Jest mobile-unit 7 + mobile-integration **39** (8 orientation flows: join with draft notice → PENDING, Spanish notice + closed-session error, camera-denied fallback, live/printable QR + share, bulk approve + employer confirmation, reject reason + no-phone worker, printed badge, offline badge without network; 4 access-hardening tests: sign-out race, same-user offline cache, foreground re-check, revoked project data hidden).
- typecheck, ESLint + shellcheck, Prettier, `expo config`, `npm audit --audit-level=high`: pass.
- Web-render screenshots `docs/screenshots/m05` (13, EN + ES) against the local stack.
- Found and fixed while testing: the printable-QR export updated state on every render (endless re-render on real devices); the Jest QR stand-in now behaves like the real component so this cannot regress.
- GitHub Actions run 41765693418 (head `47cf2ca`): `code-quality` success (unit 190 + 7, integration 51 + 39, security 75 incl. the iOS/Android bundle canary scan, i18n 18, replay 3, expo config, audit: 0 high/critical); `database` success (pgTAP Files=16, Tests=373, PASS; `npm run test:backend` 20/20 incl. Edge Functions and the race test in the CI Supabase stack). The fixes for PR #5's own review (decision #77) were verified again by GitHub Actions run 41768698989 on the final head `dbb44d4` (`code-quality` success; `database` success: pgTAP Files=16, Tests=382, backend 21/21) before the squash merge (`6605965`).

**NOT VERIFIED (Milestone 05)**
- Camera QR scanning, AFTER_FIRST_UNLOCK keystore behaviour and the share sheet/printing on real phones (`NOT_EXECUTED_PHYSICAL_DEVICE`); screenshots are web renders.
- Real Twilio SMS for worker sign-in and the 100-workers/hour orientation throughput rehearsal (HUMAN_CHECKLIST §4, spec decision #42).
- Platform attestation for device activation (App Attest / Play Integrity) — not available; installation identified by a hashed random id.
- Hosted deployment: BADGE_SECRET_ENCRYPTION_KEY, environment marker, new Edge Functions (checklist §3).
- Legal: the EN/ES disclosures are AI drafts — human bilingual legal approval required before production (TRANSLATION_REVIEW.md); production refuses them until then.
- Kiosk-side redemption of badges is wired in Milestone 08 (the verifier and redemption function are built and tested now).

**Fixes from the automated review of PR #5 itself (decision #77):** the join form uses a join pass from the scan (bound to the person and the open session) so the rotating QR cannot expire mid-form; concurrent orientation starts and concurrent printed-badge issues are serialized and enforced by unique indexes.

**Fixes from the automated review of merged PRs #1–#4 (decision #76), each with a regression test:** JSON/keyed coordinate scrubbing in crash reports; foreman grants scoped to the granting company; last-owner protection serialized per organization (two-connection race test); sign-out race, user-bound offline access cache and foreground re-check of stale access; delegated PMs cannot invite SUPER/SAFETY; platform operators keep no delegated-PM powers; revoked project data is hidden and authorization refusals are not retried. Process change: each PR's automated review is now read and its real findings fixed before merging.

**Decisions added:** #69 orientation/approval authority and session secrets, #70 environment marker (unmarked = production), #71 service-role-only device activation/redemption + installation hash, #72 rate limits count failed code attempts, #73 QR formats and join data rules, #74 on-phone credential storage, printed badges and PNG sharing (`expo-file-system`), #75 consent supersession and supervised acknowledgements, #76 review-finding fixes, #77 join pass and orientation/badge race fixes.

**Next step:** done — Milestone 06 (attendance state machine and deterministic replay, ≥ 55 fixtures) starts on `milestone-06-attendance-engine`.

## Milestone 06 — Attendance state machine and deterministic replay

**What was built**
- `packages/shared/src/attendance` — the single implementation of the attendance rules (pure: no clocks, randomness or I/O): 10-minute dwell from two qualified fixes (≤ 75 m, inside the site circle, continuity), arrival = first qualified fix, ARRIVING never counted, definite departure only from an accurate and timely EXIT (otherwise DEPARTURE_PENDING bounds), PRESENCE_UNKNOWN after 20 min of silence (never a departure), DST-aware shift windows with 60-min grace and chained split shifts, UNSCHEDULED_PENDING + overtime approval + automatic authorization at the next window, end-of-shift close-out to UNRESOLVED, 24/7 16 h review, 72 h late-record review, clock-skew review, configuration snapshots per session (old fences never start new arrivals), witnessed kiosk/foreman/manual evidence (no double counting; phone-left-on-site guard), audited manual corrections, visitors kept apart, evidence gaps excluded from hours, basic counts and per-local-day summaries; SDK-record normalizer with the privacy gate (offsite or misplaced coordinates discarded, unbound fences refused, overlap → ambiguous), native region-budget selection, optimistic reconciler.
- Database (`20261105100000_m06_enums.sql`, `20261105100100_m06_attendance_reconciler.sql`): `ENDED_UNVERIFIED` status; track/session columns; **no-overlap exclusion constraint**; ownership foreign keys tying sessions, events and tracks to one project and worker; immutable session identity; service-role-only `edge_attendance_load` / `edge_attendance_commit` (advisory lock + optimistic revision, idempotent event uuids, coordinate-free state, latest map position in the same transaction), `edge_insert_location_receipts`, SQL sweep for the time rules only, visitor load/commit, staff `attendance_counts` (live staleness), `pg_cron` job every minute (no-op on development databases).
- `tests/location-replay`: LocationTraceReplayHarness — simulated phone (native queue, privacy egress gate, region budget, credential expiry/renewal/revocation, silent push, lost replies), kiosks (offline outbox, wrong clocks, replays verified with the real badge verifier) and foreman, over the production modules; in-memory backend enforcing the database invariants; trace-permutation tests.
- `tests/location-traces`: **81 fixtures** — 59 of the 60 named scenarios of docs/spec/10 (scenario 47, report dispute, belongs to Milestone 10), 21 edge cases from docs/spec/07 and the review of PR #6, and the spec example.

**Test results (local, Linux container, Docker, Supabase CLI 2.122.1)**
- `npm run test:location-replay`: **180/180** — 81 fixtures replayed, the suite-size check (≥ 55 named, none missing except #47), 15 trace-permutation tests (any upload order inside a batch gives the same result; record-by-record reversed arrival never creates a contradictory state) and 83 fixture-contract checks (every file matches the schema; ids are unique).
- `npm run test:backend`: **103/103** — the 21 earlier tests, **all 81 fixtures replayed against the real database** through the service-role reconciler RPCs with time advanced only by the SQL sweep (TypeScript ↔ SQL parity, each in a rolled-back transaction), and a duplicate race (the same batch reconciled concurrently on two connections is applied exactly once; 6 consecutive passes).
- `supabase test db`: **17 files, 430** pgTAP tests (`023_attendance_reconciler`: 48 — service-role-only access, eligibility reasons, duplicates, first write/stale revision/duplicate uuid, coordinate-free state, foreign-worker sessions refused, second open session refused, overlap refused, bounded hand-over accepted, CLOSED/ENDED_UNVERIFIED constraints, cross-project configuration and cross-worker events refused, immutable identity, no deletes, sweep: authorization, unknown, arrival lapse, expired positions, close-out UNRESOLVED, reset, visitor close-out, live counts and their authorization, schedule).
- Vitest unit **232** (42 new attendance unit tests: DST conversion and 23/24/25 h days, window snapshots incl. overnight, split shifts, fall-back and 24/7, zones and jumps, region budget, SDK normalization, counts and day summaries, configuration versions, engine ordering/idempotency/eligibility/refusals, the review-finding regression for united uncertain intervals), integration 51, security 75, i18n 18; Jest mobile-unit 7 + mobile-integration 39.
- typecheck, ESLint + shellcheck, Prettier, `expo config`, `npm audit --audit-level=high`: pass.
- GitHub Actions run 41774920570 (head `44dae6e`): `code-quality` success (unit 231 + 7, integration 51 + 39, security 75 incl. the iOS/Android bundle canary scan, i18n 18, replay 178, expo config, audit: 0 high/critical); `database` success (pgTAP Files=17, Tests=430, PASS; `npm run test:backend` 102/102 incl. the 80 database replays and the duplicate race in the CI Supabase stack). The fixes for PR #6's own review (decision #88) are verified again by GitHub Actions on the final head before the squash merge.

**NOT VERIFIED (Milestone 06)**
- No production endpoint feeds the engine yet: native location ingestion is Milestone 07, kiosk/foreman/manual/visitor operations are Milestone 08. The rules are verified through the replay harness and the database replay only.
- The phone and kiosk behaviour inside the harness is a model of the spec (native SDK queue, geofence delivery, egress gate, region budget, background renewal); the real behaviour needs physical iOS/Android tests (`NOT_EXECUTED_PHYSICAL_DEVICE`).
- Hosted `pg_cron` job and extensions (no hosted Supabase yet; checklist §3 step added).
- Load/performance targets (100 / 1,000 / 10,000 workers) not run yet.
- Scenario 47 (contractor report disputed) arrives with reports in Milestone 10; muster scenarios 49–50 assert only separation from attendance (muster semantics: Milestone 11).

**Decisions added:** #78 single rules engine + transactional reconciler, #79 ENDED_UNVERIFIED and bounded hand-over, #80 time rules + SQL sweep parity + pg_cron, #81 arrival/departure details, #82 witnessed evidence, #83 late and skewed records, #84 kiosk clock offset, #85 device-record privacy and normalization, #86 replay contract and scope, #87 basic counts, #88 fixes from PR #6's own review (approval close-out, united uncertain intervals).

**Next step:** done — PR #6's two review findings were fixed (decision #88); GitHub Actions run 41776787549 on the final head `a5cf927` was green (pgTAP Files=17, Tests=430; backend 103/103 incl. 81 database replays); squash-merged as `edbe76f`. Milestone 07 started on `milestone-07-native-tracking`.

## Milestone 07 — Native tracking and custom device ingestion

**What was built**
- **Server.**
  - Migration `20261106100000_m07_device_ingestion.sql`:
    - Device ↔ project bindings derived by triggers from approval, employer verification, consent and project status (decision #89).
    - Service-role-only `edge_device_authenticate`, `edge_device_rate_limit` (60 requests/min, 600 events/h), `edge_location_receipt_lookup`, `edge_record_location_terminals` (receipts + quarantine in one transaction), `edge_device_renew` (24 h overlap; only the newest secret renews), `edge_worker_open_session_projects`.
    - The continuous-coordinate release gate (dev/staging, or a per-platform/app-version privacy sign-off; decision #90).
    - `my_tracking_plan` (worker), `project_tracking_health` (staff roster flags), `revoke_my_device` (sign-out).
  - Edge Functions `ingest-location-batch` and `device-renew` (`verify_jwt=false` for exactly these two, custom device-secret authentication), on shared cores (`supabase/functions/_shared/ingest-core.ts`, `renew-core.ts`) with whole-batch 200/503, idempotent resend, foreign-uuid refusal, quarantine and safe logs.
  - `device-activate` now flags open sessions DEVICE_REPLACED.
  - One store codec (`packages/shared/src/attendance/store-codec.ts`) for the reconciler RPCs.
- **Replay.** The harness's simulated phone uploads every batch through the production `handleIngest`, with fences derived by the production rule: 81 fixtures, in memory and against the database.
- **Phone (`src/tracking`).**
  - Transistorsoft v5 nested configuration checked against the installed types: coordinate-free geofence template, minimal location template, provider-change records off, logging off, native token refresh.
  - Pure two-mode controller with the JavaScript egress gate (decision #91).
  - Native driver (the only SDK import) and the simulated SDK, the CI trace driver with a captured wire; it never ships, and the bundle test guards that.
  - Tracking agent (serialized, persisted) shared with the Android headless task.
  - Tracking service: plan, renewal (SDK first, then storage), permission gating without OS prompts, region budget, offline plan, monitoring reports (decision #95).
  - Review fixes (PR #7):
    - The egress gate fails closed: no upload after a failed prune, and the SDK never starts with autoSync on (decision #96).
    - A cold start adopts the secret the SDK refreshed natively, but only for the same device. The phone renews when the server names another active credential (decision #97).
    - Sign-out cancels a start that is still running.
  - Encrypted on-phone state; `TrackingProvider` (start, foreground refresh, stop at sign-out).
- **App.**
  - Worker home card and `/tracking` screen (EN/ES): phase, mode, permission checklist with platform help, key validity, location queue and Sync now, monitored and unmonitored sites. Tracking is armed right after phone setup.
  - `app.config.ts`: Transistorsoft plugin, iOS background modes and EN/ES usage texts, Android permissions. Production fails closed without `TS_ANDROID_LICENSE_KEY`.
  - Android headless entry (`index.js`).
- Screenshots: `docs/screenshots/m07` (web render of the real screens against the local stack).

**Test results (local, Linux container, Docker, Supabase CLI 2.122.1)**
- `supabase test db`: **18 files, 491** pgTAP tests (`024_device_ingestion`: 61 — derived bindings for consent, employer, project status and phone; credential states incl. rotated overlap; fences = current + open-session version; release gate incl. per-build sign-off; rate limits; terminal recording, coordinate refusal, foreign uuid; renewal paths, supersession, revocation, audit; worker plan; staff health authorization; sign-out revocation).
- `npm run test:backend`: **110/110** — incl. `device-ingestion.test.ts` (7, real Edge Functions over HTTP: 401/405/415/422, accepted then duplicate with one session, project A/B isolation with zero B rows, whole-batch 503 while the reconciler is unavailable then exactly-once, replaced phone 401 + DEVICE_REPLACED, renewal in the middle of a 25-record queue with zero loss/duplicates and the overlap ending, foreground renewal after expiry) and the 81 database replays through the production ingest handler.
- Vitest unit **294**:
  - Edge cores 46, incl. instrumented cross-project zero access and mixed 200/503.
  - Tracking 37, incl.:
    - the full-day captured-wire privacy trace and its negative control;
    - limited mode, overlapping sites, offline queue, native refresh, refusal, disarm;
    - service phases, renewal ordering, region budget, monitoring reports, serialized starts, queue kept when the service is re-created;
    - review regressions: a failed prune at the exit never sends the crossing position; cold-start adoption of a natively refreshed secret; no adoption after sign-out and re-activation, or after a renewal the SDK never got; renewal on credential mismatch and EXPIRING when it fails; sign-out during a start;
    - each regression test was checked to fail without its fix.

  Also: integration 51, security **78** (incl. the native config gates and the bundle guard), i18n 18, replay **180**; Jest **50** (mobile-unit 11 incl. the tracking screen EN/ES, mobile-integration 39).
- typecheck, ESLint + shellcheck, Prettier, `expo config`, `npm audit --audit-level=high`: pass.
- GitHub Actions: run 41787601927 on `3651d3b` green (pgTAP 18/491, backend 110/110). After the three automated-review fixes, run [41790721734](https://github.com/mahersidiq/Sitemuster/actions/runs/41790721734) on the final head `e020d58` was green: pgTAP Files=18, Tests=491, PASS; backend 11 files, 110/110 (81 database replays); code-quality all steps.

**NOT VERIFIED (Milestone 07)**
- **Physical devices** (`NOT_EXECUTED_PHYSICAL_DEVICE`): native background delivery, iOS relaunch and Android headless events, reboot, Force Stop, permission flows, battery, the rendered HTTP wire of the real SDK, its interpretation of `expires` (decision #92), reading the persisted secret before `ready()` (decision #97), and the egress gate in killed-app conditions. No EAS development build exists yet (needs Expo account, checklist §2).
- **Production continuous coordinates stay OFF** (TRACKING_LIMITED) until the real-device privacy sign-off in checklist §10 is recorded per platform and app version (decision #90).
- Transistorsoft production license (`TS_ANDROID_LICENSE_KEY`, checklist §10): production builds refuse to build without it.
- Push-based renewal (silent push and the 7/3/1-day reminders) arrives with the push pipeline in Milestone 11; the roster UI that shows CREDENTIAL_EXPIRING comes in Milestone 09.
- Hosted deployment of the two new Edge Functions (checklist §3).

**Decisions added:** #89 derived device bindings and current/open-session fences, #90 continuous-coordinate release gate (TRACKING_LIMITED), #91 two-mode SDK operation and JavaScript egress gate, #92 native authorization refresh and renewal paths, #93 ingest endpoint details, #94 sign-out revocation and replacement flag, #95 coordinate-free monitoring reports, #96 the egress gate fails closed, #97 the phone keeps the secret the SDK holds.

**Next step:** done — squash-merged as `d509baf` after CI green and the automated review fixes (decisions #96, #97). Milestone 08 started on `milestone-08-fallbacks`.

## Milestone 08 — Kiosk, foreman, manual and visitor fallbacks

**What was built**
- **Server.**
  - Migration `20261107100000_m08_operations.sql`:
    - `operation_context`, called with the caller's own JWT: kiosk ALL/OWN_CREW, visitor desk, correction, foreman companies.
    - `register_kiosk` / `revoke_kiosk` (audited).
    - Service-role helpers: kiosk lookup, receipts with worker/children/review, printed badge by hash, worker enrollment facts with the attendance-eligibility rule, visitor registration and context, rate limit.
    - Screen reads: `my_foreman_projects`, `foreman_crew` (names only), `open_visitor_visits`, `worker_attendance_sessions`.
    - Project detail flags.
  - Edge Function `ingest-operations` (`verify_jwt = true`) on `supabase/functions/_shared/operations-core.ts`:
    - per-operation and per-worker results;
    - kiosk clock offset from `client_sent_at` (decision #84);
    - badge HMAC and one-use steps verified on sync;
    - printed flag kept; visitors separate;
    - receipts answer resends; whole-request 503 on store failure; fails closed without the badge key.
  - Shared `applyVisitorOperation` and `edge_visitor_context`.
- **Replay.** The harness sends kiosk, foreman, manual and visitor steps through the production handler; the database replay uses the shared visitor RPC path. 180 replays and 81 database replays are green.
- **Phone.**
  - `src/outbox`: encrypted expo-sqlite operational outbox (own key, per person, store before send, ≤ 100 per request, only terminal answers settle, 24 h retention) and `OutboxProvider`.
  - Screens (EN/ES):
    - attended kiosk: camera or typed code, arriving/leaving, printed-badge confirmation, per-person results, offline "waiting to sync";
    - visitor desk (offline-capable visitor ids);
    - foreman crew (≤ 100, per-worker results, estimate note) and a granted foreman's crew kiosk;
    - manual correction (pick a visit or add a missing one, project time zone, reason);
    - combined sync status card;
    - sign-out guard for unsent records.
  - Entry points: project detail, roster rows, worker home.
- Screenshots: `docs/screenshots/m08` (web render against the local stack; the kiosk round trip uses the real Edge Function).

**Test results (local, Linux container, Docker, Supabase CLI 2.122.1)**
- `supabase test db`: **19 files, 554** pgTAP tests. `025_operations` has 63: permissions per role incl. MFA, GC B, foreman B, worker and operator; kiosk registration, hand-over, revocation and audit; receipts; printed badge by hash; eligibility parity with the reconciler; visitor registration incl. the cross-project id refusal; the visitor exit compare-and-swap that keeps the exit's operation id; crew names-only; screen-read authorization.
- `npm run test:backend`: **112/112**, incl. `operations.test.ts` (2) against the real stack:
  - offline kiosk 20 scans (10 phone, 10 printed) plus 20 crew events → exactly 40 accepted; the resend adds nothing (40 sessions, 40 events, 22 receipts);
  - badge replay refused; per-worker errors; visitor separate; manual correction with reason; the overlap refusal; attendant cannot correct;
  - GC B attendant refused for project A with zero rows written there; anon key and missing bearer refused.

  The 81 database replays pass through the production handler.
- Vitest unit **324**:
  - operations core 15, incl. the acceptance scenario, a visitor exit resent after a 503 (duplicate, not VISIT_NOT_FOUND), replay, printed flag, visitors, per-worker errors, permissions, zero reads of a foreign project, foreman crew kiosk, clock skew, 503 then exactly once, malformed and muster, foreign id, HTTP guards, row mappers;
  - outbox 8 against the real handler, incl. offline then a lost answer then exactly 40 accepted;
  - helpers 6.

  Also: integration 51, security 78, i18n 18, replay 180. Jest **61**, incl. the outbox key race (two first records at once share one key) and 9 new flows: kiosk offline→sync, printed confirmation, late-approved worker named, not-a-badge, Spanish, crew per-worker, correction, visitors, sign-out guard.
- typecheck, ESLint + shellcheck, Prettier: pass.
- GitHub Actions: _recorded in the PR._

**NOT VERIFIED (Milestone 08)**
- **Physical devices** (`NOT_EXECUTED_PHYSICAL_DEVICE`): camera scanning of real phone and printed badges, two phones and the kiosk in airplane mode, kiosk restart offline, real expo-sqlite and keystore behaviour. The checklist has the step-by-step check ("Real-device kiosk, crew and visitor check"). No EAS build yet (checklist §2).
- Hosted deployment of `ingest-operations` and attendant assignment (checklist §3).
- There is no screen yet for a GC to grant a foreman kiosk use. The database grant exists, and the screen comes with the dashboard work.

**Decisions added:** #98 operation answers and receipts, #99 who may record what, #100 eligibility before a badge step, #101 visitor ids and foreman batch results, #102 the phone outbox, #103 kiosk registration and printed-badge confirmation.

**Next step:** open the Milestone 08 PR, watch CI, address the automated review, merge, then start Milestone 09 (mobile superintendent dashboard and map) on `milestone-09-dashboard`.

## Environment notes for future sessions (Linux build agent)

- Docker daemon is not started automatically: `nohup dockerd >/tmp/dockerd.log 2>&1 &`.
- Supabase CLI: download `https://github.com/supabase/cli/releases/download/v2.122.1/supabase_linux_amd64.tar.gz` (sha256 `3e54b98e5ead7be0a3b0753526833d4cc9a55304e4d57da0d72f1efc342738ea`) into a scratch `bin/`.
- Container images: `public.ecr.aws` layer downloads and `ghcr.io` are blocked and Docker Hub rate-limits anonymous pulls; pull each Supabase image from `mirror.gcr.io/<image>` and `docker tag` it to `<image>` and `public.ecr.aws/<image>`, then run the CLI with `SUPABASE_INTERNAL_IMAGE_REGISTRY=docker.io`.
- `api.expo.dev` is blocked: run Expo CLI commands with `EXPO_OFFLINE=1`.
- Playwright is preinstalled for CommonJS `require('playwright')` (used by `tools/ui-preview`).
- shellcheck: `pip install shellcheck-py` (CI runners have it preinstalled).
- Backend E2E: `eval "$(supabase status -o env | grep -E '^(API_URL|ANON_KEY|DB_URL|MAILPIT_URL|FUNCTIONS_URL)=' | sed 's/^/export /')" && npm run test:backend` (local stack only; refuses remote URLs).
- Screenshots that sign in: export the same variables, then `bash tools/ui-preview/capture.sh mNN docs/screenshots/mNN <scratch-dir>`.
- After a container restart, Docker containers come back but the Edge runtime may exit: run `supabase stop && supabase start` (same registry variable) before backend tests.
