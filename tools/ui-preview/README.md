# UI preview capture (development tool — NOT a device test)

SiteMuster is a native iOS/Android app (V1 mobile-only). The Linux build agent has no iOS
simulator or Android emulator, so PR screenshots are produced by rendering the **same React Native
screens through React Native Web in headless Chromium** at a phone-sized viewport.

- The capture runs in a throw-away copy of the repository (outside the repo). It temporarily adds
  `react-native-web` and enables the `web` platform **only in that copy**; the shipped app
  configuration stays `platforms: ["ios", "android"]`.
- Native modules without a web implementation are replaced in the copy by the shims in `shims/`
  (mirroring repository paths; e.g. in-memory storage instead of the iOS/Android secure store and
  SQLite). The encryption code itself is the real implementation.
- Scenarios that sign in (Milestone 03+) talk to the **local** Supabase stack (`supabase start`),
  reading development SMS codes from the local database and staff email codes from local Mailpit.
  Export `API_URL`, `ANON_KEY`, `DB_URL`, `MAILPIT_URL` from `supabase status -o env` first.
- Screenshots are labelled "web render" in PRs. They prove layout and EN/ES copy, never native
  behaviour (permissions, background location, secure storage, camera, push). Physical-device
  checks stay `NOT_EXECUTED_PHYSICAL_DEVICE` until the owner runs them.

Usage: `bash tools/ui-preview/capture.sh <scenario> <output-dir> <scratch-dir>`
(e.g. `bash tools/ui-preview/capture.sh m01 docs/screenshots/m01 /tmp/sitemuster-preview`).
