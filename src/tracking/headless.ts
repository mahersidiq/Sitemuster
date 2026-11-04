import BackgroundGeolocation, { type HeadlessEvent } from 'react-native-background-geolocation';

import { TrackingAgent } from './agent';
import { NativeTrackerDriver } from './native-driver';
import { createNativeTrackingStore } from './native-store';

/**
 * Android headless task (enableHeadless; docs/spec/03): when the app was swiped away, SDK events
 * still reach the same controller so offsite/onsite transitions and the egress gate keep working.
 * iOS relaunches the app itself for region events, where the foreground wiring runs instead.
 * Recovery from Force Stop, OEM task killers or revoked permission is never claimed.
 */
export async function handleHeadlessEvent(event: HeadlessEvent): Promise<void> {
  const agent = new TrackingAgent(new NativeTrackerDriver(), createNativeTrackingStore(), {
    failure: (failure) => console.warn('tracking-headless:', failure.command),
  });
  await agent.restore();
  const params = event.params ?? {};
  switch (event.name) {
    case 'geofence':
      await agent.geofence({
        identifier: String(params.identifier ?? ''),
        action: params.action === 'EXIT' ? 'EXIT' : 'ENTER',
        timestamp: String(params.timestamp ?? new Date().toISOString()),
      });
      break;
    case 'location':
      if (typeof params.uuid === 'string') {
        await agent.location({
          uuid: params.uuid,
          timestamp: typeof params.timestamp === 'string' ? params.timestamp : undefined,
          event: typeof params.event === 'string' ? params.event : undefined,
          mock: params.mock === true,
          coords: params.coords as { latitude: number; longitude: number; accuracy: number },
        });
      }
      break;
    case 'heartbeat':
      await agent.heartbeat();
      break;
    case 'connectivitychange':
      if (params.connected === true) await agent.sync();
      break;
    default:
      break;
  }
}

export function registerHeadlessTracking(): void {
  BackgroundGeolocation.registerHeadlessTask(handleHeadlessEvent);
}
