import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { EncryptedSessionStorage, type KeyStore, type KeyValueTable } from './encrypted-storage';

const rng = (n: number) => new Uint8Array(randomBytes(n));

function memoryTable(): KeyValueTable & { rows: Map<string, string> } {
  const rows = new Map<string, string>();
  return {
    rows,
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
}

function memoryKeyStore(): KeyStore & { value: string | null; locked: boolean } {
  const store = {
    value: null as string | null,
    locked: false,
    read: async () => {
      if (store.locked) throw new Error('User interaction is not allowed (device locked)');
      return store.value;
    },
    write: async (v: string) => {
      store.value = v;
    },
    delete: async () => {
      store.value = null;
    },
  };
  return store;
}

describe('EncryptedSessionStorage', () => {
  it('persists across app restarts ("reboot") with the same key and table', async () => {
    const table = memoryTable();
    const keys = memoryKeyStore();
    await new EncryptedSessionStorage(table, keys, rng).setItem('sitemuster-auth', '{"session":1}');
    const restarted = new EncryptedSessionStorage(table, keys, rng);
    expect(await restarted.getItem('sitemuster-auth')).toBe('{"session":1}');
  });

  it('stores only ciphertext in SQLite and only the key in the secure store', async () => {
    const table = memoryTable();
    const keys = memoryKeyStore();
    await new EncryptedSessionStorage(table, keys, rng).setItem(
      'sitemuster-auth',
      '{"refresh_token":"r-123"}',
    );
    expect(table.rows.get('sitemuster-auth')).not.toContain('r-123');
    expect(keys.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('keeps the session when the key is temporarily unreadable (before first unlock)', async () => {
    const table = memoryTable();
    const keys = memoryKeyStore();
    const storage = new EncryptedSessionStorage(table, keys, rng);
    await storage.setItem('sitemuster-auth', 'session');
    keys.locked = true;
    expect(await storage.getItem('sitemuster-auth')).toBeNull();
    expect(table.rows.size).toBe(1);
    keys.locked = false;
    expect(await storage.getItem('sitemuster-auth')).toBe('session');
  });

  it('wipes orphaned ciphertext when the key is gone (restore/reinstall mismatch)', async () => {
    const table = memoryTable();
    const keys = memoryKeyStore();
    const storage = new EncryptedSessionStorage(table, keys, rng);
    await storage.setItem('sitemuster-auth', 'session');
    keys.value = null;
    expect(await storage.getItem('sitemuster-auth')).toBeNull();
    expect(table.rows.size).toBe(0);
  });

  it('treats tampered ciphertext as signed out and removes it', async () => {
    const table = memoryTable();
    const keys = memoryKeyStore();
    const storage = new EncryptedSessionStorage(table, keys, rng);
    await storage.setItem('sitemuster-auth', 'session');
    table.rows.set('sitemuster-auth', 'smv1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAA');
    expect(await storage.getItem('sitemuster-auth')).toBeNull();
    expect(table.rows.has('sitemuster-auth')).toBe(false);
  });

  it('rotates the key and keeps every value readable', async () => {
    const table = memoryTable();
    const keys = memoryKeyStore();
    const storage = new EncryptedSessionStorage(table, keys, rng);
    await storage.setItem('a', 'one');
    await storage.setItem('b', 'two');
    const before = keys.value;
    const cipherBefore = table.rows.get('a');
    await storage.rotateKey();
    expect(keys.value).not.toBe(before);
    expect(table.rows.get('a')).not.toBe(cipherBefore);
    expect(await storage.getItem('a')).toBe('one');
    expect(await storage.getItem('b')).toBe('two');
  });

  it('sign-out wipe removes ciphertext and key', async () => {
    const table = memoryTable();
    const keys = memoryKeyStore();
    const storage = new EncryptedSessionStorage(table, keys, rng);
    await storage.setItem('sitemuster-auth', 'session');
    await storage.wipe();
    expect(table.rows.size).toBe(0);
    expect(keys.value).toBeNull();
    expect(await storage.getItem('sitemuster-auth')).toBeNull();
  });
});
