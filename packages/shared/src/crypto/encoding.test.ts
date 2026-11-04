import { describe, expect, it } from 'vitest';

import { base64UrlDecode, base64UrlEncode, sha256Hex, timingSafeEqual } from './encoding.ts';

const enc = (s: string) => new TextEncoder().encode(s);

describe('base64url (RFC 4648 §10 vectors, url-safe, unpadded)', () => {
  it.each([
    ['', ''],
    ['f', 'Zg'],
    ['fo', 'Zm8'],
    ['foo', 'Zm9v'],
    ['foob', 'Zm9vYg'],
    ['fooba', 'Zm9vYmE'],
    ['foobar', 'Zm9vYmFy'],
  ])('encodes %j as %j', (input, expected) => {
    expect(base64UrlEncode(enc(input))).toBe(expected);
    expect(new TextDecoder().decode(base64UrlDecode(expected))).toBe(input);
  });

  it('uses - and _ instead of + and /', () => {
    expect(base64UrlEncode(Uint8Array.from([0xfb, 0xff, 0xbf]))).toBe('-_-_');
  });

  it('round-trips 32 random-looking bytes to a 43-char token', () => {
    const bytes = Uint8Array.from({ length: 32 }, (_, i) => (i * 37 + 11) % 256);
    const token = base64UrlEncode(bytes);
    expect(token).toHaveLength(43);
    expect(base64UrlDecode(token)).toEqual(bytes);
  });

  it('rejects malformed input', () => {
    expect(() => base64UrlDecode('ab+c')).toThrow();
    expect(() => base64UrlDecode('a')).toThrow();
  });
});

describe('sha256Hex', () => {
  it('matches the FIPS 180-2 "abc" vector', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('timingSafeEqual', () => {
  it('compares equal-length strings without early exit semantics', () => {
    expect(timingSafeEqual('abcdef', 'abcdef')).toBe(true);
    expect(timingSafeEqual('abcdef', 'abcdeg')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
  });
});
