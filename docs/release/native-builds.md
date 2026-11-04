# Native builds with EAS (Milestone 13)

How the iOS and Android apps are built, why each build is reproducible, and what each build
needs. Status: **NOT VERIFIED** — no EAS build has run yet (needs the owner's Expo account,
HUMAN_CHECKLIST §2). A local `expo prebuild` with the production settings generates both native
projects without errors (see the Milestone 13 pull request).

## Profiles (`eas.json`)

| Profile | App environment | EAS environment | Backend | App id | Distribution | Use |
|---|---|---|---|---|---|---|
| `development` | `development` | `development` | whatever the `development` EAS environment names (usually staging) | `com.sitemuster.app.dev` | internal, development client | developer and device testing |
| `preview` | `staging` | `preview` | staging | `com.sitemuster.app.dev` | internal (APK on Android) | release candidates, phone test checklist, pilot rehearsal |
| `production` | `production` | `production` | production | `com.sitemuster.app` (after clearance) | store (AAB on Android) | TestFlight, Play testing tracks, store release |

Staging and production never share an app id, a backend or a key (decision #49,
`docs/release/environments.md`).

## Starting a build

Preferred: GitHub → Actions → **release** → Run workflow → choose the profile and platform (and
"submit" for production). The workflow refuses unless the commit's `code-quality` and `database`
checks passed, refuses production from anything but `main`, and needs the GitHub environment's
credentials (`EXPO_TOKEN`, `EAS_PROJECT_ID`, `EXPO_OWNER`). The `production` GitHub environment
should require the owner's approval.

From a trusted computer, the same thing is:

```bash
npx eas-cli@25.3.0 build --profile preview --platform all
```

## Why a build is reproducible

- `npm ci` from the committed `package-lock.json`; every JavaScript dependency is exact
  (CLAUDE.md "Pinned dependency manifest").
- EAS CLI pinned to **25.3.0** (`eas.json` `cli.version` and the workflow); Node **22.23.4** on the
  build servers (`eas.json`) and in the workflow.
- The Transistorsoft native SDKs are pinned to exact versions inside every build by
  `plugins/with-pinned-native-sdks.js`: Android `tslocationmanager` **4.7.8**, iOS
  `TSLocationManager` **4.8.3** (decision #144). The React Native package alone would float within
  `4.7.+` / `~> 4.8.0`, so two builds of the same app version could carry different native
  location code — not acceptable when the privacy sign-off is per app version (decision #90).
- `requireCommit: true`: only committed code is built. `appVersionSource: remote`: EAS assigns the
  build numbers (iOS `buildNumber`, Android `versionCode`), `autoIncrement` on production.
- The build image is the one EAS recommends for Expo SDK 58; the build log records it. Changing
  the Expo SDK, React Native or a native module needs a dedicated upgrade pull request (CLAUDE.md).

## What a production build checks (fail closed)

On the EAS build server (`EAS_BUILD=true`) `app.config.ts` refuses to build production unless
every one of these is set in the EAS `production` environment (decisions #51, #145, #146):

- `EXPO_PUBLIC_SUPABASE_URL` (https), `EXPO_PUBLIC_SUPABASE_ANON_KEY`, `EXPO_PUBLIC_SENTRY_DSN`;
- `GOOGLE_MAPS_ANDROID_API_KEY` (and never equal to a Google server key);
- `TS_ANDROID_LICENSE_KEY` (Transistorsoft release license);
- `SITEMUSTER_CLEARED_APP_ID` equal to `com.sitemuster.app` — the owner sets it only after brand
  clearance (HUMAN_CHECKLIST §9).

Any build, anywhere, refuses an `EXPO_PUBLIC_*` variable whose name looks like a secret. The EAS
CLI first reads the config on the developer's computer or the CI runner with only the profile's
`APP_ENV`, so the release gates run on the build server, where EAS also provides "Secret"
variables. A production app that somehow lacks its public configuration still refuses to run
(blocking configuration screen, `src/config/runtime-env.ts`), and the location SDK refuses to run
unlicensed.

## No over-the-air updates (decision #147)

`expo-updates` is not installed. Every change — including JavaScript — ships as a new store
build with a new version. Reasons: the location egress gate runs in JavaScript (decision #91) and
the privacy sign-off is per app version (decision #90); an over-the-air update could change it
under an already signed-off version. Rollback is therefore a store action (`runbooks.md` §1).

## Versions

- The marketing version is `version` in `app.config.ts` (`0.1.0` today). Raise it in a pull request
  for each store release; the build number is assigned by EAS.
- For each new version, record the real-device privacy sign-off for that exact version and
  platform before production phones may send on-site coordinates (HUMAN_CHECKLIST §12).

## Native configuration in this repository

- iOS: Info.plist permission texts in English and Spanish, background modes `location`, `fetch`,
  `processing`, the privacy manifest, Apple Maps (no Google key on iOS).
- Android: the location, foreground-service, notification and boot permissions; storage,
  microphone and (production) overlay permissions removed; no cloud backup; Google Maps with the
  restricted client key; the Transistorsoft license written into the manifest only from the EAS
  secret.
- Push: `expo-notifications`; the APNs key and FCM V1 credentials are managed by EAS.

## Changing the app identifiers (if the brand changes)

1. Counsel clears the new name and identifiers (HUMAN_CHECKLIST §9).
2. One pull request changes `BUNDLE_IDS.production` in `app.config.ts` (and `development`/`staging`
   if wanted), the deep-link `scheme`, and the documentation.
3. Register the new ids with Apple and Google; restrict the Android Maps key to the new package and
   signing fingerprints; get the Transistorsoft license for the new package.
4. Set `SITEMUSTER_CLEARED_APP_ID` to the new production id.
5. Installed test builds with the old id are separate apps: testers install the new one and sign in
   again (one tracking phone per worker, so activating it revokes the old one).
