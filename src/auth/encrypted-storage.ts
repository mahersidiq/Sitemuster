import type { RandomBytes } from '@sitemuster/shared';
import { base64UrlDecode, base64UrlEncode } from '@sitemuster/shared';

import { decryptValue, encryptValue, KEY_BYTES, SessionCipherError } from './session-cipher';

/**
 * Encrypted session store for supabase-js (spec 09 "Session and key management"):
 * values are AES-256-GCM encrypted (session-cipher) and stored in SQLite; the random per-install
 * key lives in the platform secure store (iOS keychain AFTER_FIRST_UNLOCK / Android Keystore).
 * Large session JSON never goes into the secure store and is never logged.
 *
 * Failure behaviour (all fail closed, never crash):
 * - key temporarily unreadable (device locked before first unlock): read returns null, data kept;
 * - key missing while ciphertext exists (restore/reinstall mismatch): ciphertext wiped;
 * - ciphertext tampered/corrupt/wrong slot: that entry is wiped and treated as signed out.
 */
export interface KeyValueTable {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  keys(): Promise<string[]>;
  clear(): Promise<void>;
}

export interface KeyStore {
  /** Resolves null when no key exists; rejects when the secure store is temporarily unavailable. */
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
  delete(): Promise<void>;
}

export class EncryptedSessionStorage {
  constructor(
    private readonly table: KeyValueTable,
    private readonly keyStore: KeyStore,
    private readonly randomBytes: RandomBytes,
  ) {}

  private async currentKey(): Promise<Uint8Array | null> {
    const encoded = await this.keyStore.read();
    if (!encoded) return null;
    const key = base64UrlDecode(encoded);
    if (key.length !== KEY_BYTES) throw new SessionCipherError('stored key has wrong length');
    return key;
  }

  private async newKey(): Promise<Uint8Array> {
    const key = this.randomBytes(KEY_BYTES);
    if (key.length !== KEY_BYTES)
      throw new SessionCipherError('random source returned wrong length');
    await this.keyStore.write(base64UrlEncode(key));
    return key;
  }

  async getItem(name: string): Promise<string | null> {
    let key: Uint8Array | null;
    try {
      key = await this.currentKey();
    } catch (error) {
      if (error instanceof SessionCipherError) {
        await this.wipe();
      }
      // Secure store unavailable (e.g. before first unlock): report "no session" for now and keep
      // the ciphertext so the session is restored once the key is readable again.
      return null;
    }
    const envelope = await this.table.get(name);
    if (envelope === null) return null;
    if (key === null) {
      // Ciphertext without its key can never be decrypted: remove every orphaned value.
      await this.table.clear();
      return null;
    }
    try {
      return decryptValue(key, name, envelope);
    } catch (error) {
      if (!(error instanceof SessionCipherError)) throw error;
      await this.table.remove(name);
      return null;
    }
  }

  async setItem(name: string, value: string): Promise<void> {
    let key = await this.currentKey();
    if (key === null) {
      await this.table.clear();
      key = await this.newKey();
    }
    await this.table.set(name, encryptValue(key, name, value, this.randomBytes));
  }

  async removeItem(name: string): Promise<void> {
    await this.table.remove(name);
  }

  /** Re-encrypts every stored value under a fresh key (key rotation). */
  async rotateKey(): Promise<void> {
    const oldKey = await this.currentKey();
    if (oldKey === null) return;
    const names = await this.table.keys();
    const plain = new Map<string, string>();
    for (const name of names) {
      const envelope = await this.table.get(name);
      if (envelope === null) continue;
      try {
        plain.set(name, decryptValue(oldKey, name, envelope));
      } catch (error) {
        if (!(error instanceof SessionCipherError)) throw error;
        await this.table.remove(name);
      }
    }
    const key = this.randomBytes(KEY_BYTES);
    for (const [name, value] of plain)
      await this.table.set(name, encryptValue(key, name, value, this.randomBytes));
    await this.keyStore.write(base64UrlEncode(key));
  }

  /** Sign-out / compromise reset: removes all ciphertext and the key itself. */
  async wipe(): Promise<void> {
    await this.table.clear();
    await this.keyStore.delete();
  }
}
