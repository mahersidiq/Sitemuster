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
- [ ] Muster alerts (Milestone 11): set the non-secret build variable `EAS_PROJECT_ID` for every EAS environment. The app needs it to get an Expo push token; without it the phone shows "Muster alerts are not set up in this build" and registers nothing.
- [ ] Muster alerts: let EAS manage the push credentials: an Apple Push Notifications key for iOS (`eas credentials` → iOS → Push Notifications) and an FCM V1 service account key for Android (`eas credentials` → Android → FCM V1). Keep them in EAS only, never in the repository or the app.
- [ ] Optional: turn on "Enhanced push security" in the Expo project, create an Expo access token for push, and store it as the Edge Function secret `EXPO_ACCESS_TOKEN` on staging and production (`supabase secrets set EXPO_ACCESS_TOKEN=… --project-ref <ref>`). Without enhanced security leave it unset.

## 3. Supabase Pro — staging and production (`SB`)

- [ ] Create Supabase organization with paid Pro plan and **two separate projects**: `sitemuster-staging` and `sitemuster-production` (not one project per construction jobsite).
- [ ] Turn on backups, choose documented region, RLS, monitoring, appropriate access controls; store disaster-recovery access with owner.
- [ ] Collect public (nonsecret) each project URL and publishable/anon key. Map to EAS environments `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY`. They may exist in mobile bundles **only with correct RLS**.
- [ ] Record `SUPABASE_PROJECT_REF_STAGING`, `SUPABASE_PROJECT_REF_PRODUCTION` as GitHub environment variables.
- [ ] Create `SUPABASE_ACCESS_TOKEN` in protected GitHub Actions **secret** for migration deploy jobs, restricted to required projects; include appropriate deployment approval before touching prod.
- [ ] Store `SUPABASE_DB_PASSWORD_STAGING` / `SUPABASE_DB_PASSWORD_PRODUCTION` ONLY in protected CI/environment secret store if automation absolutely requires a DB password; never in mobile.
- [ ] Supabase Edge Functions private environment secrets: `SUPABASE_SERVICE_ROLE_KEY` (backend only), (`DEVICE_CREDENTIAL_PEPPER` is **not used** — do not create it; decision #135), `BADGE_SECRET_ENCRYPTION_KEY` (32-byte random key used to encrypt per-device badge secrets at rest), `GOOGLE_PLACES_SERVER_KEY` (created Step 5), `GOOGLE_GEOCODING_SERVER_KEY` (Step 5). Supabase supplies project-specific URLs/keys; do not mix staging/prod secrets.
- [ ] Edge Function secret `SITEMUSTER_ENV`: set `staging` on the staging project and `production` on the production project (`supabase secrets set SITEMUSTER_ENV=staging --project-ref <staging-ref>`). **Never** set `development` on a hosted project — that value alone switches address search to the labelled fake adapter (decision #63). Without the Google secrets below, hosted address search answers "not set up" instead of using fake data.
- [ ] Deploy the Edge Functions from a clean checkout after `npm ci` (their import maps point at the locked `node_modules`): `supabase functions deploy address-search address-resolve --project-ref <ref>`; JWT verification stays **on** for both (see `supabase/config.toml`).
- [ ] Edge Function secret `BADGE_SECRET_ENCRYPTION_KEY`: generate a separate value for staging and production with `openssl rand -base64 32` and set it with `supabase secrets set BADGE_SECRET_ENCRYPTION_KEY=… --project-ref <ref>`. Keep a sealed copy with the owner: losing it means every worker must re-activate their phone. `device-activate` refuses to run without it and refuses the development key (decision #71).
- [ ] Mark the environment in each project's SQL editor (decision #70). Staging: `insert into app_private.settings (key, value) values ('environment', 'staging') on conflict (key) do update set value = excluded.value;`. Production: leave unmarked (unmarked = production) or set `'production'`. Never set `'development'` on a hosted project.
- [ ] Deploy the Milestone 05 functions too: `supabase functions deploy orientation-session enrollment-bulk-approve device-activate --project-ref <ref>` (JWT verification on).
- [ ] Deploy the Milestone 07 functions: `supabase functions deploy ingest-location-batch device-renew device-activate --project-ref <ref>`. `ingest-location-batch` and `device-renew` deliberately run **without** gateway JWT verification (they check the 32-byte device secret themselves; `supabase/config.toml`). If the dashboard or CLI shows "Verify JWT" enabled for either, turn it off for these two only. Every other function keeps it on.
- [ ] Deploy the Milestone 08 function: `supabase functions deploy ingest-operations --project-ref <ref>`. JWT verification stays **on** (`supabase/config.toml`). It needs the same `BADGE_SECRET_ENCRYPTION_KEY` as `device-activate`. Without it, it answers "not configured" to every request and phones keep their kiosk and crew records queued (decision #102).
- [ ] Assign kiosk attendants: invite the people who run the gate kiosk to the project with the **Kiosk attendant** role (they need e-mail sign-in and an authenticator app, like other staff). A foreman may run a crew kiosk only after the GC grants it: project → **Foreman kiosk access** (Milestone 10, decision #113).
- [ ] Deploy the Milestone 10 functions: `supabase functions deploy daily-reports report-confirm --project-ref <ref>`. JWT verification stays **on** for both (`supabase/config.toml`). They need no new secret: reports are generated when someone opens a finished day, so no service key is stored in the database (decision #108).
- [ ] After deploying the Milestone 10 migration, confirm the job `sitemuster-report-deadline-sweep` (every 5 minutes) is listed by `select jobname, schedule, active from cron.job;` and its recent runs succeed. It marks unanswered reports NOT_CONFIRMED after 12:00 on the next workday; like the attendance sweep it does nothing on a database marked `development`.
- [ ] Deploy the Milestone 11 functions: `supabase functions deploy muster-start muster-close --project-ref <ref>`, and redeploy `ingest-operations` (muster checks). JWT verification stays **on** for both. Staging and production use the Expo Push Service (decision #116); a development value of `SITEMUSTER_ENV` would use the fake adapter, so check the secret is `staging` / `production`.
- [ ] Deploy the Milestone 12 function and redeploy the changed ones: `supabase functions deploy account-delete daily-reports device-activate device-renew ingest-location-batch ingest-operations muster-start muster-close report-confirm --project-ref <ref>`. JWT verification stays **on** for `account-delete` (and every other function except `ingest-location-batch` and `device-renew`). `account-delete` needs no new secret.
- [ ] After deploying the Milestone 12 migrations, confirm the hourly job `sitemuster-privacy-maintenance` (at minute 17) is listed by `select jobname, schedule, active from cron.job;` and its runs succeed. It runs in every environment: it deletes raw fixes, expired QR/badge/push secrets and old rate-limit buckets (after flagging), and processes account deletions.
- [ ] Give each project its emergency contact (decision #114): invite the safety manager to the project with the **Safety manager** role, or (as an organization admin) invite another person with **Emergency role** turned on. Only they can start and close a muster, always with the authenticator app.
- [ ] Configure database scheduled jobs for cleanup of raw fixes and expired tokens and review audit permissions.
- [ ] After deploying the Milestone 06 migrations, open *Database → Cron* (or run `select jobname, schedule, active from cron.job;` in the SQL editor) and confirm the job `sitemuster-attendance-sweep` runs every minute and its recent runs succeed. It applies the attendance time rules (unknown after 20 min, end-of-shift close-out, 24/7 review, visitor close-out) and only works when the environment marker above is `staging` or `production` — on a database marked `development` it deliberately does nothing. The migration enables the `pg_cron` and `btree_gist` extensions; if the deploy reports a permission error for either, enable it under *Database → Extensions* and deploy again.
- [ ] In **both** projects keep *API → Data API → Exposed schemas* to `public` and `graphql_public` only (never add `app_private`), and leave "automatically expose new tables" **off** (decision #57). Apply schema changes only through the repository migrations.
- [ ] In **both** projects open *Realtime → Settings* and turn **off** "Allow public access" so only private, policy-checked channels work (decision #19).
- [ ] In **both** projects, *Authentication → Providers*: enable **Phone** (Twilio, see §4) with signups on; *Authentication → Sign In / MFA*: enable **TOTP** (verify and enroll), maximum **2** factors per user; *Authentication → Settings*: SMS OTP length **6**, SMS OTP expiry **600 s**, email OTP expiry **600 s**, minimum interval between OTP requests **60 s**; *Authentication → Rate limits*: SMS sent per hour **≥ 400** (orientation needs ≥ 200 sign-ins/hour). Do **not** configure any `send_sms` hook in hosted projects (decision #59).
- [ ] *Authentication → Emails*: paste the bilingual template from `supabase/templates/sign-in-code.html` for "Magic link" and "Confirm signup" (both send the 6-digit code), subject "SiteMuster sign-in code / código de acceso".
- [ ] Confirm `supabase start`/pgTAP tests run in GitHub Actions; local Docker for Claude Code is optional.

## 3b. Email sending provider for staff sign-in codes (`EM`) — new, required before staff can sign in on hosted projects

- [ ] Create an account with a transactional email provider that offers SMTP (for example Postmark, Resend, Amazon SES or SendGrid). Verify the sending domain (SPF and DKIM DNS records) after the brand/domain is cleared (§9); a staging subdomain can be used before that.
- [ ] In each Supabase project open *Authentication → Emails → SMTP settings* and enter the provider's SMTP host, port, user and sender address; store the SMTP password only there (never in Git, CI or the app).
- [ ] Raise the project's email rate limit to match staff sign-in volume, then send yourself a staff sign-in code on staging and confirm it arrives within a minute in English and Spanish.

## 3c. Platform operator and daily health check (`OP`) — Milestone 12

The operator role is the only support access in V1 (no web admin). It can never see locations, contacts, rosters or attendance (decision #129).
- [ ] Choose who acts as platform operator (start with the owner). Create their staff account in the app on that project (email code), then turn on the authenticator app when asked. An operator must have one.
- [ ] Grant the role in each project's SQL editor (Supabase dashboard; never through the repository): `insert into app_private.platform_operators (user_id) select id from auth.users where email = '<operator email>';`. To remove it: `update app_private.platform_operators set active = false where user_id = (select id from auth.users where email = '<operator email>');`.
- [ ] On the operator's own trusted computer, in a clean checkout after `npm ci`, set three **public** values (never a service key): `SITEMUSTER_SUPABASE_URL`, `SITEMUSTER_SUPABASE_ANON_KEY` and `SITEMUSTER_OPERATOR_EMAIL`. Then run:

  ```bash
  npm run operator -- health --reason "first health check"
  ```

  It asks for the email code, then the authenticator code. Every command needs `--reason`, and every call is recorded with it.
- [ ] Every day, run `health`, then act on anything `docs/ops/observability.md` §1 lists:
  - a failed job;
  - an old account deletion;
  - open security flags: list them with `npm run operator -- flags --reason "…"`, and record what you found with `npm run operator -- flag-review <flag id> --note "<what you found>" --reason "…"`;
  - overdue secrets.
- [ ] Keep the incident response and breach notification process, with its contacts, outside this repository (spec 09). For a lost or stolen phone, run `npm run operator -- revoke-device <device id> --reason "<ticket>"`. For a staff member who lost every authenticator, run `mfa-reset <user id>`, and only after checking their identity outside the app.

## 4. Twilio and A2P 10DLC (`TW`)

- [ ] Create Twilio account, set billing and SMS sending number or Messaging Service, configure Supabase Phone Auth SMS provider with Twilio.
- [ ] For applicable US A2P traffic register business/brand and campaign under Twilio A2P 10DLC; complete vetting and opt-out/help requirements.
- [ ] Store `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_MESSAGING_SERVICE_SID` in Supabase Auth/provider configuration or backend secret store, **not GitHub repo or mobile app**. If supplied to CI, use protected GitHub Secrets only for dedicated integration checks.
- [ ] Test >=200 sign-ins per hour orientation capacity in controlled staging, OTP 6 digits/10 minutes, resend 60 seconds, provider costs/usage alerts, throttling and fraud protection.
- [ ] Use mock SMS adapter in development until provider is active; production signup cannot accept a mocked successful OTP.
- [ ] Turn on Twilio **SMS Pumping Protection** (Fraud Guard) for the Messaging Service, limit **Geo permissions** for SMS to the United States (add another country only when you hire there), and set a **usage trigger** that emails you at your monthly SMS budget. The app's own limits are per number, per IP and per project (`docs/security/rate-limits.md`, decision #132).

## 5. Google Cloud (`GC`)

- [ ] Create project `sitemuster-maps`, enable billing and Places API (New), Geocoding API, and Maps SDK for Android as needed.
- [ ] Create restricted server API keys for Places/Geocoding: `GOOGLE_PLACES_SERVER_KEY` / `GOOGLE_GEOCODING_SERVER_KEY`; store in **Supabase Edge Function secrets**, never mobile.
- [ ] Create Android Maps API key `GOOGLE_MAPS_ANDROID_API_KEY` restricted to Android app package ID and SHA-1/SHA-256 signing certificate fingerprints for each build type. Store in EAS environment config; the Android key can be embedded only with platform/API restrictions.
- [ ] iOS map provider is Apple Maps through `react-native-maps`; no Google iOS map dependency in V1.
- [ ] Set billing quotas, allowed APIs, audit provider attribution and Google Places autocomplete session token behavior. Use development-only geocoder adapter until keys available.
- [ ] Restrict each server key by **API** (Places API (New) only / Geocoding API only) and set daily quotas; use separate keys for staging and production. Store them with `supabase secrets set GOOGLE_PLACES_SERVER_KEY=… GOOGLE_GEOCODING_SERVER_KEY=… --project-ref <ref>` (never in EAS, GitHub variables or the app).
- [ ] Add `GOOGLE_MAPS_ANDROID_API_KEY` as an EAS environment variable (visibility "sensitive") for the `preview` and `production` environments. A production build is refused without it, and any build is refused if it equals a server key (`app.config.ts`).
- [ ] After the keys exist, run the Milestone 04 phone test on staging: the address search shows "Address results by Google" and no "Development address data" banner.

## 6. Sentry (`SE`)

- [ ] Create Sentry organization/project for React Native and separate staging/production environments.
- [ ] `EXPO_PUBLIC_SENTRY_DSN` is public DSN configured through EAS (not secret authentication). Store `SENTRY_AUTH_TOKEN` only in EAS/GitHub protected secrets for source-map uploads.
- [ ] Configure scrubbing: no raw GPS coordinates, emergency contacts, OTP, bearer tokens, full session JSON or screenshots exposing worker PII.
- [ ] Verify a synthetic crash appears in Sentry staging; do not upload synthetic/real personnel data in crash traces.
- [ ] Open that crash in Sentry and confirm it shows no coordinates, phone numbers, emails, codes, tokens, badge or QR payloads, screenshots or view hierarchy (`docs/security/secrets-audit.md`). Status until then: NOT VERIFIED.
- [ ] Add two Sentry alert rules for production: email the owner on every **new issue**, and on a **spike** in crash count. This, the daily operator health check (§3c) and the Supabase/Twilio usage alerts are the V1 alerting (decision #133; `docs/ops/observability.md`).

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
- [ ] Have counsel review **both** languages of each draft, as it is in the database: the worker location notice, the muster safety limitations (`docs/legal/drafts/MUSTER_SAFETY_LIMITATIONS_*_V1.md`) and the account deletion and retention notice (`ACCOUNT_DELETION_RETENTION_*_V1.md`). Record the review in `docs/legal/TRANSLATION_REVIEW.md` (reviewer name, role, date, reference; no signatures).
- [ ] Record each approval in the production database with the operator CLI (§3c). It binds to the exact text, so copy the hash shown by `legal-list`:

  ```bash
  npm run operator -- legal-list --reason "legal review <ref>"
  ```

  ```bash
  npm run operator -- legal-approve <notice id> --hash <sha256> --reviewer-name "<name>" --reviewer-role "<role>" --reference "<ref>" --reason "counsel sign-off <ref>"
  ```

  Approve the English **and** the Spanish version: production refuses worker consent and muster starts until both are approved (decision #123). A later text change is a new version. Mark it "material" if workers must accept it again.
- [ ] If counsel asks to keep records (litigation, or a contract that requires attendance to be kept), set a retention hold. A legal hold postpones account deletion; contract retention keeps attendance pseudonymized when someone deletes their account (decisions #127–#128). Use `npm run operator -- hold-set <organization id> --kind LEGAL_HOLD --basis "<case or contract>" --reason "<ticket>"`, and `hold-release <hold id>` when it ends.

## 10. Transistorsoft (`TS`) — LAST, after brand IDs locked

- [ ] Create Transistorsoft account / purchase the appropriate `react-native-background-geolocation` v5 **production release license** only after final app IDs are cleared. Product pricing may change; verify current official quote.
- [ ] Generate one iOS and one Android app-specific license key bound to final bundle ID/applicationId and correct signing configuration.
- [ ] Store `TS_IOS_LICENSE_KEY` and `TS_ANDROID_LICENSE_KEY` in secure EAS environment/secret store or supported native build secret injection; never in prompts or published spec ZIP.
- [ ] Verify native location SDK compiles on the selected pinned Expo SDK with config plugins; run real iOS/Android background, reboot, force-stop, offsite-payload and battery tests. License is not a substitute for OS permission or actual verification.
- [ ] Store the Android license as the EAS **production** environment secret `TS_ANDROID_LICENSE_KEY` (build-time only, never `EXPO_PUBLIC_`). `app.config.ts` refuses a production build without it (fail closed). Development builds run without a license (Transistorsoft DEBUG builds). SDK v5 needs no iOS key in this app's configuration; keep any iOS key Transistorsoft issues in the same secret store.

### Real-device kiosk, crew and visitor check (Milestone 08)

On a development build pointing at **staging**, with one attendant phone and two worker phones:

- [ ] Attendant: open the project, then **Kiosk sign-in/out**. Allow the camera. Scan a worker's badge from their phone. → "Recorded on this phone…" appears, then "<name>: recorded" within a few seconds.
- [ ] Turn on airplane mode on **both** the kiosk and the worker phone. Scan the badge again with **Leaving** selected. → "Waiting to sync — not confirmed". Turn airplane mode off on the kiosk and tap **Sync now**. → "<name>: recorded"; the worker's visit is closed.
- [ ] Scan the same badge twice within 30 seconds from two kiosks. → The second shows "This code was already used. Ask for a fresh code."
- [ ] Scan a printed badge (Workers → Printed badge). → A face-and-name confirmation appears first; after **Record**, the entry stays labelled "Printed badge".
- [ ] Foreman (worker account made foreman of an approved company): Home → **Crew sign-in/out** → select workers → **Record**. → One result per worker.
- [ ] Visitors: sign a visitor in and out. → They never appear in worker counts.
- [ ] With an unsent record (airplane mode on), sign out. → "Records not sent yet" asks before discarding.

### Real-device dashboard and map check (Milestone 09)

Needs an EAS development build (§2), a staging project with workers on site, and the Android map key (§5). Status: `NOT_EXECUTED_PHYSICAL_DEVICE`.
- [ ] Superintendent (signed in with the authenticator) opens **Home**: the counts match the people actually on site within the estimate, the sources add up, visitors are listed apart.
- [ ] A worker is scanned at the kiosk: the superintendent's Home updates by itself within a few seconds ("Live" line), without pulling to refresh.
- [ ] Airplane mode on the superintendent phone: Home shows "Offline: showing what was loaded at …" and keeps the numbers; airplane mode off: the line returns to "Live" and anything that changed meanwhile appears.
- [ ] **Map** on iPhone (Apple Maps) and Android (Google Maps with the restricted key): the site circle and exit ring sit on the right place, positions show accuracy circles, a position older than 10 minutes is grey and labelled "Stale, not live", and positions disappear after the worker leaves.
- [ ] A kiosk attendant opens **Map**: no positions, only the note and the counts.
- [ ] Remove the superintendent from the project in another session: their Home stops showing project data and says live updates stopped.
- [ ] Switch to Spanish: Home, Workforce and Map are fully in Spanish.

### Real-device reports and CSV share check (Milestone 10)

Needs an EAS development build (§2) and a staging project with one company, its verified foreman and a worker who worked yesterday. Status: `NOT_EXECUTED_PHYSICAL_DEVICE`.
- [ ] Superintendent: project → **Daily company reports** → yesterday shows the company with each worker's estimated hours and the "not payroll" notice; today says the day has not ended.
- [ ] Foreman (phone sign-in): Home → **Daily reports to answer** → **Something is wrong → Dispute** without a reason is refused; with a reason it is sent and the report leaves the list. The superintendent sees "Disputed by foreman" with the reason; the hours shown did not change.
- [ ] Superintendent: correct the visit (manual correction), then **Issue a corrected version** with a reason. Version 2 appears; "Earlier versions: v1 Replaced by a newer version" and the foreman's dispute stay visible. The foreman can confirm version 2.
- [ ] Leave a report unanswered past 12:00 the next workday. → It reads "Not confirmed (no answer in time)" and a late answer is refused.
- [ ] Worker: **Time History** → this week's and last week's estimated hours per day and the week total. **Ask for a correction** on one visit; the superintendent sees it under **Correction requests**, rejects it with a reason, and the worker sees "Rejected" with that reason.
- [ ] Worker: **Share my hours (CSV)** on iPhone and on Android. Save it and open it in Numbers, Google Sheets and Excel. → Columns Date, Project, Arrival, Departure, "Estimated onsite hours (not payroll)", Status; only this worker's visits; in Spanish the headers and accents (e.g. "nómina") read correctly.
- [ ] Superintendent: **Foreman kiosk access** → allow it for the foreman with a reason. → The foreman's Home shows the crew kiosk; remove it and the kiosk is refused on the next scan.

### Real-device muster drill (Milestone 11)

Needs an EAS development build with `EAS_PROJECT_ID` and push credentials (§2), a staging project with the Safety role assigned, two workers with phones (one iPhone, one Android), one worker without a phone, their verified foreman, a kiosk attendant and one signed-in visitor. Run it as a planned drill, never during a real emergency. Status: `NOT_EXECUTED_PHYSICAL_DEVICE`.
- [ ] Both workers: Home → **Turn on muster alerts** → allow notifications. → The card disappears (the phone is registered).
- [ ] Safety manager: project → **Emergency muster** → write "Drill" → **Start muster** → **Yes, start the muster**. → The board opens at once; "Alerts sent: 2 of 2".
- [ ] Within a few seconds both phones show "Emergency muster — tap I'M SAFE" (Spanish for a Spanish-language worker), also on the lock screen.
- [ ] iPhone worker: long-press the alert on the **locked** phone → **I'M SAFE**. → The phone asks to unlock (Face ID / code); after unlocking the app opens and shows "You said you are safe. That is not a physical check…". The board shows the worker as "Said safe (not checked)", never "Seen".
- [ ] Android worker: airplane mode on, open the app, tap **I'M SAFE**. → "Waiting to sync — not confirmed". Airplane mode off → "Recorded"; the board updates.
- [ ] Foreman: Home → **Emergency muster: check your crew** → only their own company's workers are listed → tap **Seen at the assembly point** for the worker without a phone. → It becomes "Seen at the assembly point" on the board.
- [ ] Kiosk attendant: board → **Scan badges at the assembly point** → scan the iPhone worker's badge with the kiosk in airplane mode. → "Waiting to sync"; after reconnecting, "<name>: recorded" and the worker moves from "Said safe" to "Seen".
- [ ] Visitor: the safety manager taps **Seen at the assembly point** on the visitor's row. → Counted under Visitors only, never under Workers.
- [ ] Turn notifications off for the app on one phone and start a second drill. → The muster starts anyway; the board shows that phone's alert as failed or "No phone registered", and the in-app I'M SAFE still works.
- [ ] Close: **Close the muster** without a note or without the acknowledgement is refused; with both, the report opens, says "not a certified life-safety record", lists who was never seen, and **Share text summary** opens the share sheet with the same text.
- [ ] After closing: **Add a correction** for one person → it appears under "Added after closing" with your name; the report above it is unchanged.
- [ ] Sign out on one worker phone and start another drill. → That phone gets no alert.

### Real-device privacy and account deletion check (Milestone 12)

Needs a staging project, one worker phone (development build) and one staff account with an authenticator. Status: `NOT_EXECUTED_PHYSICAL_DEVICE`.
- [ ] Worker: **Profile → Location and consent** → switch location **off** for the project. → "Location is off for this project. Nothing is sent from your phone for it." The superintendent's dashboard stops counting the worker by GPS, and the kiosk still accepts the worker's badge.
- [ ] Switch it back **on**. → The phone resumes; the status card shows the project as monitored again.
- [ ] Approve a new **material** version of the worker notice on staging (§9). → The worker's Privacy screen shows the new text with **Accept**; location stays off until accepted, then resumes.
- [ ] Worker: **Profile → Delete my account** → read the notice (marked draft on staging) → tick the box → **Continue** → enter the new SMS code → **Delete my account now**. → "Your account is being deleted…"; tapping **Done** signs out. Signing in again with the same number the same day shows only "Your account is being deleted" (decision #137). After the deletion is processed (next day), the same number starts a new, empty account: no projects, no badge.
- [ ] Right after the deletion: the old phone's badge is refused at the kiosk, and the superintendent no longer sees the worker as on site from that phone.
- [ ] Staff member with an authenticator: **Account → Delete my account** asks for the email code **and** the authenticator code. A founding organization owner is told to transfer ownership first.
- [ ] Next day, the operator's `health` shows `account_deletions.pending` back at 0.

### Real-device location privacy sign-off (release gate, decision #90)

Until this is recorded, production phones run **TRACKING_LIMITED**: only coordinate-free arrive/leave notes are sent, GPS never confirms arrival on its own, and workers are counted through the kiosk or their foreman. Repeat it for **each platform and each app version** that changes tracking code.

- [ ] Build a development or staging build (`com.sitemuster.app.dev`) pointing at **staging**, on one real iPhone and one real Android phone. Sign in as a test worker approved on a test project, accept the notice and set up the phone from the badge.
- [ ] Route the phone's traffic through an intercepting proxy you control (for example mitmproxy or Charles with its certificate installed on the test phone only) and record every request to `/functions/v1/ingest-location-batch` and `/functions/v1/device-renew`.
- [ ] Walk this route, with the app in the background and later swiped away: start ≥ 2 km from the site, arrive, stay ≥ 15 minutes (including 5+ minutes standing still), walk out past the site edge, and drive ≥ 2 km away. Repeat once in airplane mode for the middle part, then reconnect.
- [ ] Check every captured upload body:
  - **geofence** records contain no `latitude`/`longitude`/`coords`;
  - every **location** record lies inside the site circle plus 50 m;
  - nothing after leaving carries a position;
  - the record shape matches `src/tracking/templates.ts` (event names, `accuracy`, quoted booleans).

  Note anything else the SDK adds.
- [ ] Force a renewal: in the staging SQL editor run `update app_private.device_upload_credentials set expires_at = now() + interval '6 days' where device_id = '<test device id>' and overlap_until is null;`, then wait for the next upload. Check that the SDK calls `device-renew` with `refresh_token=…` and switches to the new secret, with no upload lost. This confirms the SDK's reading of `expires` (decision #92).
- [ ] Renewal while the app is closed (decision #97): swipe the app away, run the same SQL again, then walk or wait until the phone uploads in the background and calls `device-renew`. Reopen the app and keep capturing for at least 25 hours. Every later upload must carry the **new** secret: no `401`, and no request that sends the old secret again after the app reopens. This also confirms the app can read the SDK's saved secret before it starts the SDK.
- [ ] If everything passes, record the sign-off in the **production** SQL editor: `select app_private.record_location_privacy_signoff('IOS', '<app version>', '<your name>', '<where the capture files are kept>');` (and `'ANDROID'` separately). To withdraw it: `select app_private.revoke_location_privacy_signoff('<id>', '<reason>');`. Keep the capture files private: they contain test-site positions.

## Checklist-to-milestone map

`01 GH`; `02 SB/local CI`; `03 SB+TW+EM`; `04 SB+GC`; `05 SB+TW+EX`; `06 SB/local CI`; `07 EX+SB+TS dev integration`; `08 EX+SB`; `09 SB+GC`; `10 SB+EX`; `11 EX+SB`; `12 SE+SB+LEGAL+OP+TW+EX`; `13 GH+EX+SB+EM+TW+GC+SE+AP+GP+BRAND+TS+LEGAL+physical devices`.

## No-account development rules

- Provider interfaces such as `SmsOtpProvider`, `AddressProvider`, `PushProvider`, `LocationProvider` and `CredentialProvisioner` must have typed `Fake*` implementations only when `APP_ENV=development` or approved automated tests.
- Staging may use provider sandbox/test numbers transparently; production refuses boot/privileged operation if required live provider configuration, consent approval or security secret is missing.
- **Never write credentials into CLAUDE.md, docs, PR descriptions, GitHub Issues or screenshots.** Document environment variable names and where they belong, not values.
