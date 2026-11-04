import Constants from 'expo-constants';
import { randomUUID } from 'expo-crypto';
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
  /** Localized Android foreground-service notification, read when the SDK starts. */
  notification: () => { title: string; text: string; channelName: string };
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
    postRecord: async (record, token) => {
      try {
        const response = await fetch(urls.ingest, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ locations: [record] }),
        });
        return response.ok;
      } catch {
        // Offline: reported again at the next start (the caller logs the failure).
        return false;
      }
    },
    newUuid: () => randomUUID(),
    report: (entry) => console.warn('tracking:', JSON.stringify(entry)),
  });
}
