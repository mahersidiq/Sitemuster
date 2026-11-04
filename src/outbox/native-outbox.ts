import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import * as SQLite from 'expo-sqlite';

import { base64UrlDecode, base64UrlEncode } from '@sitemuster/shared';

import { ApiError, type SiteMusterApi } from '../api/types';
import { nativeRandomBytes } from '../auth/native-storage';
import { decryptValue, encryptValue, KEY_BYTES, SessionCipherError } from '../auth/session-cipher';
import {
  OperationalOutbox,
  type OutboxCipher,
  type OutboxRow,
  type OutboxStatus,
  type OutboxTable,
} from './outbox';

/**
 * Phone bindings for the operational outbox: its own expo-sqlite file and its own AES-256-GCM key
 * in the OS secure keystore (AFTER_FIRST_UNLOCK, decision #13). The key is separate from the
 * session key, so a session reset never destroys operations that have not reached the server.
 */
const DB_NAME = 'sitemuster-outbox.db';
const KEY_NAME = 'sitemuster.outbox-key.v1';
const SECURE_OPTIONS = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK };

function nativeTable(): OutboxTable {
  let ready: Promise<SQLite.SQLiteDatabase> | null = null;
  const db = () => {
    ready ??= SQLite.openDatabaseAsync(DB_NAME).then(async (database) => {
      await database.execAsync(
        `create table if not exists operational_outbox (
           event_uuid text primary key not null,
           actor_user_id text not null,
           created_at integer not null,
           status text not null,
           envelope text not null
         );
         create index if not exists operational_outbox_actor_idx
           on operational_outbox (actor_user_id, created_at);`,
      );
      return database;
    });
    return ready;
  };
  return {
    insert: async (row) => {
      await (
        await db()
      ).runAsync(
        'insert into operational_outbox (event_uuid, actor_user_id, created_at, status, envelope) values (?, ?, ?, ?, ?)',
        [row.eventUuid, row.actorUserId, row.createdAt, row.status, row.envelope],
      );
    },
    update: async (eventUuid: string, status: OutboxStatus, envelope: string) => {
      await (
        await db()
      ).runAsync('update operational_outbox set status = ?, envelope = ? where event_uuid = ?', [
        status,
        envelope,
        eventUuid,
      ]);
    },
    list: async (actorUserId) =>
      (
        await (
          await db()
        ).getAllAsync<{
          event_uuid: string;
          actor_user_id: string;
          created_at: number;
          status: OutboxStatus;
          envelope: string;
        }>(
          'select event_uuid, actor_user_id, created_at, status, envelope from operational_outbox where actor_user_id = ? order by created_at',
          [actorUserId],
        )
      ).map((row): OutboxRow => ({
        eventUuid: row.event_uuid,
        actorUserId: row.actor_user_id,
        createdAt: row.created_at,
        status: row.status,
        envelope: row.envelope,
      })),
    remove: async (eventUuids) => {
      const database = await db();
      for (const id of eventUuids) {
        await database.runAsync('delete from operational_outbox where event_uuid = ?', [id]);
      }
    },
  };
}

/**
 * The installation has ONE outbox key, shared by every outbox instance (one per signed-in person).
 * Every keystore access runs one at a time (review finding on PR #8): two first-time enqueues
 * that overlap (a double tap, two quick scans) must never each create a key, because the entry
 * sealed with the key that loses the race could never be opened again.
 */
let cachedKey: Uint8Array | null = null;
let keystoreQueue: Promise<unknown> = Promise.resolve();

function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = keystoreQueue.then(task, task);
  keystoreQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// A temporarily unreadable keystore (before first unlock) rejects: the rows stay untouched.
function loadKey(create: boolean): Promise<Uint8Array | null> {
  if (cachedKey) return Promise.resolve(cachedKey);
  return serialized(async () => {
    if (cachedKey) return cachedKey; // created by the call queued before this one
    const stored = await SecureStore.getItemAsync(KEY_NAME, SECURE_OPTIONS);
    if (stored) {
      const decoded = base64UrlDecode(stored);
      if (decoded.length !== KEY_BYTES) throw new SessionCipherError('outbox key has wrong length');
      cachedKey = decoded;
      return cachedKey;
    }
    if (!create) return null;
    const fresh = nativeRandomBytes(KEY_BYTES);
    await SecureStore.setItemAsync(KEY_NAME, base64UrlEncode(fresh), SECURE_OPTIONS);
    cachedKey = fresh;
    return cachedKey;
  });
}

function nativeCipher(): OutboxCipher {
  return {
    seal: async (eventUuid, plain) =>
      encryptValue(
        (await loadKey(true)) as Uint8Array,
        `outbox:${eventUuid}`,
        plain,
        nativeRandomBytes,
      ),
    open: async (eventUuid, envelope) => {
      const current = await loadKey(false);
      if (!current) return null;
      try {
        return decryptValue(current, `outbox:${eventUuid}`, envelope);
      } catch (error) {
        if (error instanceof SessionCipherError) return null;
        throw error;
      }
    },
  };
}

export function createNativeOutbox(api: SiteMusterApi, userId: string): OperationalOutbox {
  return new OperationalOutbox(
    {
      table: nativeTable(),
      cipher: nativeCipher(),
      send: async (request) => {
        try {
          return { ok: true, response: await api.ingestOperations(request) };
        } catch (error) {
          return { ok: false, code: error instanceof ApiError ? error.code : 'NETWORK' };
        }
      },
      now: () => Date.now(),
      newUuid: () => Crypto.randomUUID(),
      report: (entry) => console.warn('outbox:', JSON.stringify(entry)),
    },
    userId,
  );
}
