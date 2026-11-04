import type { Config } from 'react-native-background-geolocation';

import { TRACKING_DEFAULTS } from '@sitemuster/shared';

import { GEOFENCE_TEMPLATE, LOCATION_TEMPLATE } from './templates';

/**
 * Transistorsoft v5 configuration (docs/spec/03 "Native baseline", docs/spec/11; decisions #12,
 * #14, #15, #44, #45, #90–#92). Pure: builds the nested v5 `Config` checked against the installed
 * type definitions. Numeric SDK enums are written as their documented values:
 * DesiredAccuracy.High = -1, ActivityType.Fitness = 3, PersistMode.All = 2 / Geofence = -1,
 * NotificationPriority.Low = -1, LogLevel.Off = 0.
 */
export const PERSIST_MODE_ALL = 2 as const;
export const PERSIST_MODE_GEOFENCE = -1 as const;
const DESIRED_ACCURACY_HIGH = -1 as const;
const ACTIVITY_TYPE_FITNESS = 3 as const;
const NOTIFICATION_PRIORITY_LOW = -1 as const;
const LOG_LEVEL_OFF = 0 as const;

/** Offsite: geofence-only. Onsite: tracking with the egress gate (JS-driven sync). */
export type SdkMode = 'OFFSITE' | 'ONSITE';

export interface SdkConfigInput {
  /** `<supabase>/functions/v1/ingest-location-batch` (https outside development). */
  ingestUrl: string;
  /** `<supabase>/functions/v1/device-renew`. */
  renewUrl: string;
  /** The 32-byte device upload secret (base64url). */
  token: string;
  /** Epoch seconds at which the next renewal is due (30-day expiry − 7 days). */
  renewAfterEpochSeconds: number;
  /** Localized Android foreground-service notification (continuous onsite mode only). */
  notification: { title: string; text: string; channelName: string };
}

/** Authorization block: the SDK sends `Authorization: Bearer <token>` and refreshes natively. */
export function authorizationConfig(input: {
  token: string;
  renewUrl: string;
  renewAfterEpochSeconds: number;
}): NonNullable<Config['authorization']> {
  return {
    strategy: 'JWT', // the SDK's only strategy name; the token is our opaque device secret
    accessToken: input.token,
    refreshToken: input.token,
    refreshUrl: input.renewUrl,
    refreshPayload: { refresh_token: '{refreshToken}' },
    expires: input.renewAfterEpochSeconds,
  };
}

/** Everything that changes between offsite (geofence-only) and onsite (gated tracking). */
export function modeConfig(mode: SdkMode): Partial<Config> {
  const onsite = mode === 'ONSITE';
  return {
    http: {
      // Offsite only coordinate-free geofence records exist, so the SDK may upload them on its
      // own. Onsite, JavaScript runs the egress gate before every sync (decision #91).
      autoSync: !onsite,
    },
    persistence: { persistMode: onsite ? PERSIST_MODE_ALL : PERSIST_MODE_GEOFENCE },
    app: {
      // Stationary 5-minute samples need the app kept alive on iOS while on site only. (Android
      // runs the SDK's foreground service with the localized notification while tracking.)
      preventSuspend: onsite,
      heartbeatInterval: onsite ? TRACKING_DEFAULTS.stationary_sample_target_seconds : 15 * 60,
    },
  };
}

export function buildSdkConfig(input: SdkConfigInput, mode: SdkMode): Config {
  const modal = modeConfig(mode);
  return {
    reset: true,
    logger: { debug: false, logLevel: LOG_LEVEL_OFF, logMaxDays: 1 },
    geolocation: {
      desiredAccuracy: DESIRED_ACCURACY_HIGH,
      activityType: ACTIVITY_TYPE_FITNESS,
      distanceFilter: TRACKING_DEFAULTS.onsite_distance_filter_m,
      stationaryRadius: TRACKING_DEFAULTS.onsite_distance_filter_m,
      stopTimeout: TRACKING_DEFAULTS.native_stationary_stop_timeout_seconds / 60,
      pausesLocationUpdatesAutomatically: true,
      showsBackgroundLocationIndicator: true,
      locationUpdateInterval: TRACKING_DEFAULTS.moving_sample_target_seconds * 1000,
      fastestLocationUpdateInterval: 30_000,
      locationAuthorizationRequest: 'Always',
      // SiteMuster explains permissions in its own localized screens.
      disableLocationAuthorizationAlert: true,
      geofenceModeHighAccuracy: true,
      // Already inside a fence when it is registered → ENTER (decision #16).
      geofenceInitialTriggerEntry: true,
    },
    http: {
      url: input.ingestUrl,
      method: 'POST',
      rootProperty: 'locations',
      batchSync: true,
      maxBatchSize: TRACKING_DEFAULTS.location_ingest_max_batch_events,
      autoSyncThreshold: 0,
      headers: {},
      params: {},
      ...modal.http,
      // Never upload on start: the queue may still hold records an earlier, failed prune left
      // behind. Arming prunes first and only then lets the SDK upload (decision #96).
      autoSync: false,
    },
    authorization: authorizationConfig(input),
    persistence: {
      geofenceTemplate: GEOFENCE_TEMPLATE,
      locationTemplate: LOCATION_TEMPLATE,
      timestampFormat: 'iso',
      maxDaysToPersist: TRACKING_DEFAULTS.geofence_sdk_max_local_queue_age_days,
      maxRecordsToPersist: -1,
      // Provider changes would be synthetic records WITH coordinates: never persisted (spec 03).
      disableProviderChangeRecord: true,
      extras: {},
      ...modal.persistence,
    },
    app: {
      stopOnTerminate: false,
      startOnBoot: true,
      enableHeadless: true,
      notification: {
        title: input.notification.title,
        text: input.notification.text,
        channelName: input.notification.channelName,
        priority: NOTIFICATION_PRIORITY_LOW,
        sticky: true,
      },
      ...modal.app,
    },
  };
}
