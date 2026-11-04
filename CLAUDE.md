# SiteMuster — mandatory Claude Code repository rules

**Source of truth:** `CLAUDE.md` + the numbered files in `docs/spec/`. Before modifying code, **read the milestone task, every referenced spec, the decision log, and all linked API/security contracts**. If requirements conflict, stop and open a question in the PR; do not silently guess. Decisions #1–#47 and the two QR amendments (B revised by #43) are binding. Project is **V1 mobile-only**; V1.1 items in `01-product.md` are excluded.

## How Claude Code works in this repo

- Start every milestone in **plan mode**: read the milestone file and every spec it lists, then present a short plan (files to create/change, migrations, tests, open questions) and wait for the owner's OK before editing.
- Use `gh` (GitHub CLI, owner-authenticated) for branches, PRs and CI status: `gh pr create --draft`, `gh pr checks --watch`. Never `gh pr merge`.
- Branch name: `milestone-NN-<short-name>`. Commit messages: `mNN: <what>`.
- Run commands yourself (`npm ci`, `npm run typecheck`, tests, `supabase start` if Docker is available). Paste real output in the PR; never summarize a test you did not run.
- If a spec is ambiguous or two specs conflict, stop and ask the owner in chat (and note it in the PR). Do not guess.
- Keep context small: read only the spec files the milestone lists, plus files you are editing.
- Never print, commit or echo secrets. `.env*` files are git-ignored except `.env.example`.

## Workflow — immutable

1. Execute only the assigned `docs/tasks/milestone-NN.md`. Do not implement later milestones opportunistically.
2. Establish a feature branch and make small, scoped commits. Claude Code **never merges its own PR**.
3. Run available tests; report which ran locally, which ran in GitHub Actions, and which need devices or secrets. Never claim a test passed if it did not run.
4. Open **one PR per milestone**; if CI is red, keep it draft. When ready for human review, **stop**. Do not automatically begin the next milestone.
5. Each PR description MUST include: (a) plain-English what/why, (b) numbered manual phone-test instructions with expected results, (c) green CI links/results, (d) list of unverified or blocked items, (e) screenshots/screen recordings for UI changes, (f) migrations and secrets changes, (g) rollback notes, (h) security/privacy impact.
6. Human owner alone approves/merges. Never modify protected branches directly, bypass branch protection, or use GitHub tokens to self-approve.
7. Work not requiring missing external accounts proceeds behind **typed development-only adapters**. Production **fails closed** for missing auth, credentials, tracking guarantees, or consent. No fake production success.

## Product invariants

- One role-aware native iOS/Android application. No web dashboard, CRM, billing, marketing site, payroll engine, interior floor plan UI, polygon fence UI, or advanced PDF/CSV reporting in V1.
- Launch free: unlimited organization accounts, projects, workers, subcontractors; later pricing per active project, not per worker (billing not built in V1).
- Automatic geofence attendance is **estimated**, not proof a worker is physically there. **Five attendance sources**: `GEOFENCE`, `KIOSK_DYNAMIC_BADGE`, `KIOSK_PRINTED_BADGE`, `FOREMAN`, `MANUAL`; visitors separately tracked. Must provide no-phone fallback.
- EN/ES worker and staff UX at launch. Legal translations cannot ship until human-approved. Foreman confirmation is NOT a verified payroll record.
- Presence states distinct from enrollment, permissions, attendance sessions and emergency accountability. Never infer departure from silence.
- Data isolation across GC organizations, subcontractors, and projects is enforced server-side + RLS; client role checks alone never authorize.
- No persistent or transmitted offsite movement trail. Native SDK offsite-payload leakage test is mandatory; if it cannot be prevented, disable continuous live positions rather than violating privacy.
- One active personal tracking device per worker; kiosk shared devices are separate credentials.
- The worker's phone is not their identity; QR or geofence alone cannot prove physical presence or emergency safety.

## Locked stack and build tools

