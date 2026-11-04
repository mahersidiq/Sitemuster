# SiteMuster build progress (autonomy mode, decision #48)

**Resume rule:** after any context reset, re-read `CLAUDE.md`, then this file, then continue from "Next step". Never redo merged work. Merged history is never rewritten.

## Milestone status

| # | Milestone | Status | PR | Notes |
|---|---|---|---|---|
| 01 | Clean repository, locked stack and CI | done (NOT VERIFIED items) | [#1](https://github.com/mahersidiq/Sitemuster/pull/1) | squash-merged under #48 after CI green |
| 02 | Database, RLS and role matrix | not started | | |
| 03 | Authentication, MFA and English/Spanish | not started | | |
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

**Next step:** after Milestone 01 merges, start Milestone 02 (database, RLS, role matrix) on `milestone-02-database-rls`.

## Environment notes for future sessions (Linux build agent)

- Docker daemon is not started automatically: `nohup dockerd >/tmp/dockerd.log 2>&1 &`.
- Supabase CLI: download `https://github.com/supabase/cli/releases/download/v2.122.1/supabase_linux_amd64.tar.gz` (sha256 `3e54b98e5ead7be0a3b0753526833d4cc9a55304e4d57da0d72f1efc342738ea`) into a scratch `bin/`.
- Container images: `public.ecr.aws` layer downloads and `ghcr.io` are blocked and Docker Hub rate-limits anonymous pulls; pull each Supabase image from `mirror.gcr.io/<image>` and `docker tag` it to `<image>` and `public.ecr.aws/<image>`, then run the CLI with `SUPABASE_INTERNAL_IMAGE_REGISTRY=docker.io`.
- `api.expo.dev` is blocked: run Expo CLI commands with `EXPO_OFFLINE=1`.
- Playwright is preinstalled for CommonJS `require('playwright')` (used by `tools/ui-preview`).
- shellcheck: `pip install shellcheck-py` (CI runners have it preinstalled).
