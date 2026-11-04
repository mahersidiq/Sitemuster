import Constants from 'expo-constants';
import { Platform } from 'react-native';

import type { SiteMusterApi } from '../api/types';
import { loadDevice, updateUploadToken } from '../device/device-store';
import { renewWithSecret } from './credential';
import { NativeTrackerDriver } from './native-driver';
import { createNativeTrackingStore } from './native-store';
import { TrackingService } from './service';

/**
 * The production tracking service: the native Transistorsoft driver only. There is no fallback
 * to the simulated SDK in a release build (decision #18); without a Supabase URL the service is
 * not created at all (fail closed, decision #51).
 */
export function trackingUrls(supabaseUrl: string): { ingest: string; renew: string } {
  const base = supabaseUrl.replace(/\/+$/, '');
  return {
    ingest: `${base}/functions/v1/ingest-location-batch`,
    renew: `${base}/functions/v1/device-renew`,
  };
}

export function createNativeTrackingService(input: {
  api: SiteMusterApi;
  supabaseUrl: string;
  /** Localized Android foreground-service notification (continuous onsite mode). */
  notification: { title: string; text: string; channelName: string };
}): TrackingService {
  const urls = trackingUrls(input.supabaseUrl);
  const appVersion = Constants.expoConfig?.version ?? '0.0.0';
  return new TrackingService({
    api: input.api,
    driver: new NativeTrackerDriver(),
    store: createNativeTrackingStore(),
    devices: { load: loadDevice, updateToken: updateUploadToken },
    urls,
    platform: Platform.OS === 'android' ? 'android' : 'ios',
    appVersion,
    now: () => Date.now(),
    notification: input.notification,
    renewWithSecret: (token) => renewWithSecret(urls.renew, token, appVersion),
    report: (entry) => console.warn('tracking:', JSON.stringify(entry)),
  });
}
