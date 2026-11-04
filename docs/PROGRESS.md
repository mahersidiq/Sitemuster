# SiteMuster build progress (autonomy mode, decision #48)

**Resume rule:** after any context reset, re-read `CLAUDE.md`, then this file, then continue from "Next step". Never redo merged work. Merged history is never rewritten.

## Milestone status

| # | Milestone | Status | PR | Notes |
|---|---|---|---|---|
| 01 | Clean repository, locked stack and CI | done (NOT VERIFIED items) | [#1](https://github.com/mahersidiq/Sitemuster/pull/1) | squash-merged under #48 after CI green |
| 02 | Database, RLS and role matrix | done (NOT VERIFIED items) | [#2](https://github.com/mahersidiq/Sitemuster/pull/2) | squash-merged under #48 after CI green |
| 03 | Authentication, MFA and English/Spanish | in review | PR #3 | NOT VERIFIED items below |
| 04 | GC organizations, projects, shifts and circles | not started | | |
| 05 | Orientation sessions, badges, approval | not started | | |
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

**NOT VERIFIED (Milestone 03)**
- Real Twilio SMS delivery, A2P 10DLC and ≥200 sign-ins/hour provider throughput (HUMAN_CHECKLIST §4).
- Real staff email delivery — needs an SMTP provider (new checklist §3b `EM`).
- Hosted Supabase Auth settings (checklist §3) not applied; no hosted projects yet.
- Physical-device checks: SecureStore AFTER_FIRST_UNLOCK behaviour, SMS autofill, restart/session restore on iOS/Android, `@supabase/supabase-js` URL handling on Hermes (`NOT_EXECUTED_PHYSICAL_DEVICE`).
- Staff MFA reset for lost authenticators is a documented supervised process; the operator tooling arrives in Milestone 12.

**Decisions added:** #59 local SMS capture hook (seed-only) + placeholder provider slot, #60 passwordless staff email code + TOTP (≤2 factors, supervised reset), #61 encrypted offline access cache, #62 language persistence + bilingual SMS template.

**Next step:** after Milestone 03 merges, start Milestone 04 (organizations, projects, shifts, circles) on `milestone-04-projects`.

## Environment notes for future sessions (Linux build agent)

- Docker daemon is not started automatically: `nohup dockerd >/tmp/dockerd.log 2>&1 &`.
- Supabase CLI: download `https://github.com/supabase/cli/releases/download/v2.122.1/supabase_linux_amd64.tar.gz` (sha256 `3e54b98e5ead7be0a3b0753526833d4cc9a55304e4d57da0d72f1efc342738ea`) into a scratch `bin/`.
- Container images: `public.ecr.aws` layer downloads and `ghcr.io` are blocked and Docker Hub rate-limits anonymous pulls; pull each Supabase image from `mirror.gcr.io/<image>` and `docker tag` it to `<image>` and `public.ecr.aws/<image>`, then run the CLI with `SUPABASE_INTERNAL_IMAGE_REGISTRY=docker.io`.
- `api.expo.dev` is blocked: run Expo CLI commands with `EXPO_OFFLINE=1`.
- Playwright is preinstalled for CommonJS `require('playwright')` (used by `tools/ui-preview`).
- shellcheck: `pip install shellcheck-py` (CI runners have it preinstalled).
- Backend E2E: `eval "$(supabase status -o env | grep -E '^(API_URL|ANON_KEY|DB_URL|MAILPIT_URL|FUNCTIONS_URL)=' | sed 's/^/export /')" && npm run test:backend` (local stack only; refuses remote URLs).
- Screenshots that sign in: export the same variables, then `bash tools/ui-preview/capture.sh mNN docs/screenshots/mNN <scratch-dir>`.