| Area | Exact decision |
|---|---|
| App | React Native + Expo (native development builds) + TypeScript strict |
| Routing | `expo-router` |
| Background tracking | Transistorsoft `react-native-background-geolocation` **major v5**; custom Expo dev build/config plugin; Android production license required; NOT plain `expo-location` as main tracker |
| Native location queue | Transistorsoft embedded SQLite and native HTTP uploader; ONLY tracking/geofence records |
| Operational outbox | `expo-sqlite`; ONLY kiosk, foreman, manual, visitor, muster and other non-location offline mutations |
| Key protection | `expo-secure-store` + `expo-crypto` for secure random bytes + `@noble/ciphers` AES-256-GCM for encrypted SQLite session blobs; iOS `AFTER_FIRST_UNLOCK`; background upload has **separate revocable device credential** |
| API client | `@supabase/supabase-js` |
| State/query | `@tanstack/react-query` |
| Runtime schemas | `zod` shared mobile/Edge Functions |
| Forms | `react-hook-form` + `@hookform/resolvers` |
| Maps | `react-native-maps`; Apple Maps iOS, Google Maps Android |
| QR scanner | `expo-camera` |
| QR display | `react-native-qrcode-svg` + `react-native-svg` peer dependency |
| Localization | `expo-localization` + `i18next` + `react-i18next` |
| Monitoring | `@sentry/react-native` (scrub location/contact/OTP fields) |
| Push | `expo-notifications` + Expo Push Service |
| Address | Google Places Autocomplete (New) + Google Geocoding, proxied by authenticated Supabase Edge Function |
| Basic worker CSV | Standards-compliant CSV generated from approved worker-scoped rows, native share via `expo-sharing`; `expo-print` reserved for V1.1 advanced PDFs (locked provider, not installed unless used) |
| Testing | Maestro mobile E2E; Vitest shared/Edge; Jest + React Native Testing Library mobile; pgTAP + Supabase CLI; deterministic GPX/JSON location-trace replay harness |
| CI | GitHub Actions `ubuntu-latest` + Docker-hosted `supabase start`, migrations and pgTAP; EAS native build steps where credentials available |
| Deploy | GitHub + Expo EAS + separate Supabase staging/production Pro; Vercel future only |
| Working IDs | `com.sitemuster.app.dev` development; `com.sitemuster.app` production **reservation only**; finalize after brand clearance, before Transistorsoft release-key purchase |

**Version pinning:** At Milestone 01, verify Expo's latest **stable SDK** and all package peer dependencies. Record **actual selected SDK and exact package versions** in `CLAUDE.md` under an appended `## Pinned dependency manifest` heading, commit `package-lock.json`, use `npm ci`, and do not upgrade Expo SDK during subsequent milestones without an explicit dedicated upgrade PR and native compatibility checks. Do not invent exact library versions before repository creation. Use non-floating versions in committed manifests. User-approved product decisions are permanent; recorded implementation versions are resolved once during Milestone 01.

## Strictly banned patterns

- `localStorage`, `sessionStorage`, browser-only location APIs, timer-based location polling, or browser APIs inside native React Native modules.
- Supabase service-role keys, Twilio tokens, Google server keys, or Sentry auth tokens in app bundles.
- Direct mobile writes to authoritative attendance sessions, roles, approvals, account holds, or shared emergency accountability state.
- Direct Realtime Postgres Changes as the high-volume workforce channel; use private Broadcast + authorized refetch.
- Duplicate SDK/outbox events; queue ownership is exclusive per event class.
- Forcing SOS/muster `I'M SAFE` to become `VERIFIED_ACCOUNTED`; only attended kiosk or authorized human verification does that.
- Auto-approving registrations from a public/printed orientation QR; auto-certifying company affiliation; false proof of GPS accuracy.
- Hardcoded English-only UI copy, machine-approved Spanish consent, or collecting unrelated PII (SSN, medical records).
- Unlimited offsite GPS tracking, silently retaining worker paths, storing raw fixes indefinitely, using last inside fix as definite exit.
- Hardcoded demo headcounts or test credentials in production; client-only RLS, permissive default RLS, blanket `any`, silent catches, ignored CI failures, mock implementation claimed as shipped.
- Arbitrary customer worker/project caps, paywalls, subscription code, web portal, floor-plan upload/UI or polygon geofences in V1.

