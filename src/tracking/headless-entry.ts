import { Platform } from 'react-native';

import { registerHeadlessTracking } from './headless';

// Android delivers SDK events to a headless JS task while the app is closed (enableHeadless).
// iOS relaunches the app itself for region events, so nothing is registered there.
if (Platform.OS === 'android') registerHeadlessTracking();
