import { createHmac } from 'node:crypto';

/**
 * Keyed hash of a channel address: identifies the subject of consent evidence without storing the address itself.
 * Algorithm frozen with the stored `subject_fingerprint` values: HMAC-SHA256 over `consent-subject␀channel␀value`,
 * base64url, keyed by DATA_FINGERPRINT_SECRET. Changing any byte here orphans every stored fingerprint.
 */
export function consentFingerprint(secret: string, channel: string, valueNormalized: string): string {
  return createHmac('sha256', secret).update(['consent-subject', channel, valueNormalized].join('\u0000')).digest('base64url');
}
