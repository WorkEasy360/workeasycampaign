/**
 * Deterministic duplicate handling for imports (docs/imports.md §Duplicates). Given what the row's identities
 * resolve to, decide exactly one outcome. Never merges.
 */
export type ImportMode = 'create_or_update' | 'create_only' | 'update_only';

export type RowDecision =
  | { action: 'create' }
  | { action: 'update'; contactId: string }
  | { action: 'skip'; code: 'EXISTS' | 'NOT_FOUND' | 'DUPLICATE_IN_FILE'; message: string }
  | { action: 'error'; code: 'IDENTITY_CONFLICT' | 'CONTACT_DELETED' | 'NO_IDENTITY'; message: string };

export interface IdentityMatch {
  kind: 'email' | 'phone' | 'whatsapp';
  /** Owning contact, or null when the address is new. */
  contactId: string | null;
  contactDeleted: boolean;
}

/**
 * @param matches  one entry per identity present in the row (already validated & normalized)
 * @param seenInFile whether an earlier row of the same file already used one of these addresses
 */
export function decideRow(mode: ImportMode, matches: IdentityMatch[], seenInFile: boolean): RowDecision {
  if (matches.length === 0) return { action: 'error', code: 'NO_IDENTITY', message: 'Row has no valid email or phone' };
  if (seenInFile) {
    return { action: 'skip', code: 'DUPLICATE_IN_FILE', message: 'An earlier row in this file has the same email or phone' };
  }
  const owners = [...new Set(matches.map((m) => m.contactId).filter((c): c is string => c !== null))];
  if (owners.length > 1) {
    return {
      action: 'error',
      code: 'IDENTITY_CONFLICT',
      message: 'The email and phone belong to different existing contacts. They were not merged; fix the row or the contacts.',
    };
  }
  if (matches.some((m) => m.contactId && m.contactDeleted)) {
    return { action: 'error', code: 'CONTACT_DELETED', message: 'Matches a deleted contact. Restore it first, or remove the row.' };
  }
  const existing = owners[0];
  if (existing) {
    return mode === 'create_only'
      ? { action: 'skip', code: 'EXISTS', message: 'Contact already exists (create-only import)' }
      : { action: 'update', contactId: existing };
  }
  return mode === 'update_only'
    ? { action: 'skip', code: 'NOT_FOUND', message: 'No existing contact (update-only import)' }
    : { action: 'create' };
}

const COMMON_HEADERS: Record<string, string> = {
  email: 'email', 'e-mail': 'email', 'email address': 'email', mail: 'email',
  phone: 'phone', mobile: 'phone', 'phone number': 'phone', 'mobile number': 'phone', telephone: 'phone',
  whatsapp: 'whatsapp', 'whatsapp number': 'whatsapp',
  'first name': 'first_name', firstname: 'first_name', first_name: 'first_name', 'given name': 'first_name',
  'last name': 'last_name', lastname: 'last_name', last_name: 'last_name', surname: 'last_name', 'family name': 'last_name',
  company: 'company', organization: 'company', organisation: 'company',
  timezone: 'timezone', 'time zone': 'timezone', locale: 'locale', language: 'locale',
};

/** Suggests a mapping from header names; custom fields match on key or label. The user always confirms. */
export function suggestMapping(headers: string[], fields: { key: string; label: string; status: string }[]): Record<string, string> {
  const used = new Set<string>();
  const out: Record<string, string> = {};
  headers.forEach((h, i) => {
    const norm = h.trim().toLowerCase().replace(/\s+/g, ' ');
    let target = COMMON_HEADERS[norm] ?? null;
    if (!target) {
      const f = fields.find((x) => x.status === 'active' && (x.key === norm.replace(/ /g, '_') || x.label.toLowerCase() === norm));
      if (f) target = `cf:${f.key}`;
    }
    if (target && !used.has(target)) {
      used.add(target);
      out[String(i)] = target;
    } else {
      out[String(i)] = 'ignore';
    }
  });
  return out;
}

/** Neutralizes spreadsheet formulas when echoing untrusted values into a CSV (OWASP CSV injection). */
export function csvSafe(value: unknown): string {
  let s = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}
