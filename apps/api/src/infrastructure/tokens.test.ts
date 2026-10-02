import { describe, expect, it } from 'vitest';
import { hashToken, hmac, newToken, safeEqual } from './tokens.js';

describe('tokens', () => {
  it('generates unique 256-bit URL-safe tokens', () => {
    const a = newToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newToken()).not.toBe(a);
  });

  it('hashes deterministically and never returns the token itself', () => {
    const t = newToken();
    expect(hashToken(t)).toBe(hashToken(t));
    expect(hashToken(t)).not.toContain(t);
  });

  it('binds HMACs to every part', () => {
    expect(hmac('k', 'a', 'b')).not.toBe(hmac('k', 'ab'));
    expect(hmac('k', 'a')).not.toBe(hmac('k2', 'a'));
  });

  it('compares in constant time and handles length mismatch', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});
