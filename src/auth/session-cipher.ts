import { gcm } from '@noble/ciphers/aes.js';

import { base64UrlDecode, base64UrlEncode, type RandomBytes } from '@sitemuster/shared';

/**
 * AES-256-GCM envelope for the encrypted session store (decision #13, spec 09).
 * Format: `smv1.<base64url nonce (12 bytes)>.<base64url ciphertext||tag>`; the storage key is
 * bound as additional authenticated data so a ciphertext cannot be moved to another key.
 * A fresh random 96-bit nonce is used for every encryption.
 */
export const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const PREFIX = 'smv1';

export class SessionCipherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionCipherError';
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encryptValue(
  key: Uint8Array,
  aad: string,
  plaintext: string,
  randomBytes: RandomBytes,
): string {
  if (key.length !== KEY_BYTES) throw new SessionCipherError('key must be 32 bytes');
  const nonce = randomBytes(NONCE_BYTES);
  if (nonce.length !== NONCE_BYTES)
    throw new SessionCipherError('nonce source returned wrong length');
  const sealed = gcm(key, nonce, encoder.encode(aad)).encrypt(encoder.encode(plaintext));
  return `${PREFIX}.${base64UrlEncode(nonce)}.${base64UrlEncode(sealed)}`;
}

export function decryptValue(key: Uint8Array, aad: string, envelope: string): string {
  if (key.length !== KEY_BYTES) throw new SessionCipherError('key must be 32 bytes');
  const parts = envelope.split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX)
    throw new SessionCipherError('unknown envelope format');
  let nonce: Uint8Array;
  let sealed: Uint8Array;
  try {
    nonce = base64UrlDecode(parts[1] ?? '');
    sealed = base64UrlDecode(parts[2] ?? '');
  } catch {
    throw new SessionCipherError('envelope is not base64url');
  }
  if (nonce.length !== NONCE_BYTES || sealed.length < 16)
    throw new SessionCipherError('envelope too short');
  try {
    return decoder.decode(gcm(key, nonce, encoder.encode(aad)).decrypt(sealed));
  } catch {
    throw new SessionCipherError('authentication failed (tampered, wrong key or wrong slot)');
  }
}
