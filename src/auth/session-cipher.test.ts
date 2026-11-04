import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { decryptValue, encryptValue, SessionCipherError } from './session-cipher';

const rng = (n: number) => new Uint8Array(randomBytes(n));
const key = rng(32);

describe('AES-256-GCM session envelope', () => {
  it('round-trips values and binds them to the storage slot', () => {
    const envelope = encryptValue(key, 'sitemuster-auth', '{"access_token":"x"}', rng);
    expect(envelope).toMatch(/^smv1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
    expect(decryptValue(key, 'sitemuster-auth', envelope)).toBe('{"access_token":"x"}');
    expect(() => decryptValue(key, 'another-slot', envelope)).toThrow(SessionCipherError);
  });

  it('uses a fresh nonce for every encryption', () => {
    const nonces = new Set(
      Array.from({ length: 200 }, () => encryptValue(key, 'k', 'same value', rng).split('.')[1]),
    );
    expect(nonces.size).toBe(200);
  });

  it('detects tampering and wrong keys', () => {
    const envelope = encryptValue(key, 'k', 'secret session', rng);
    const [prefix, nonce, sealed = ''] = envelope.split('.');
    // Change the second-to-last character (always carries data bits) to a different character.
    const index = sealed.length - 2;
    const replacement = sealed[index] === 'A' ? 'B' : 'A';
    const flipped = `${prefix}.${nonce}.${sealed.slice(0, index)}${replacement}${sealed.slice(index + 1)}`;
    expect(flipped).not.toBe(envelope);
    expect(() => decryptValue(key, 'k', flipped)).toThrow(SessionCipherError);
    expect(() => decryptValue(rng(32), 'k', envelope)).toThrow(SessionCipherError);
  });

  it('rejects malformed envelopes and bad keys', () => {
    expect(() => decryptValue(key, 'k', 'plain text session')).toThrow(SessionCipherError);
    expect(() => decryptValue(key, 'k', 'smv1.@@@.@@@')).toThrow(SessionCipherError);
    expect(() => decryptValue(key, 'k', 'smv2.AAAA.AAAA')).toThrow(SessionCipherError);
    expect(() => encryptValue(rng(16), 'k', 'x', rng)).toThrow(SessionCipherError);
  });

  it('never leaves plaintext in the envelope', () => {
    const envelope = encryptValue(key, 'k', 'refresh_token=abc123', rng);
    expect(envelope).not.toContain('refresh_token');
    expect(envelope).not.toContain('abc123');
  });
});
