import { beforeEach, jest } from '@jest/globals';

/**
 * Deterministic native-module doubles for Jest. These replace native modules that cannot run in
 * Node; they are test doubles only and are never bundled into the app.
 */

type TestGlobals = typeof globalThis & {
  __deviceLocale?: string;
  __appEnv?: string;
  /** Milestone 09: the native map fails to render (no map key, provider error). */
  __mapFails?: boolean;
  /** Milestone 09: regions the native map was moved to (animateToRegion). */
  __mapAnimations?: { latitude: number; longitude: number }[];
  /** Milestone 11: the EAS project id an Expo push token is issued for (unset: none). */
  __easProjectId?: string;
};

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
    ref: React.Ref<{ animateToRegion: (region: { latitude: number; longitude: number }) => void }>,
  ) {
    React.useImperativeHandle(ref, () => ({
      animateToRegion: (region: { latitude: number; longitude: number }) => {
        (globalThis as TestGlobals).__mapAnimations?.push(region);
      },
    }));
    if ((globalThis as TestGlobals).__mapFails) throw new Error('map provider failed');
    return React.createElement(View, { testID: 'native-map' }, props.children);
  });
  const Circle = (props: { radius: number }) =>
    React.createElement(View, { testID: `map-circle-${props.radius}` });
  const Marker = (props: { title?: string; description?: string }) =>
    React.createElement(View, {
      testID: 'map-marker',
      accessibilityLabel: [props.title, props.description].filter(Boolean).join(': '),
    });
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
      const g = globalThis as TestGlobals;
      return {
        extra: {
          appEnv: g.__appEnv ?? 'development',
          ...(g.__easProjectId ? { eas: { projectId: g.__easProjectId } } : {}),
        },
      };
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
  (globalThis as TestGlobals).__mapFails = false;
  (globalThis as TestGlobals).__mapAnimations = [];
});

// expo-sqlite / expo-crypto doubles (in-memory; tests never touch a device database).
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => {
    const rows = new Map<string, string>();
    // The operational outbox table (src/outbox/native-outbox.ts), keyed by event_uuid.
    type MockOutboxRow = {
      event_uuid: string;
      actor_user_id: string;
      created_at: number;
      status: string;
      envelope: string;
    };
    const outbox = new Map<string, MockOutboxRow>();
    return {
      execAsync: jest.fn(async () => undefined),
      getFirstAsync: jest.fn(async (_sql: string, params: string[]) => {
        const value = rows.get(params[0] ?? '');
        return value === undefined ? null : { value };
      }),
      getAllAsync: jest.fn(async (sql: string, params: (string | number)[] = []) =>
        sql.includes('operational_outbox')
          ? [...outbox.values()]
              .filter((row) => row.actor_user_id === params[0])
              .sort((a, b) => a.created_at - b.created_at)
          : [...rows.keys()].map((key) => ({ key })),
      ),
      runAsync: jest.fn(async (sql: string, params: (string | number)[] = []) => {
        if (sql.includes('operational_outbox')) {
          const id = String(sql.startsWith('update') ? params[2] : params[0]);
          if (sql.startsWith('insert')) {
            if (outbox.has(id)) throw new Error('UNIQUE constraint failed');
            outbox.set(id, {
              event_uuid: id,
              actor_user_id: String(params[1]),
              created_at: Number(params[2]),
              status: String(params[3]),
              envelope: String(params[4]),
            });
          } else if (sql.startsWith('update')) {
            const row = outbox.get(id);
            if (row)
              outbox.set(id, { ...row, status: String(params[0]), envelope: String(params[1]) });
          } else if (sql.startsWith('delete')) {
            outbox.delete(id);
          }
          return;
        }
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

// expo-notifications (Milestone 11): permission, push token and the last tapped alert are
// controllable; channels and categories are recorded so tests can check the I'M SAFE button.
interface MockNotificationState {
  permission: { granted: boolean; canAskAgain: boolean };
  requestResult: { granted: boolean; canAskAgain: boolean };
  lastResponse: unknown;
  responseListeners: Set<(response: unknown) => void>;
  receivedListeners: Set<(notification: unknown) => void>;
  categories: Record<string, unknown>;
  channels: Record<string, unknown>;
  token: string;
}
type NotificationGlobals = typeof globalThis & { __notifications?: MockNotificationState };
jest.mock('expo-notifications', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react') as typeof import('react');
  const state = () => (globalThis as NotificationGlobals).__notifications as MockNotificationState;
  return {
    AndroidImportance: { DEFAULT: 5, HIGH: 6, MAX: 7 },
    AndroidNotificationVisibility: { PUBLIC: 1, PRIVATE: 2, SECRET: 3 },
    DEFAULT_ACTION_IDENTIFIER: 'expo.modules.notifications.actions.DEFAULT',
    setNotificationHandler: jest.fn(),
    setNotificationChannelAsync: jest.fn(async (id: string, channel: unknown) => {
      state().channels[id] = channel;
      return channel;
    }),
    setNotificationCategoryAsync: jest.fn(async (id: string, actions: unknown) => {
      state().categories[id] = actions;
      return { identifier: id, actions };
    }),
    getPermissionsAsync: jest.fn(async () => ({ ...state().permission })),
    requestPermissionsAsync: jest.fn(async () => {
      state().permission = { ...state().requestResult };
      return { ...state().permission };
    }),
    getExpoPushTokenAsync: jest.fn(async () => ({ type: 'expo', data: state().token })),
    addNotificationReceivedListener: jest.fn((listener: (notification: unknown) => void) => {
      state().receivedListeners.add(listener);
      return { remove: () => state().receivedListeners.delete(listener) };
    }),
    useLastNotificationResponse: () => {
      const [value, setValue] = React.useState<unknown>(state().lastResponse);
      React.useEffect(() => {
        const listener = (response: unknown) => setValue(response);
        state().responseListeners.add(listener);
        return () => {
          state().responseListeners.delete(listener);
        };
      }, []);
      return value;
    },
    clearLastNotificationResponseAsync: jest.fn(async () => {
      state().lastResponse = null;
    }),
  };
});

beforeEach(() => {
  (globalThis as NotificationGlobals).__notifications = {
    permission: { granted: false, canAskAgain: true },
    requestResult: { granted: true, canAskAgain: true },
    lastResponse: null,
    responseListeners: new Set(),
    receivedListeners: new Set(),
    categories: {},
    channels: {},
    token: 'ExponentPushToken[testtoken0001]',
  };
  delete (globalThis as TestGlobals).__easProjectId;
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
        Promise.resolve({
          enabled: true,
          status: 4,
          gps: true,
          network: true,
          accuracyAuthorization: 0,
        }),
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