## Definition of Done / release gates

- Exact scoped functionality and deterministic failure cases pass; typecheck, lint, unit, integration, RLS, migration and CI green.
- New backend writes have idempotency and audit records. Sensitive functions validate identity, role, project, company and consent using server-derived IDs.
- At least 55 deterministic replay fixtures (the 55 named in `10-testing.md`, plus new cases from `07-edge-cases.md`) by Milestone 06, including contradictory, out-of-order, offline and clock-skew scenarios; replay expected sessions and counts match.
- EN/ES localization complete with no hardcoded strings; legal consent version human-approved for production.
- Real devices, permission and background lifecycle cases must be separately tracked, never simulated as completed. Full device field pilot gates public launch.
- Permission revocation, stale/unknown, offline, no-phone, printed badge and muster responses are visible in UI.
- Run `npm ci`, required checks, `supabase db test`, and CI; report exact commands, run context, outputs, and blocks.
- A production release is blocked by identity/RLS bypass, cross-project ingestion, offsite coordinate leak, false guaranteed headcounts, broken auth, data-loss outbox, unverified legal strings, or unsupported native app configuration.

## References and workflow

- Start with `docs/tasks/milestone-01.md` and complete only that PR.
- All software architecture and API rules: `docs/spec/00-decision-log.md` through `docs/spec/12-muster-mode.md`.
- Human-only accounts, keys, approvals: `docs/setup/HUMAN_CHECKLIST.md`.
- Legal sign-off requirements: `docs/legal/TRANSLATION_REVIEW.md`.
- Transistorsoft SDK docs: https://docs.transistorsoft.com/react-native/
- Supabase Realtime Broadcast: https://supabase.com/docs/guides/realtime/subscribing-to-database-changes

## Owner decision #48 — autonomy mode (binding; overrides only the three rules named here)

Recorded in full in `docs/spec/00-decision-log.md` #48. It replaces exactly these rules above: "start every milestone in plan mode and wait for the owner's OK", "Claude Code never merges its own PR / never `gh pr merge` / human alone merges", and "stop after each milestone / do not begin the next milestone". Everything else in this file stays binding.

- Run milestones 01 → 13 in order without waiting. Per milestone: short plan in the PR description → implement on `milestone-NN-<name>` → run every check locally → open PR → watch CI → fix until green.
- Self-merge (squash only) is allowed ONLY when ALL hold: required CI checks green; the milestone's acceptance tests pass; the PR checklist is fully filled in; no security, privacy, RLS or cross-tenant test is failing or skipped.
- Never force-push `main`, never bypass branch protection, never disable/delete a test or CI step to get green, never weaken a spec to pass.
- Missing account/secret/license/device → typed dev-only adapter, mark **NOT VERIFIED** in the PR and `docs/PROGRESS.md`, add the setup step to `docs/setup/HUMAN_CHECKLIST.md`, continue. Production fails closed; never falls back to a mock.
- Spec ambiguity/conflict → pick the option safest for privacy and data integrity, record a new numbered decision in `docs/spec/00-decision-log.md` with reasoning, note it in the PR, continue (this replaces "stop and ask" for ambiguity only).
- Stop and ask the owner ONLY for: a real secret, real money, publishing anything, or deleting/rewriting merged history.
- `docs/PROGRESS.md` is the resume point. After any context reset: re-read this file and `docs/PROGRESS.md`, then continue. Never redo merged work.

## Pinned dependency manifest

Resolved once in Milestone 01 (2026-11-03) per decision #33. Every version below is exact (no `^`/`~`) in `package.json`; `package-lock.json` is committed and CI installs with `npm ci`. Do not upgrade the Expo SDK, React Native or any native module outside a dedicated upgrade PR with native compatibility checks.

