import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Unsubscribe link tokens (Phase 7.8; campaign amendment §U). `u1.<ids>.<mac>`, about 90 characters:
 *  - ids = base64url of the 48 bytes of three uuids — organization, workspace and campaign recipient (ids only);
 *  - mac = HMAC-SHA256(UNSUBSCRIBE_SECRET, "unsubscribe-v1" ‖ ids), truncated to 128 bits (base64url). Verification
 *    accepts the current key and any previous one (rotation never breaks links in delivered emails).
 * Compact on purpose: it must fit a URL path segment (the HTTP server limits parameters to 100 characters; a JSON payload
 * did not — MEASURED 414). Not expiring (an unsubscribe link must keep working long after the email was sent). Not
 * secret per se (it is in the email) but unforgeable: it is the ONLY authority of the public unsubscribe endpoints.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PURPOSE = 'unsubscribe-v1';

export interface UnsubscribeClaims {
  orgId: string;
  workspaceId: string;
  recipientId: string;
}

const toBytes = (uuid: string) => Buffer.from(uuid.replace(/-/g, ''), 'hex');
const fromBytes = (b: Buffer) => {
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};
const mac = (secret: string, ids: string) => createHmac('sha256', secret).update(`${PURPOSE}\u0000${ids}`).digest().subarray(0, 16);

export function issueUnsubscribeToken(secret: string, c: UnsubscribeClaims): string {
  for (const id of [c.orgId, c.workspaceId, c.recipientId]) if (!UUID.test(id)) throw new TypeError('unsubscribe token: ids must be uuids');
  const ids = Buffer.concat([toBytes(c.orgId), toBytes(c.workspaceId), toBytes(c.recipientId)]).toString('base64url');
  return `u1.${ids}.${mac(secret, ids).toString('base64url')}`;
}

/** The claims of a valid token, or null (malformed, unsigned, tampered). Constant-time MAC check. */
export function verifyUnsubscribeToken(keys: string | readonly string[], token: string): UnsubscribeClaims | null {
  if (token.length > 120) return null;
  const [v, ids, given, extra] = token.split('.');
  if (v !== 'u1' || !ids || !given || extra !== undefined || !/^[A-Za-z0-9_-]{64}$/.test(ids) || !/^[A-Za-z0-9_-]{22}$/.test(given)) return null;
  const a = Buffer.from(given, 'base64url');
  // Every key is checked (no early exit), each in constant time.
  let ok = false;
  for (const key of typeof keys === 'string' ? [keys] : keys) {
    const b = mac(key, ids);
    if (a.length === b.length && timingSafeEqual(a, b)) ok = true;
  }
  if (!ok) return null;
  const raw = Buffer.from(ids, 'base64url');
  if (raw.length !== 48) return null;
  return { orgId: fromBytes(raw.subarray(0, 16)), workspaceId: fromBytes(raw.subarray(16, 32)), recipientId: fromBytes(raw.subarray(32, 48)) };
}

/** Links for one recipient: the page in the email body, and the RFC 8058 one-click endpoint for List-Unsubscribe. */
export function unsubscribeLinks(appUrl: string, token: string): { page: string; oneClick: string } {
  const base = appUrl.replace(/\/+$/, '');
  return { page: `${base}/unsubscribe/${token}`, oneClick: `${base}/api/v1/unsubscribe/${token}` };
}

/** RFC 2369 / RFC 8058 headers for a marketing email. */
export function listUnsubscribeHeaders(links: { oneClick: string }): Record<string, string> {
  return { 'List-Unsubscribe': `<${links.oneClick}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };
}
