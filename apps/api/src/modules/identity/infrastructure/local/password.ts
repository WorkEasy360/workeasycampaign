import argon2 from 'argon2';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@workeasy/shared';

/**
 * Argon2id (RFC 9106) via the `argon2` library — no custom crypto. Parameters exceed the OWASP Password Storage
 * Cheat Sheet minimum (m=19 MiB, t=2, p=1). `needsRehash` upgrades stored hashes transparently at login when
 * these parameters change.
 */
const OPTIONS = { type: argon2.argon2id, memoryCost: 47_104, timeCost: 2, parallelism: 1 } as const;

export const hashPassword = (password: string) => argon2.hash(password, OPTIONS);
export const verifyPassword = (hash: string, password: string) => argon2.verify(hash, password).catch(() => false);
export const needsRehash = (hash: string) => argon2.needsRehash(hash, OPTIONS);

/** A valid hash of a random string: verifying against it costs the same as a real account (anti-enumeration). */
let dummyHash: Promise<string> | null = null;
export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= argon2.hash(`dummy-${Math.random()}-${Date.now()}`, OPTIONS);
  return dummyHash;
}

/**
 * Most common passwords that satisfy the length rule. Kept small and offline on purpose; a k-anonymity breach
 * check (Have I Been Pwned range API) is a planned addition (docs/security.md §Known gaps).
 */
const COMMON = new Set([
  '1234567890', '12345678910', '123456789a', 'a123456789', '0987654321', '1111111111', '0000000000',
  '1q2w3e4r5t', '1qaz2wsx3edc', 'qwertyuiop', 'qwerty1234', 'qwerty12345', 'qwerty123456', 'asdfghjkl1',
  'password12', 'password123', 'password1234', 'password!1', 'passw0rd123', 'p@ssw0rd123', 'iloveyou12',
  'abcdefghij', 'abc1234567', 'abcd123456', 'zaq12wsxcde', 'letmein123', 'welcome123', 'welcome1234',
  'admin12345', 'administrator', 'changeme123', 'football123', 'baseball123', 'princess123', 'sunshine123',
  'monkey12345', 'dragon12345', 'trustno1234', 'superman123', 'starwars123', 'whatever123', 'qazwsxedc123',
]);

export function passwordProblems(password: string, email: string): string[] {
  const problems: string[] = [];
  if (password.length < PASSWORD_MIN_LENGTH) problems.push(`Use at least ${PASSWORD_MIN_LENGTH} characters`);
  if (password.length > PASSWORD_MAX_LENGTH) problems.push(`Use at most ${PASSWORD_MAX_LENGTH} characters`);
  const lower = password.toLowerCase();
  const local = email.toLowerCase().split('@')[0] ?? '';
  if (COMMON.has(lower)) problems.push('This password is too common');
  else if (/^(.)\1+$/.test(password)) problems.push('Avoid repeating a single character');
  if (local.length >= 4 && lower.includes(local)) problems.push('Do not include your email address');
  if (/workeasy|campaign/.test(lower) && password.length < 16) problems.push('Avoid the product name');
  return problems;
}
