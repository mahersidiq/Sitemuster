import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import * as SQLite from 'expo-sqlite';

import type { RandomBytes } from '@sitemuster/shared';

import { EncryptedSessionStorage, type KeyStore, type KeyValueTable } from './encrypted-storage';

/** Native bindings for the encrypted session store (expo-sqlite + expo-secure-store + expo-crypto). */
const KEY_NAME = 'sitemuster.session-key.v1';
const SECURE_OPTIONS = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK };

function lazyTable(): KeyValueTable {
  let ready: Promise<SQLite.SQLiteDatabase> | null = null;
  const db = () => {
    ready ??= SQLite.openDatabaseAsync('sitemuster-secure.db').then(async (database) => {
      await database.execAsync(
        'create table if not exists secure_kv (key text primary key not null, value text not null, updated_at integer not null)',
      );
      return database;
    });
    return ready;
  };
  return {
    get: async (key) =>
      (
        await (
          await db()
        ).getFirstAsync<{ value: string }>('select value from secure_kv where key = ?', [key])
      )?.value ?? null,
    set: async (key, value) => {
      await (
        await db()
      ).runAsync(
        'insert into secure_kv (key, value, updated_at) values (?, ?, ?) on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at',
        [key, value, Date.now()],
      );
    },
    remove: async (key) => {
      await (await db()).runAsync('delete from secure_kv where key = ?', [key]);
    },
    keys: async () =>
      (await (await db()).getAllAsync<{ key: string }>('select key from secure_kv')).map(
        (row) => row.key,
      ),
    clear: async () => {
      await (await db()).runAsync('delete from secure_kv');
    },
  };
}

const keyStore: KeyStore = {
  read: () => SecureStore.getItemAsync(KEY_NAME, SECURE_OPTIONS),
  write: (value) => SecureStore.setItemAsync(KEY_NAME, value, SECURE_OPTIONS),
  delete: () => SecureStore.deleteItemAsync(KEY_NAME, SECURE_OPTIONS),
};

export const nativeRandomBytes: RandomBytes = (length) => Crypto.getRandomBytes(length);

export function createNativeSessionStorage(): EncryptedSessionStorage {
  return new EncryptedSessionStorage(lazyTable(), keyStore, nativeRandomBytes);
}
