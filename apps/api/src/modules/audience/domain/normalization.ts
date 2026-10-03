import { type CountryCode, parsePhoneNumberFromString } from 'libphonenumber-js/max';
import type { IdentityKind } from '@workeasy/shared';

/**
 * Deterministic identity normalization (docs/audience.md §3). The same input always yields the same key, so
 * "Ann@Example.com " and "ann@example.com" can never become two contacts.
 */
export type Normalized = { ok: true; value: string; normalized: string } | { ok: false; code: 'INVALID_EMAIL' | 'INVALID_PHONE' | 'INVALID_EXTERNAL_ID' | 'COUNTRY_REQUIRED'; message: string };

// Pragmatic address check: one @, no spaces, a dotted domain with a 2+ letter TLD. Full RFC 5322 is not useful here.
const EMAIL_RE = /^[^\s@"(),:;<>[\]\\]+@[^\s@"(),:;<>[\]\\]+\.[a-z]{2,63}$/i;

export function normalizeEmail(raw: string): Normalized {
  const value = raw.trim().normalize('NFC');
  const normalized = value.toLowerCase();
  if (normalized.length > 254 || !EMAIL_RE.test(normalized) || normalized.includes('..')) {
    return { ok: false, code: 'INVALID_EMAIL', message: 'Enter a valid email address' };
  }
  return { ok: true, value, normalized };
}

/** E.164 (+<country><number>). A national number needs a default country; we never guess one. */
export function normalizePhone(raw: string, defaultCountry?: string): Normalized {
  const value = raw.trim();
  const international = value.startsWith('+') || value.startsWith('00');
  if (!international && !defaultCountry) {
    return { ok: false, code: 'COUNTRY_REQUIRED', message: 'Include the country code (e.g. +91…) or choose a default country' };
  }
  const input = value.startsWith('00') ? `+${value.slice(2)}` : value;
  const parsed = parsePhoneNumberFromString(input, international ? undefined : (defaultCountry as CountryCode));
  if (!parsed || !parsed.isValid()) return { ok: false, code: 'INVALID_PHONE', message: 'Enter a valid phone number' };
  return { ok: true, value, normalized: parsed.number };
}

export function normalizeIdentity(kind: IdentityKind, raw: string, defaultCountry?: string): Normalized {
  switch (kind) {
    case 'email':
      return normalizeEmail(raw);
    case 'phone':
    case 'whatsapp':
      return normalizePhone(raw, defaultCountry);
    case 'external': {
      const value = raw.trim();
      if (!value || value.length > 200 || /[\u0000-\u001f]/.test(value)) {
        return { ok: false, code: 'INVALID_EXTERNAL_ID', message: 'Enter a valid external id' };
      }
      return { ok: true, value, normalized: value };
    }
  }
}

/** Lower-case text used by the trigram search index: names, company and every identity value. */
export function buildSearchText(
  contact: { firstName?: string | null; lastName?: string | null; company?: string | null },
  identities: { valueNormalized: string }[],
): string {
  return [contact.firstName, contact.lastName, contact.company, ...identities.map((i) => i.valueNormalized)]
    .filter((s): s is string => !!s && s.trim().length > 0)
    .join(' ')
    .toLowerCase()
    .slice(0, 2000);
}

export function displayName(c: { firstName: string | null; lastName: string | null }, email: string | null, phone: string | null): string {
  const n = [c.firstName, c.lastName].filter(Boolean).join(' ').trim();
  return n || email || phone || 'Unnamed contact';
}

/** Removes control characters (except tab/newline) from untrusted text such as CSV cells. */
export function cleanText(s: string): string {
  return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
}
