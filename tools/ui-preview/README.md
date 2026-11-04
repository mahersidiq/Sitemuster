# UI preview capture (development tool — NOT a device test)

SiteMuster is a native iOS/Android app (V1 mobile-only). The Linux build agent has no iOS
simulator or Android emulator, so PR screenshots are produced by rendering the **same React Native
screens through React Native Web in headless Chromium** at a phone-sized viewport.

- The capture runs in a throw-away copy of the repository (outside the repo). It temporarily adds
  `react-native-web` and enables the `web` platform **only in that copy**; the shipped app
  configuration stays `platforms: ["ios", "android"]`.
- Native modules without a web implementation are replaced in the copy by the shims in `shims/`
  (for example, in-memory language preference instead of the iOS/Android secure store).
- Screenshots are labelled "web render" in PRs. They prove layout and EN/ES copy, never native
  behaviour (permissions, background location, secure storage, camera, push). Physical-device
  checks stay `NOT_EXECUTED_PHYSICAL_DEVICE` until the owner runs them.

Usage: `bash tools/ui-preview/capture.sh <scenario> <output-dir> <scratch-dir>`
(e.g. `bash tools/ui-preview/capture.sh m01 docs/screenshots/m01 /tmp/sitemuster-preview`).
