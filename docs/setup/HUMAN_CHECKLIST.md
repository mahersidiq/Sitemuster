# Human-only setup checklist — SiteMuster V1

This is for the non-developer owner. **Claude Code must never claim it created a third-party account, purchased a license, verified a legal translation, or tested a real phone without proof.** Work through in this order. Do NOT paste credentials into chat, PRs, docs, screenshots, source code, or issue descriptions. Share access through GitHub/Expo/Supabase's own member/integration settings; use GitHub Environment secrets and EAS/Supabase private secrets. If a service isn't ready, Claude Code uses a **typed development-only mock adapter** and marks production integration unverified. Production mode refuses to run security/location functionality on mocks.

## 1. GitHub (`GH`) — first

- [ ] Sign into GitHub; create **private** new repository `sitemuster` (EMPTY: do not upload old `jobsite-presence-mvp.zip`).
- [ ] Configure branches: `main` protected; require PR and passing `ci`; disallow direct main writes and self-merge; owner reviews/merges each milestone PR.
  - **Autonomy mode (decision #48) adjustment:** while autonomy mode is active, protect `main` with "Require a pull request before merging" and "Require status checks to pass" selecting the two `ci` jobs **`code-quality`** and **`database`**, block force pushes and deletions, but do **not** require an approving review (Claude Code cannot approve its own PR and must never bypass protection). Re-enable required reviews when autonomy mode ends. Claude Code squash-merges only when every #48 condition holds.
- [ ] Give Claude Code repository access via the GitHub CLI (`gh auth login`) on your machine or the Claude GitHub app; never provide a personal access token in prompt.
- [ ] Create GitHub Environments `staging` and `production`, with restricted deployment approvals; use secrets per environment.
- [ ] Configure repository Actions enabled and allow standard checkout/setup-node; verify workflow can run Ubuntu/Docker.
- [ ] Preserve `.github/workflows/ci.yml` from specification package and check CI logs on each PR.

## 2. Expo + EAS (`EX`)

- [ ] Create Expo account at https://expo.dev and organization/project `sitemuster`.
- [ ] Link GitHub source repository through Expo settings/EAS workflow; ask Claude Code to run `eas init` on owner-authenticated environment when ready.
- [ ] Configure EAS environments `development`, `preview`, `production`, separate iOS/Android profiles; staging builds point to staging Supabase, production points to prod Supabase.
- [ ] Add `EXPO_TOKEN` in **GitHub Actions secret** (short-scope service token; never in app). If EAS GitHub integration does not need it for a workflow, do not generate unnecessary token.
- [ ] Record `EAS_PROJECT_ID` and `EXPO_OWNER` as repository/EAS nonsecret variables. Claude Code stores exact settings in environment-specific config.
- [ ] Run owner-assisted EAS dev build and test on physical iPhone/Android when prerequisites ready; Expo Go is insufficient for native Transistorsoft behavior.

## 3. Supabase Pro — staging and production (`SB`)

- [ ] Create Supabase organization with paid Pro plan and **two separate projects**: `sitemuster-staging` and `sitemuster-production` (not one project per construction jobsite).
- [ ] Turn on backups, choose documented region, RLS, monitoring, appropriate access controls; store disaster-recovery access with owner.
- [ ] Collect public (nonsecret) each project URL and publishable/anon key. Map to EAS environments `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY`. They may exist in mobile bundles **only with correct RLS**.
- [ ] Record `SUPABASE_PROJECT_REF_STAGING`, `SUPABASE_PROJECT_REF_PRODUCTION` as GitHub environment variables.
- [ ] Create `SUPABASE_ACCESS_TOKEN` in protected GitHub Actions **secret** for migration deploy jobs, restricted to required projects; include appropriate deployment approval before touching prod.
- [ ] Store `SUPABASE_DB_PASSWORD_STAGING` / `SUPABASE_DB_PASSWORD_PRODUCTION` ONLY in protected CI/environment secret store if automation absolutely requires a DB password; never in mobile.
- [ ] Supabase Edge Functions private environment secrets: `SUPABASE_SERVICE_ROLE_KEY` (backend only), `DEVICE_CREDENTIAL_PEPPER` (if implementation uses keyed hash enhancement), `BADGE_SECRET_ENCRYPTION_KEY` (32-byte random key used to encrypt per-device badge secrets at rest), `GOOGLE_PLACES_SERVER_KEY` (created Step 5), `GOOGLE_GEOCODING_SERVER_KEY` (Step 5). Supabase supplies project-specific URLs/keys; do not mix staging/prod secrets.
- [ ] Configure database scheduled jobs for cleanup of raw fixes and expired tokens and review audit permissions.
- [ ] In **both** projects keep *API → Data API → Exposed schemas* to `public` and `graphql_public` only (never add `app_private`), and leave "automatically expose new tables" **off** (decision #57). Apply schema changes only through the repository migrations.
- [ ] In **both** projects open *Realtime → Settings* and turn **off** "Allow public access" so only private, policy-checked channels work (decision #19).
- [ ] In **both** projects, *Authentication → Providers*: enable **Phone** (Twilio, see §4) with signups on; *Authentication → Sign In / MFA*: enable **TOTP** (verify and enroll), maximum **2** factors per user; *Authentication → Settings*: SMS OTP length **6**, SMS OTP expiry **600 s**, email OTP expiry **600 s**, minimum interval between OTP requests **60 s**; *Authentication → Rate limits*: SMS sent per hour **≥ 400** (orientation needs ≥ 200 sign-ins/hour). Do **not** configure any `send_sms` hook in hosted projects (decision #59).
- [ ] *Authentication → Emails*: paste the bilingual template from `supabase/templates/sign-in-code.html` for "Magic link" and "Confirm signup" (both send the 6-digit code), subject "SiteMuster sign-in code / código de acceso".
- [ ] Confirm `supabase start`/pgTAP tests run in GitHub Actions; local Docker for Claude Code is optional.

## 3b. Email sending provider for staff sign-in codes (`EM`) — new, required before staff can sign in on hosted projects

- [ ] Create an account with a transactional email provider that offers SMTP (for example Postmark, Resend, Amazon SES or SendGrid). Verify the sending domain (SPF and DKIM DNS records) after the brand/domain is cleared (§9); a staging subdomain can be used before that.
- [ ] In each Supabase project open *Authentication → Emails → SMTP settings* and enter the provider's SMTP host, port, user and sender address; store the SMTP password only there (never in Git, CI or the app).
- [ ] Raise the project's email rate limit to match staff sign-in volume, then send yourself a staff sign-in code on staging and confirm it arrives within a minute in English and Spanish.

## 4. Twilio and A2P 10DLC (`TW`)

- [ ] Create Twilio account, set billing and SMS sending number or Messaging Service, configure Supabase Phone Auth SMS provider with Twilio.
- [ ] For applicable US A2P traffic register business/brand and campaign under Twilio A2P 10DLC; complete vetting and opt-out/help requirements.
- [ ] Store `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_MESSAGING_SERVICE_SID` in Supabase Auth/provider configuration or backend secret store, **not GitHub repo or mobile app**. If supplied to CI, use protected GitHub Secrets only for dedicated integration checks.
- [ ] Test >=200 sign-ins per hour orientation capacity in controlled staging, OTP 6 digits/10 minutes, resend 60 seconds, provider costs/usage alerts, throttling and fraud protection.
- [ ] Use mock SMS adapter in development until provider is active; production signup cannot accept a mocked successful OTP.

## 5. Google Cloud (`GC`)

- [ ] Create project `sitemuster-maps`, enable billing and Places API (New), Geocoding API, and Maps SDK for Android as needed.
- [ ] Create restricted server API keys for Places/Geocoding: `GOOGLE_PLACES_SERVER_KEY` / `GOOGLE_GEOCODING_SERVER_KEY`; store in **Supabase Edge Function secrets**, never mobile.
- [ ] Create Android Maps API key `GOOGLE_MAPS_ANDROID_API_KEY` restricted to Android app package ID and SHA-1/SHA-256 signing certificate fingerprints for each build type. Store in EAS environment config; the Android key can be embedded only with platform/API restrictions.
- [ ] iOS map provider is Apple Maps through `react-native-maps`; no Google iOS map dependency in V1.
- [ ] Set billing quotas, allowed APIs, audit provider attribution and Google Places autocomplete session token behavior. Use development-only geocoder adapter until keys available.

## 6. Sentry (`SE`)

- [ ] Create Sentry organization/project for React Native and separate staging/production environments.
- [ ] `EXPO_PUBLIC_SENTRY_DSN` is public DSN configured through EAS (not secret authentication). Store `SENTRY_AUTH_TOKEN` only in EAS/GitHub protected secrets for source-map uploads.
- [ ] Configure scrubbing: no raw GPS coordinates, emergency contacts, OTP, bearer tokens, full session JSON or screenshots exposing worker PII.
- [ ] Verify a synthetic crash appears in Sentry staging; do not upload synthetic/real personnel data in crash traces.

## 7. Apple Developer (`AP`)

- [ ] Create/confirm Apple Developer Program membership and App Store Connect access; setup requires human verification and fees.
- [ ] After name clearance (Step 9), register final iOS bundle ID; working development ID is `com.sitemuster.app.dev` and production ID reserved as `com.sitemuster.app` **until cleared**.
- [ ] Configure signing/provisioning via EAS credentials. If using App Store Connect API, protect `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_API_PRIVATE_KEY` in EAS/GitHub secret storage; private `.p8` file never in repository.
- [ ] Prepare reviewer demo account, App Review notes, iOS Always/Precise Location justification and background location usage descriptions; conduct real iPhone tracking/privacy tests and capture review evidence.

## 8. Google Play Console (`GP`)

- [ ] Register Google Play Developer account, complete human identity/business verification and app registration after brand clearance.
- [ ] Configure Android signing package ID and appropriate EAS credentials.
- [ ] If automated store distribution used, create restricted Play Console service account JSON and store as encrypted EAS/GitHub secret `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` (do not commit file).
- [ ] Prepare Android background location declaration, permission flow demo video (actual device), foreground service location disclosure, Android 13 notification permission and privacy policy.
- [ ] Complete Play-specific closed-test requirements for account/app category where applicable; do not assume immediate public release.

## 9. Final brand + legal consent (`BRAND`, `LEGAL`)

- [ ] Search USPTO, app stores, state businesses and domain conflicts for **SiteMuster**; clear business/consumer brand with qualified legal review.
- [ ] Only after clearance, lock final display name, iOS bundle identifier, Android applicationId and domain. Update development identifier if changed; document migration impact for installed test builds.
- [ ] Engage bilingual legal reviewer to approve English+Spanish worker location disclosures, GC custom notice template, data-processing terms, employer/union/contract implications and state monitoring notices. Enter review evidence into `docs/legal/TRANSLATION_REVIEW.md` WITHOUT uploading personal signatures or secrets.
- [ ] Provide project-specific standard privacy policy, in-app deletion instructions and retention basis. Production consent is blocked until both language versions approved.

## 10. Transistorsoft (`TS`) — LAST, after brand IDs locked

- [ ] Create Transistorsoft account / purchase the appropriate `react-native-background-geolocation` v5 **production release license** only after final app IDs are cleared. Product pricing may change; verify current official quote.
- [ ] Generate one iOS and one Android app-specific license key bound to final bundle ID/applicationId and correct signing configuration.
- [ ] Store `TS_IOS_LICENSE_KEY` and `TS_ANDROID_LICENSE_KEY` in secure EAS environment/secret store or supported native build secret injection; never in prompts or published spec ZIP.
- [ ] Verify native location SDK compiles on the selected pinned Expo SDK with config plugins; run real iOS/Android background, reboot, force-stop, offsite-payload and battery tests. License is not a substitute for OS permission or actual verification.

## Checklist-to-milestone map

`01 GH`; `02 SB/local CI`; `03 SB+TW+EM`; `04 SB+GC`; `05 SB+TW+EX`; `06 SB/local CI`; `07 EX+SB+TS dev integration`; `08 EX+SB`; `09 SB+GC`; `10 SB+EX`; `11 EX+SB`; `12 SE+SB+LEGAL`; `13 GH+EX+SB+EM+TW+GC+SE+AP+GP+BRAND+TS+LEGAL+physical devices`.

## No-account development rules

- Provider interfaces such as `SmsOtpProvider`, `AddressProvider`, `PushProvider`, `LocationProvider` and `CredentialProvisioner` must have typed `Fake*` implementations only when `APP_ENV=development` or approved automated tests.
- Staging may use provider sandbox/test numbers transparently; production refuses boot/privileged operation if required live provider configuration, consent approval or security secret is missing.
- **Never write credentials into CLAUDE.md, docs, PR descriptions, GitHub Issues or screenshots.** Document environment variable names and where they belong, not values.
