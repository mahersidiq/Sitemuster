# Environments, variables and secrets — staging vs production (Milestone 13)

Every value SiteMuster reads from its environment, where it lives, and what happens without it.
`tests/security/env-inventory.test.ts` fails when code reads a name that is missing here, and when a
public (`EXPO_PUBLIC_*`) name is listed as a secret.

**Never paste a value into this repository, a pull request, an issue, a screenshot or a chat.** This
file lists names and places only. Staging and production always use **different** values: a
staging value must never work against production.

There are three environments:
- **development**: a developer's machine or a development build. Server-side fakes run only on a
  database marked `development` (local Docker / CI), never on a hosted project.
- **staging**: the `sitemuster-staging` Supabase project, the EAS `preview` environment and the
  GitHub environment `staging`.
- **production**: the `sitemuster-production` Supabase project, the EAS `production` environment
  and the GitHub environment `production` (with required reviewers).

## 1. App builds (EAS environments `development`, `preview`, `production`)

Set with `eas env:create` or on expo.dev → Project → Environment variables. "Plain text" and
"Sensitive" values are also readable by the EAS CLI; "Secret" values exist only on the EAS build
servers.

| Name | Kind | EAS visibility | development | preview (staging) | production | Without it |
|---|---|---|---|---|---|---|
| `APP_ENV` | public | set by `eas.json` profile | `development` | `staging` | `production` | defaults to `development` |
| `EXPO_PUBLIC_SUPABASE_URL` | public | Plain text | optional (usually staging) | staging URL | production URL | staging/production app shows the blocking configuration screen; production build refused on EAS |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | public (protected by RLS) | Plain text | optional | staging anon key | production anon key | same |
| `EXPO_PUBLIC_SENTRY_DSN` | public | Plain text | optional | staging DSN | production DSN | production build refused on EAS; production app shows the configuration screen |
| `GOOGLE_MAPS_ANDROID_API_KEY` | public client key, restricted to the package and signing certificate | Sensitive | optional | staging key | production key | production build refused on EAS; any build refused if it equals a server key |
| `TS_ANDROID_LICENSE_KEY` | secret | Secret | not used (DEBUG builds) | not used | Transistorsoft release license | production build refused on EAS |
| `SITEMUSTER_CLEARED_APP_ID` | public | Plain text | — | — | `com.sitemuster.app`, set only after brand clearance (HUMAN_CHECKLIST §9) | production build refused on EAS |
| `EAS_PROJECT_ID` | public | Plain text | EAS project id | same | same | no push token (muster alerts say "not set up in this build") |
| `EXPO_OWNER` | public | Plain text | Expo account/organization | same | same | EAS cannot find the project |
| `SENTRY_ORG`, `SENTRY_PROJECT` | public | Plain text | optional | staging project | production project | source maps are not uploaded |
| `SENTRY_AUTH_TOKEN` | secret | Secret | — | for source maps | for source maps | source maps are not uploaded |
| `EAS_BUILD` | set by EAS | — | — | `true` on the build server | `true` on the build server | release gates only run where it is `true` (decision #146) |

Store signing and push credentials are managed by **EAS credentials**, never as variables: the
iOS distribution certificate and provisioning profile, the Android upload keystore, the Apple
Push Notifications key and the FCM V1 service account (HUMAN_CHECKLIST §2, §7, §8). The App Store
Connect API key (`ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_API_PRIVATE_KEY`) and the Play service account
(`GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`) are also uploaded to EAS credentials for `eas submit`.

## 2. GitHub environments `staging` and `production` (release and deploy workflows)

Settings → Environments. Give `production` required reviewers (the owner) so every production
build and deploy waits for a person.

| Name | Kind | staging | production | Used by | Without it |
|---|---|---|---|---|---|
| `EXPO_TOKEN` | secret | Expo robot token | Expo robot token (may be the same robot) | `release.yml` | nothing is built ("not configured") |
| `EAS_PROJECT_ID` | variable | EAS project id | same | `release.yml` | nothing is built |
| `EXPO_OWNER` | variable | Expo owner | same | `release.yml` | nothing is built |
| `SUPABASE_ACCESS_TOKEN` | secret | token limited to the staging project where possible | token for production | `deploy-backend.yml` | nothing is deployed |
| `SUPABASE_DB_PASSWORD` | secret | staging database password | production database password | `deploy-backend.yml` | nothing is deployed |
| `SUPABASE_PROJECT_REF` | variable | staging project ref | production project ref | `deploy-backend.yml` | nothing is deployed |

The pull-request workflow (`ci.yml`) uses **no** secret at all.

## 3. Supabase Edge Function secrets (per hosted project, `supabase secrets set … --project-ref <ref>`)

| Name | Kind | staging | production | Without it |
|---|---|---|---|---|
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | provided by Supabase | automatic | automatic | — (never copy the service role key anywhere else) |
| `SITEMUSTER_ENV` | public | `staging` | `production` | treated as production; never set `development` on a hosted project |
| `BADGE_SECRET_ENCRYPTION_KEY` | secret | its own 32-byte key | its own 32-byte key | phone activation and kiosk scans answer "not configured" |
| `GOOGLE_PLACES_SERVER_KEY` | secret | staging key | production key | address search answers "not set up" |
| `GOOGLE_GEOCODING_SERVER_KEY` | secret | staging key | production key | same |
| `EXPO_ACCESS_TOKEN` | secret, optional | only with Expo "enhanced push security" | same | push works without it unless enhanced security is on |

`DEVICE_CREDENTIAL_PEPPER` is **not used** (decision #135).

## 4. Supabase Auth settings (dashboard, per project)

| Setting | Kind | Notes |
|---|---|---|
| Twilio account SID, auth token, Messaging Service SID | secret | Authentication → Providers → Phone (HUMAN_CHECKLIST §4) |
| SMTP host, user and password | secret | Authentication → Emails → SMTP (§3b) |
| Test phone numbers and their fixed codes | secret | **Production: only the App Review demo numbers** (§11); staging: test numbers for testers. Never a real person's number |
| TOTP MFA, OTP length/expiry, rate limits | settings | §3 |

## 5. Operator CLI (the operator's own computer, `npm run operator`)

| Name | Kind | Value |
|---|---|---|
| `SITEMUSTER_SUPABASE_URL` | public | the project URL (staging or production) |
| `SITEMUSTER_SUPABASE_ANON_KEY` | public | that project's anon key |
| `SITEMUSTER_OPERATOR_EMAIL` | public | the operator's sign-in e-mail |

The CLI never takes a service key: the operator signs in with an e-mail code and an authenticator.

## 6. Where staging and production are kept apart

- Different Supabase projects, different keys, different GitHub environments, different EAS
  environments.
- Different app identifiers: staging builds use `com.sitemuster.app.dev` (decision #49), so a
  staging build can never replace or be mistaken for the production app.
- The production database is unmarked (= production) or marked `production`; staging is marked
  `staging` (decision #70). A database marked `development` turns on fakes and is never hosted.
- Production refuses draft legal texts (decisions #70, #123), coordinates from builds without a
  privacy sign-off (#90) and simulation outside the demo allowlist (#140).