| Area | Package | Exact version |
|---|---|---|
| Runtime | Node.js (CI `actions/setup-node`) / npm | 22.x / 10.x |
| App | `expo` (SDK **58**, latest stable on 2026-11-03) | 58.0.23 |
| App | `react-native` / `react` | 0.88.1 / 19.3.0 |
| App | `typescript` (strict) | 6.0.3 |
| Routing | `expo-router` / `react-native-screens` / `react-native-safe-area-context` / `expo-linking` / `expo-constants` / `@expo/metro-runtime` | 58.0.30 / 4.30.1 / 5.11.1 / 58.0.16 / 58.0.15 / 58.0.17 |
| Background tracking | `react-native-background-geolocation` (Transistorsoft **v5**) | 5.8.2 |
| Operational outbox | `expo-sqlite` | 58.0.15 |
| Key protection | `expo-secure-store` / `expo-crypto` / `@noble/ciphers` / `@noble/hashes` | 58.0.2 / 58.0.7 / 2.4.0 / 2.4.0 |
| API client | `@supabase/supabase-js` | 2.118.0 |
| State/query | `@tanstack/react-query` | 5.105.3 |
| Runtime schemas | `zod` (mobile + Edge Functions via `npm:zod@4.6.7`) | 4.6.7 |
| Forms | `react-hook-form` / `@hookform/resolvers` | 7.91.0 / 7.0.2 |
| Maps | `react-native-maps` | 1.29.11 |
| QR scanner | `expo-camera` | 58.0.14 |
| QR display | `react-native-qrcode-svg` / `react-native-svg` | 6.3.52 / 15.16.0 |
| Localization | `expo-localization` / `i18next` / `react-i18next` | 58.0.5 / 26.7.1 / 17.1.12 |
| Monitoring | `@sentry/react-native` | 8.28.0 |
| Push | `expo-notifications` | 58.1.8 |
| Worker CSV / printable QR share | `expo-sharing` / `expo-file-system` (`expo-print` NOT installed: V1.1 only) | 58.0.22 / 58.0.13 |
| Native dev builds | `expo-dev-client` / `expo-status-bar` / `expo-system-ui` | 58.0.18 / 58.0.4 / 58.0.7 |
| Unit tests (shared/Edge) | `vitest` / `vite` | 5.1.0 / 8.3.5 |
| Mobile tests | `jest` / `jest-expo` / `@react-native/jest-preset` / `@testing-library/react-native` / `test-renderer` / `babel-preset-expo` | 30.5.2 / 58.0.14 / 0.88.1 / 14.1.0 / 1.3.0 / 58.0.24 |
| Lint/format | `eslint` / `eslint-config-expo` / `eslint-plugin-i18next` / `eslint-config-prettier` / `prettier` | 9.39.5 / 58.0.4 / 6.1.5 / 10.1.8 / 3.9.10 |
| Types | `@types/react` / `@types/node` | 19.3.0 / 22.20.5 |
| Database | Supabase CLI (`supabase/.cli-version`, decision #50) / local Postgres major | 2.122.1 / 17 |

Notes:
- `overrides.react-dom = 19.3.0` aligns an optional web-only peer (pulled in by `expo-router`) with Expo SDK 58's pinned React; the app is mobile-only and never renders with `react-dom`.
- ESLint stays on 9.x because `eslint-config-expo` 58 depends on `eslint-plugin-react`/`eslint-plugin-import`, which do not support ESLint 10.
- `npm audit --audit-level=high` passes; remaining advisories are moderate/low and limited to dev/build tooling (`glob`/`minimatch` via Jest, ESLint and Expo CLI).
- Native compatibility audit (Milestone 01): `expo prebuild --no-install` with every planned native plugin (Transistorsoft v5, expo-camera, expo-notifications, react-native-maps, expo-secure-store, expo-sqlite, Sentry, expo-localization, expo-router) generated iOS and Android projects without errors. Compiling native binaries needs EAS/macOS and is tracked as NOT VERIFIED until an EAS development build runs.
