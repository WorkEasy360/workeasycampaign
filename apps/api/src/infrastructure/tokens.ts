import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** 256-bit random bearer token (sessions, email links, invitations). URL-safe. */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Tokens are stored only as SHA-256 hashes: high-entropy secrets need no salt/KDF, and a DB leak reveals nothing usable. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function hmac(secret: string, ...parts: string[]): string {
  return createHmac('sha256', secret).update(parts.join('\u0000')).digest('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
