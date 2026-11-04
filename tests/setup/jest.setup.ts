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
}));

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
