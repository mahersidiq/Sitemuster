import { beforeEach, jest } from '@jest/globals';

/**
 * Deterministic native-module doubles for Jest. These replace native modules that cannot run in
 * Node; they are test doubles only and are never bundled into the app.
 */

type TestGlobals = typeof globalThis & { __deviceLocale?: string; __appEnv?: string };

const mockSecureStore = new Map<string, string>();

jest.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK: 'AFTER_FIRST_UNLOCK',
  getItemAsync: jest.fn(async (key: string) => mockSecureStore.get(key) ?? null),
  setItemAsync: jest.fn(async (key: string, value: string) => {
    mockSecureStore.set(key, value);
  }),
  deleteItemAsync: jest.fn(async (key: string) => {
    mockSecureStore.delete(key);
  }),
}));

jest.mock('expo-localization', () => ({
  getLocales: () => [{ languageTag: (globalThis as TestGlobals).__deviceLocale ?? 'en-US' }],
  getCalendars: () => [{ timeZone: 'America/Chicago' }],
}));

// react-native-maps is a native view; tests render a placeholder that exposes circle radii.
jest.mock('react-native-maps', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react') as typeof import('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = require('react-native') as typeof import('react-native');
  const MapView = React.forwardRef(function MapView(
    props: { children?: React.ReactNode },
    ref: React.Ref<{ animateToRegion: () => void }>,
  ) {
    React.useImperativeHandle(ref, () => ({ animateToRegion: () => undefined }));
    return React.createElement(View, { testID: 'native-map' }, props.children);
  });
  const Circle = (props: { radius: number }) =>
    React.createElement(View, { testID: `map-circle-${props.radius}` });
  const Marker = () => React.createElement(View, { testID: 'map-marker' });
  return {
    __esModule: true,
    default: MapView,
    Circle,
    Marker,
    PROVIDER_GOOGLE: 'google',
    PROVIDER_DEFAULT: undefined,
  };
});

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: {
    get expoConfig() {
      return { extra: { appEnv: (globalThis as TestGlobals).__appEnv ?? 'development' } };
    },
  },
}));

jest.mock('@sentry/react-native', () => ({
  init: jest.fn(),
  wrap: (component: unknown) => component,
}));

beforeEach(() => {
  mockSecureStore.clear();
  (globalThis as TestGlobals).__deviceLocale = 'en-US';
  (globalThis as TestGlobals).__appEnv = 'development';
});

// expo-sqlite / expo-crypto doubles (in-memory; tests never touch a device database).
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => {
    const rows = new Map<string, string>();
    return {
      execAsync: jest.fn(async () => undefined),
      getFirstAsync: jest.fn(async (_sql: string, params: string[]) => {
        const value = rows.get(params[0] ?? '');
        return value === undefined ? null : { value };
      }),
      getAllAsync: jest.fn(async () => [...rows.keys()].map((key) => ({ key }))),
      runAsync: jest.fn(async (sql: string, params: (string | number)[] = []) => {
        if (sql.startsWith('insert')) rows.set(String(params[0]), String(params[1]));
        else if (sql.includes('where key')) rows.delete(String(params[0]));
        else rows.clear();
      }),
    };
  }),
}));

jest.mock('expo-crypto', () => ({
  randomUUID: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { randomUUID } = require('node:crypto') as typeof import('node:crypto');
    return randomUUID();
  },
  getRandomBytes: (length: number) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { randomBytes } = require('node:crypto') as typeof import('node:crypto');
    return new Uint8Array(randomBytes(length));
  },
}));

// expo-camera: tests drive scanning through the typed-code fallback; permission is configurable.
type CameraGlobals = typeof globalThis & { __cameraGranted?: boolean };
jest.mock('expo-camera', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react') as typeof import('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = require('react-native') as typeof import('react-native');
  return {
    CameraView: (props: { testID?: string }) => React.createElement(View, { testID: props.testID }),
    useCameraPermissions: () => [
      { granted: (globalThis as CameraGlobals).__cameraGranted ?? true, canAskAgain: true },
      jest.fn(),
    ],
  };
});

// QR rendering: expose the encoded value as text so tests can assert exactly what is shown.
jest.mock('react-native-qrcode-svg', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react') as typeof import('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Text } = require('react-native') as typeof import('react-native');
  return {
    __esModule: true,
    // Like the real component, hand back a ref on every render (catches render loops in callers).
    default: (props: { value: string; getRef?: (ref: unknown) => void }) => {
      props.getRef?.({ toDataURL: (callback: (png: string) => void) => callback('iVBORw0KGgo=') });
      return React.createElement(Text, { testID: 'qr-value' }, props.value);
    },
  };
});

jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn(async () => true),
  shareAsync: jest.fn(async () => undefined),
}));

jest.mock('expo-file-system', () => ({
  Paths: { cache: 'cache' },
  File: jest.fn().mockImplementation(() => ({
    exists: false,
    uri: 'file:///cache/qr.png',
    create: jest.fn(),
    delete: jest.fn(),
    write: jest.fn(async () => undefined),
  })),
}));

beforeEach(() => {
  (globalThis as CameraGlobals).__cameraGranted = true;
});

// Transistorsoft native module: absent in Jest. A benign stand-in that reports "While Using" so
// the tracking service stays in PERMISSION_REQUIRED and never starts (screens test the UI only).
jest.mock('react-native-background-geolocation', () => {
  const ok = () => Promise.resolve(true);
  const subscription = { remove: () => undefined };
  return {
    __esModule: true,
    default: {
      ready: () => Promise.resolve({}),
      setConfig: () => Promise.resolve({}),
      start: () => Promise.resolve({}),
      startGeofences: () => Promise.resolve({}),
      stop: () => Promise.resolve({}),
      getState: () => Promise.resolve({}),
      getGeofences: () => Promise.resolve([]),
      addGeofences: ok,
      removeGeofences: ok,
      getLocations: () => Promise.resolve([]),
      destroyLocation: ok,
      destroyLocations: ok,
      getCount: () => Promise.resolve(0),
      sync: () => Promise.resolve([]),
      getCurrentPosition: () => Promise.reject(new Error('no location in tests')),
      getProviderState: () =>
        Promise.resolve({ enabled: true, status: 4, gps: true, network: true, accuracyAuthorization: 0 }),
      requestPermission: () => Promise.resolve(4),
      registerHeadlessTask: () => undefined,
      onGeofence: () => subscription,
      onLocation: () => subscription,
      onHeartbeat: () => subscription,
      onProviderChange: () => subscription,
      onHttp: () => subscription,
      onAuthorization: () => subscription,
      onConnectivityChange: () => subscription,
    },
  };
});
