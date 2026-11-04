// Pins the Transistorsoft native SDK versions inside every native build (Milestone 13,
// decision #144). The React Native package only gives ranges (Android `4.7.+`, iOS `~> 4.8.0`), so
// without a pin each EAS build could pick a newer native SDK under the same app version. The
// real-device location privacy sign-off is recorded per app version (decision #90), so the
// native code inside a version must never change between builds. Upgrades go through a dedicated
// pull request, like the Expo SDK.
const fs = require('fs');
const path = require('path');
const { withDangerousMod, withProjectBuildGradle } = require('expo/config-plugins');

const TAG = 'sitemuster-pinned-native-sdks';
const VERSION = /^\d+\.\d+\.\d+$/;

function assertExact(version, label) {
  if (typeof version !== 'string' || !VERSION.test(version)) {
    throw new Error(`${label} must be an exact x.y.z version; received ${String(version)}.`);
  }
}

/** Root build.gradle: the library reads `rootProject.ext.tslocationmanagerVersion`. */
function pinAndroid(buildGradle, version) {
  assertExact(version, 'Android tslocationmanager');
  const kept = buildGradle
    .split('\n')
    .filter((line) => !line.includes(TAG))
    .join('\n')
    .trimEnd();
  return `${kept}\n\next.tslocationmanagerVersion = "${version}" // ${TAG}\n`;
}

/** Podfile: the podspec reads ENV['TSLOCATIONMANAGER_VERSION'] when CocoaPods loads it. */
function pinIos(podfile, version) {
  assertExact(version, 'iOS TSLocationManager');
  const kept = podfile
    .split('\n')
    .filter((line) => !line.includes(TAG))
    .join('\n');
  return `ENV['TSLOCATIONMANAGER_VERSION'] = '${version}' # ${TAG}\n${kept}`;
}

function withPinnedNativeSdks(config, props) {
  const { android, ios } = props ?? {};
  assertExact(android, 'Android tslocationmanager');
  assertExact(ios, 'iOS TSLocationManager');
  let next = withProjectBuildGradle(config, (mod) => {
    if (mod.modResults.language !== 'groovy') {
      throw new Error('Pinning the Android location SDK needs a Groovy root build.gradle.');
    }
    mod.modResults.contents = pinAndroid(mod.modResults.contents, android);
    return mod;
  });
  next = withDangerousMod(next, [
    'ios',
    async (mod) => {
      const podfile = path.join(mod.modRequest.platformProjectRoot, 'Podfile');
      fs.writeFileSync(podfile, pinIos(fs.readFileSync(podfile, 'utf8'), ios));
      return mod;
    },
  ]);
  return next;
}

module.exports = withPinnedNativeSdks;
module.exports.pinAndroid = pinAndroid;
module.exports.pinIos = pinIos;
