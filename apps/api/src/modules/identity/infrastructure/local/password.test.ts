import { describe, expect, it } from 'vitest';
import { hashPassword, needsRehash, passwordProblems, verifyPassword } from './password.js';

describe('password hashing', () => {
  it('produces argon2id hashes that verify only the right password', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(hash, 'correct horse battery')).toBe(true);
    expect(await verifyPassword(hash, 'wrong horse battery')).toBe(false);
    expect(needsRehash(hash)).toBe(false);
  });

  it('treats a corrupt hash as a failed verification rather than an error', async () => {
    expect(await verifyPassword('not-a-hash', 'x')).toBe(false);
  });
});

describe('password policy', () => {
  it('accepts a reasonable passphrase', () => {
    expect(passwordProblems('maple-river-lantern', 'sam@example.com')).toEqual([]);
  });
  it('rejects short, common, repeated and email-derived passwords', () => {
    expect(passwordProblems('short', 'a@b.co')).toContain('Use at least 10 characters');
    expect(passwordProblems('Password123', 'a@b.co')).toContain('This password is too common');
    expect(passwordProblems('aaaaaaaaaaaa', 'a@b.co')).toContain('Avoid repeating a single character');
    expect(passwordProblems('samantha-2026!', 'samantha@example.com')).toContain('Do not include your email address');
  });
});
