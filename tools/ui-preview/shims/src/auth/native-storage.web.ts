import type { RandomBytes } from '@sitemuster/shared';

import { EncryptedSessionStorage, type KeyStore, type KeyValueTable } from './encrypted-storage';

/**
 * UI-preview shim (web render only): the same AES-256-GCM EncryptedSessionStorage, backed by
 * in-memory maps instead of expo-sqlite / expo-secure-store. Never shipped in the native app.
 */
const rows = new Map<string, string>();
let key: string | null = null;

const table: KeyValueTable = {
  get: async (k) => rows.get(k) ?? null,
  set: async (k, v) => {
    rows.set(k, v);
  },
  remove: async (k) => {
    rows.delete(k);
  },
  keys: async () => [...rows.keys()],
  clear: async () => rows.clear(),
};

const keyStore: KeyStore = {
  read: async () => key,
  write: async (v) => {
    key = v;
  },
  delete: async () => {
    key = null;
  },
};

export const nativeRandomBytes: RandomBytes = (length) =>
  globalThis.crypto.getRandomValues(new Uint8Array(length));

export function createNativeSessionStorage(): EncryptedSessionStorage {
  return new EncryptedSessionStorage(table, keyStore, nativeRandomBytes);
}
