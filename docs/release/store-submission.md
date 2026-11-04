# App Store and Google Play submission requirements (Milestone 13)

What each store needs before SiteMuster can be submitted, what the repository already provides,
and what only the owner (or counsel) can do. Nothing here has been submitted: publishing is a
human decision (decision #48 "stop and ask before publishing anything").

## 0. Blocking prerequisites (both stores)

| Requirement | Who | Status |
|---|---|---|
| Brand and identifier clearance for "SiteMuster" / `com.sitemuster.app` (HUMAN_CHECKLIST §9) | owner + counsel | BLOCKED — then set `SITEMUSTER_CLEARED_APP_ID` in the EAS production environment |
| Legal approval of the worker location notice, muster limitations and deletion notice, English **and** Spanish (TRANSLATION_REVIEW) | counsel | BLOCKED — production refuses consent and musters until then |
| Public **privacy policy URL** (both stores require one) | owner + counsel, hosted on the company's domain | BLOCKED — V1 builds no website; a single static page is enough |
| Public **account-deletion web page** (Google Play requires a link where people can ask for deletion without the app) | owner | BLOCKED — the same static page can describe the in-app path and give a contact address |
| Real-device location privacy sign-off per platform and app version (HUMAN_CHECKLIST §12, decision #90) | owner | `NOT_EXECUTED_PHYSICAL_DEVICE` — until then production phones run TRACKING_LIMITED |
| Transistorsoft Android release license bound to the final package id (HUMAN_CHECKLIST §10) | owner (purchase) | BLOCKED |
| Reviewer demo seeded on production (`docs/release/reviewer-demo.md`) | owner | BLOCKED on the legal approval above |
| Phone test checklist passed on the release build (`docs/release/phone-test-checklist.md`) | owner | `NOT_EXECUTED_PHYSICAL_DEVICE` |

## 1. Apple App Store

### Identity and signing
- Apple Developer Program membership; app record in App Store Connect with bundle id
  `com.sitemuster.app` (after clearance). Staging builds keep `com.sitemuster.app.dev` and never
  reach the store (decision #49).
- Signing is managed by EAS credentials (`eas credentials`); the App Store Connect API key is
  uploaded to EAS for `eas submit`. Add the app's numeric App Store Connect id as `ascAppId` under
  `submit.production.ios` in `eas.json` in a small pull request once the app record exists.

### Permission texts (already in the build, English and Spanish)
Defined in `locales/native/en.json` and `es.json`, written into Info.plist by `app.config.ts`:

| Key | English text |
|---|---|
| `NSLocationWhenInUseUsageDescription` | SiteMuster uses your location only to estimate when you arrive at and leave the jobsites you joined. It never sends where you are away from a site. |
| `NSLocationAlwaysAndWhenInUseUsageDescription` | Automatic attendance needs "Always" so your phone can notice you arriving at or leaving a jobsite while the app is closed. Away from sites only entering or leaving is noted, never your position. |
| `NSMotionUsageDescription` | SiteMuster uses motion only to save battery: it checks your location less often while you stand still on site. |
| `NSCameraUsageDescription` | SiteMuster uses the camera only to scan orientation and badge QR codes. |

Background modes: `location`, `fetch`, `processing` (Transistorsoft). No microphone, contacts,
photos, Bluetooth or tracking permission is requested.

### Privacy manifest (in the build)
`app.config.ts` `IOS_PRIVACY_MANIFEST`, written as `PrivacyInfo.xcprivacy` by prebuild (verified
in a local prebuild, see the PR): no tracking, no tracking domains; required-reason APIs
UserDefaults (CA92.1, 1C8F.1), file timestamps (C617.1, 0A2A.1, 3B52.1), system boot time
(35F9.1), disk space (E174.1, 85F4.1) — the union of what the native dependencies declare.

### App Privacy label (App Store Connect → App Privacy) — draft for the owner and counsel
"Data used to track you": **none**. "Data linked to you", all for **App Functionality** only:

| Data type | Why | Linked | Tracking |
|---|---|---|---|
| Precise Location | arrival/departure at joined jobsites; on-site position for staff (after the privacy sign-off) | yes | no |
| Name | worker roster, reports | yes | no |
| Phone Number | worker sign-in | yes | no |
| Email Address | staff sign-in | yes | no |
| User ID | account | yes | no |
| Device ID | one active tracking phone per worker (an installation hash) | yes | no |
| Other User Contact Info / Other Data | the worker's emergency contact (another person's name and phone) | yes | no |
| Crash Data | crash reports, scrubbed of personal data, no user id | **no** | no |

Counsel decides the category for the emergency contact (it is someone else's contact details).
The manifest's collected-data list must stay identical to the label.

### Other App Store answers
- **Sign in with Apple**: not required — the app offers no third-party or social sign-in (phone
  and e-mail one-time codes only; guideline 4.8).
- **Account deletion** (guideline 5.1.1(v)): in the app — Profile → Delete my account (workers)
  and More → Delete my account (staff). Reviewers test it with demo account B.
- **Export compliance** (owner + counsel answer the questionnaire; the build does not set
  `ITSAppUsesNonExemptEncryption`): facts — HTTPS through the operating system; AES-256-GCM
  (`@noble/ciphers`) to encrypt the app's own sign-in session on the phone; HMAC-SHA-256 for the
  offline kiosk badge; SHA-256 hashing. No proprietary or non-standard cryptography.
- **Age rating**: no objectionable content; business/productivity app.
- **Health and safety wording**: the muster screens state it is not a certified life-safety
  system; do not describe it as one in the store listing either.
- **Screenshots**: from a real device or simulator of the release build, demo data only.
- **App Review information**: demo account and notes from `docs/release/apple-review-notes.md`.

## 2. Google Play

### Identity and signing
- Play Console developer account with identity verification; app with package
  `com.sitemuster.app` (after clearance). Play App Signing on; the upload key is managed by EAS.
- New personal developer accounts must run a **closed test** with the required number of testers
  for the required days before production access; plan it into the field pilot (HUMAN_CHECKLIST
  §8).
- `eas.json` submits only to the **internal** track as a **draft**; promoting to production is
  done by hand in Play Console.

### Permissions (requested by the app)
From `app.config.ts` `ANDROID_TRACKING_PERMISSIONS` plus the plugins:

| Permission | Why |
|---|---|
| `ACCESS_FINE_LOCATION` | jobsite arrival/departure needs precise location (automatic attendance is refused on approximate) |
| `ACCESS_COARSE_LOCATION` | required by Android alongside fine location |
| `ACCESS_BACKGROUND_LOCATION` | noticing arrival/departure while the app is closed (declaration + video below) |
| `FOREGROUND_SERVICE` | the location service runs as a visible foreground service while tracking on site |
| `FOREGROUND_SERVICE_LOCATION` | Android 14 foreground-service type for location |
| `POST_NOTIFICATIONS` | the on-site service notification and emergency muster alerts |
| `RECEIVE_BOOT_COMPLETED` | resume monitoring the joined jobsites after a restart |
| `ACTIVITY_RECOGNITION` | sample less often while standing still (battery) |
| `WAKE_LOCK` | finish an upload the phone started before sleeping |
| `CAMERA` | scan orientation and badge QR codes (kiosk) |
| `INTERNET`, `VIBRATE` | network access; alert vibration |

Blocked (removed from the final manifest, `ANDROID_BLOCKED_PERMISSIONS`): `READ_EXTERNAL_STORAGE`,
`WRITE_EXTERNAL_STORAGE`, `RECORD_AUDIO`, and in production `SYSTEM_ALERT_WINDOW`. Android backup is
off (`allowBackup=false`): sessions, the offline outbox and device secrets never leave the phone.

Before every submission, read the **final merged** manifest from the built app bundle (EAS build
artifacts, or `bundletool dump manifest`), because native libraries add permissions at build time.
Every permission in it must be in this table or be blocked.

### Declarations (Play Console → App content)
- **Location permissions / background location**: the video and answers in
  `docs/release/play-background-location-video.md`.
- **Foreground service types**: `location` — "keeps noticing the worker's jobsite arrival and
  departure, and samples the on-site position while the worker is on a joined jobsite; shown
  with a persistent notification".
- **App access**: instructions and demo credentials (as for Apple).
- **Data safety** — draft for the owner and counsel:

| Data | Collected | Shared with third parties | Purpose | Optional? |
|---|---|---|---|---|
| Precise location | yes | no (staff of the same project are not a third party) | App functionality | yes — workers can switch it off per project and use the kiosk/foreman |
| Name, phone number, e-mail | yes | no | Account management, app functionality | no |
| Other info: emergency contact | yes | no | App functionality (safety) | no (required at orientation) |
| Device or other IDs | yes | no | App functionality, fraud prevention (one tracking phone per worker) | no |
| Crash logs | yes | no (Sentry is a processor) | App functionality / diagnostics | no |

  Data is encrypted in transit (HTTPS). Users can request deletion in the app and through the
  deletion web page.
- **Account deletion**: the in-app path plus the deletion web page URL from section 0.
- **Content rating**: questionnaire; no user-generated public content.
- **Target audience**: adults (18+), workplace app.

## 3. After approval (both stores)

- Release with a **phased rollout** (App Store) / **staged rollout** (Play) so a bad build can be
  halted (`docs/release/runbooks.md` §1).
- Every new app version needs its own real-device location privacy sign-off before production
  phones send any coordinates (decision #90); until then they stay in TRACKING_LIMITED.
