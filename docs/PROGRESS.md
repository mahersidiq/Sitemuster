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
| 06 | Attendance state machine and deterministic replay | not started | | |
| 07 | Native tracking and custom device ingestion | not started | | |
| 08 | Kiosk, foreman, manual and visitor fallbacks | not started | | |
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
- `supabase test db`: 16 files, **373** pgTAP tests pass (`021_orientation_badges`: 78 — who may start sessions, ±1-step rotating code, forged/expired/foreign codes, printed code only while open, PENDING-only joins, notice gating incl. production refusal, closed/expired sessions, rate limit counting failures, roster privacy, bulk 101 refused / 100 with per-person results, employer confirmation, managed no-phone worker, printed badge hash/re-issue/revoke, service-role-only device activation, previous device revoked, badge replay; `022_review_fixes`: 13 — delegated PMs cannot invite SUPER/SAFETY, platform operators lose delegated powers, foreman grants limited to the granting company).
- `npm run test:backend` against the local stack (Auth, PostgREST, Postgres, Edge runtime): **20/20** — adds the M05 flow: staff starts orientation via Edge, worker joins with a code computed by the app's own code (TS ↔ SQL HMAC parity), stays PENDING, Edge bulk approval, device activation (secret stored only encrypted), offline badge verified once and its replay rejected; printed QR rejected after close; workers refused by staff Edge Functions; activation refused without a worker profile; plus a two-connection race proving an organization always keeps an owner.
- Vitest unit **190**, integration 51, security **75**, i18n **18** (adds native permission texts EN/ES, legal-draft integrity), replay 3; Jest mobile-unit 7 + mobile-integration **39** (8 orientation flows: join with draft notice → PENDING, Spanish notice + closed-session error, camera-denied fallback, live/printable QR + share, bulk approve + employer confirmation, reject reason + no-phone worker, printed badge, offline badge without network; 4 access-hardening tests: sign-out race, same-user offline cache, foreground re-check, revoked project data hidden).
- typecheck, ESLint + shellcheck, Prettier, `expo config`, `npm audit --audit-level=high`: pass.
- Web-render screenshots `docs/screenshots/m05` (13, EN + ES) against the local stack.
- Found and fixed while testing: the printable-QR export updated state on every render (endless re-render on real devices); the Jest QR stand-in now behaves like the real component so this cannot regress.
- GitHub Actions run 41765693418 (head `47cf2ca`): `code-quality` success (unit 190 + 7, integration 51 + 39, security 75 incl. the iOS/Android bundle canary scan, i18n 18, replay 3, expo config, audit: 0 high/critical); `database` success (pgTAP Files=16, Tests=373, PASS; `npm run test:backend` 20/20 incl. Edge Functions and the race test in the CI Supabase stack).

**NOT VERIFIED (Milestone 05)**
- Camera QR scanning, AFTER_FIRST_UNLOCK keystore behaviour and the share sheet/printing on real phones (`NOT_EXECUTED_PHYSICAL_DEVICE`); screenshots are web renders.
- Real Twilio SMS for worker sign-in and the 100-workers/hour orientation throughput rehearsal (HUMAN_CHECKLIST §4, spec decision #42).
- Platform attestation for device activation (App Attest / Play Integrity) — not available; installation identified by a hashed random id.
- Hosted deployment: BADGE_SECRET_ENCRYPTION_KEY, environment marker, new Edge Functions (checklist §3).
- Legal: the EN/ES disclosures are AI drafts — human bilingual legal approval required before production (TRANSLATION_REVIEW.md); production refuses them until then.
- Kiosk-side redemption of badges is wired in Milestone 08 (the verifier and redemption function are built and tested now).

**Fixes from the automated review of merged PRs #1–#4 (decision #76), each with a regression test:** JSON/keyed coordinate scrubbing in crash reports; foreman grants scoped to the granting company; last-owner protection serialized per organization (two-connection race test); sign-out race, user-bound offline access cache and foreground re-check of stale access; delegated PMs cannot invite SUPER/SAFETY; platform operators keep no delegated-PM powers; revoked project data is hidden and authorization refusals are not retried. Process change: each PR's automated review is now read and its real findings fixed before merging.

**Decisions added:** #69 orientation/approval authority and session secrets, #70 environment marker (unmarked = production), #71 service-role-only device activation/redemption + installation hash, #72 rate limits count failed code attempts, #73 QR formats and join data rules, #74 on-phone credential storage, printed badges and PNG sharing (`expo-file-system`), #75 consent supersession and supervised acknowledgements, #76 review-finding fixes.

**Next step:** done — Milestone 06 (attendance state machine and deterministic replay, ≥ 55 fixtures) starts on `milestone-06-attendance-engine`.

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
