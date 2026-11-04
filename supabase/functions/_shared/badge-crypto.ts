import { sha256 } from '@noble/hashes/sha2.js';

import { base64UrlDecode } from '../../../packages/shared/src/crypto/encoding.ts';

/**
 * Per-device badge secrets are stored AES-256-GCM encrypted (spec 05 `device_badge_secrets`) with
 * BADGE_SECRET_ENCRYPTION_KEY, an Edge Function secret. Ciphertext = 12-byte IV ‖ ciphertext+tag;
 * the device id is bound as additional authenticated data so blobs cannot be swapped between
 * devices. Without a key, ONLY a development backend may use the fixed development key below;
 * any other environment fails closed, and the development key is refused there too.
 */
export const BADGE_KEY_VERSION = 1;
const DEV_KEY_LABEL = 'sitemuster-development-only-badge-secret-key-v1';

export function developmentBadgeKey(): Uint8Array {
  return sha256(new TextEncoder().encode(DEV_KEY_LABEL));
}

/** Accepts base64 or base64url of exactly 32 bytes; anything else is a configuration error. */
export function parseBadgeKey(value: string | undefined | null): Uint8Array | null {
  if (!value) return null;
  try {
    const bytes = base64UrlDecode(
      value.trim().replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
    );
    return bytes.length === 32 ? bytes : null;
  } catch {
    return null;
  }
}

export type BadgeKeyResult =
  { ok: true; key: Uint8Array } | { ok: false; reason: 'MISSING' | 'DEVELOPMENT_KEY_IN_HOSTED' };

export function resolveBadgeKey(
  environment: 'development' | 'staging' | 'production',
  configured: string | undefined | null,
): BadgeKeyResult {
  const key = parseBadgeKey(configured);
  const dev = developmentBadgeKey();
  if (key) {
    const isDev = key.every((byte, i) => byte === dev[i]);
    if (isDev && environment !== 'development')
      return { ok: false, reason: 'DEVELOPMENT_KEY_IN_HOSTED' };
    return { ok: true, key };
  }
  return environment === 'development' ? { ok: true, key: dev } : { ok: false, reason: 'MISSING' };
}

/** WebCrypto wants buffers backed by a plain ArrayBuffer (copy, never share). */
function buf(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes);
}

async function importKey(key: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', buf(key), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function aad(deviceId: string): Uint8Array<ArrayBuffer> {
  return buf(new TextEncoder().encode(`SMBS1|${deviceId}`));
}

export async function encryptBadgeSecret(
  key: Uint8Array,
  secret: Uint8Array,
  deviceId: string,
): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aad(deviceId) },
      await importKey(key),
      buf(secret),
    ),
  );
  const out = new Uint8Array(iv.length + sealed.length);
  out.set(iv, 0);
  out.set(sealed, iv.length);
  return out;
}

export async function decryptBadgeSecret(
  key: Uint8Array,
  blob: Uint8Array,
  deviceId: string,
): Promise<Uint8Array> {
  const iv = buf(blob.slice(0, 12));
  const sealed = buf(blob.slice(12));
  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: aad(deviceId) },
      await importKey(key),
      sealed,
    ),
  );
}

export function toPgHex(bytes: Uint8Array): string {
  return `\\x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}
