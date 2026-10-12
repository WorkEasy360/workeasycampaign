import { describe, expect, it } from 'vitest';
import { uuidV7 } from './uuid-v7.js';

const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('uuidV7 (bulk, monotonic)', () => {
  it('is a valid RFC 9562 version-7 UUID carrying the millisecond timestamp', () => {
    const at = Date.UTC(2026, 9, 10, 12, 0, 0, 123);
    const id = uuidV7(at);
    expect(id).toMatch(V7);
    expect(parseInt(id.slice(0, 8) + id.slice(9, 13), 16)).toBe(at);
  });

  it('is unique and strictly increasing across 200,000 ids, including many in the same millisecond', () => {
    const ids: string[] = [];
    const t = Date.now() + 10_000; // ahead of anything generated before, so the sequence starts fresh
    for (let i = 0; i < 200_000; i++) ids.push(uuidV7(t + Math.floor(i / 50_000)));
    for (const id of ids.slice(0, 1000)) expect(id).toMatch(V7);
    expect(new Set(ids).size).toBe(ids.length);
    for (let i = 1; i < ids.length; i++) if (!(ids[i - 1]! < ids[i]!)) throw new Error(`not increasing at ${i}: ${ids[i - 1]} ≥ ${ids[i]}`);
  });

  it('never goes backwards when the clock does', () => {
    const t = Date.now() + 20_000;
    const a = uuidV7(t);
    const b = uuidV7(t - 5_000);
    expect(b > a).toBe(true);
  });

  it('accepts the result as a PostgreSQL uuid literal shape (lowercase hex, 36 chars)', () => {
    expect(uuidV7()).toHaveLength(36);
  });
});
