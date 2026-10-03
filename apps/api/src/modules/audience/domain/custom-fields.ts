import type { CustomFieldType } from '@workeasy/shared';
import { cleanText, normalizeEmail, normalizePhone } from './normalization.js';

/** Built-in contact attributes and identity kinds — never usable as custom-field keys. */
export const RESERVED_FIELD_KEYS = new Set([
  'id', 'email', 'phone', 'whatsapp', 'first_name', 'last_name', 'name', 'company', 'timezone', 'locale',
  'subscription_type', 'status', 'source', 'created_at', 'updated_at', 'deleted_at', 'tags', 'lists', 'topics',
]);
export const MAX_FIELDS_PER_WORKSPACE = 200;

export interface FieldDefinition {
  key: string;
  label: string;
  type: CustomFieldType;
  required: boolean;
  status: string;
  options: { key: string; label: string; archived: boolean }[];
  validation: { maxLength?: number; min?: number; max?: number };
}

export type FieldResult = { ok: true; value: unknown } | { ok: false; message: string };

const DEFAULT_MAX = { text: 255, long_text: 10_000 } as const;
const BOOL_TRUE = new Set(['true', 'yes', 'y', '1']);
const BOOL_FALSE = new Set(['false', 'no', 'n', '0']);

/**
 * Validates and normalizes one value. `raw` comes from JSON (API) or a CSV cell (import, always a string);
 * both paths share this code so an import can never store something the API would reject.
 * `null` / empty string means "no value" and is handled by the caller (required check, clearing).
 */
export function validateFieldValue(def: FieldDefinition, raw: unknown, opts: { defaultCountry?: string } = {}): FieldResult {
  const fail = (message: string): FieldResult => ({ ok: false, message: `${def.label}: ${message}` });
  const str = typeof raw === 'string' ? cleanText(raw) : raw;

  switch (def.type) {
    case 'text':
    case 'long_text': {
      if (typeof str !== 'string') return fail('must be text');
      const max = def.validation.maxLength ?? DEFAULT_MAX[def.type];
      return str.length > max ? fail(`use at most ${max} characters`) : { ok: true, value: str };
    }
    case 'number':
    case 'decimal': {
      const n = typeof str === 'number' ? str : typeof str === 'string' && str !== '' ? Number(str.replace(/,/g, '')) : NaN;
      if (!Number.isFinite(n)) return fail('must be a number');
      if (def.type === 'number' && !Number.isSafeInteger(n)) return fail('must be a whole number');
      if (def.type === 'decimal' && Math.round(n * 1e6) / 1e6 !== n) return fail('use at most 6 decimal places');
      if (def.validation.min !== undefined && n < def.validation.min) return fail(`must be at least ${def.validation.min}`);
      if (def.validation.max !== undefined && n > def.validation.max) return fail(`must be at most ${def.validation.max}`);
      return { ok: true, value: n };
    }
    case 'boolean': {
      if (typeof str === 'boolean') return { ok: true, value: str };
      const s = typeof str === 'string' ? str.toLowerCase() : '';
      if (BOOL_TRUE.has(s)) return { ok: true, value: true };
      if (BOOL_FALSE.has(s)) return { ok: true, value: false };
      return fail('must be yes or no');
    }
    case 'date': {
      if (typeof str !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return fail('use the format YYYY-MM-DD');
      const d = new Date(`${str}T00:00:00Z`);
      return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== str ? fail('is not a real date') : { ok: true, value: str };
    }
    case 'datetime': {
      if (typeof str !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(str)) {
        return fail('use an ISO date-time with a time zone, e.g. 2026-01-31T09:30:00Z');
      }
      const d = new Date(str);
      return Number.isNaN(d.getTime()) ? fail('is not a real date-time') : { ok: true, value: d.toISOString() };
    }
    case 'email': {
      if (typeof str !== 'string') return fail('must be an email address');
      const r = normalizeEmail(str);
      return r.ok ? { ok: true, value: r.normalized } : fail(r.message);
    }
    case 'phone': {
      if (typeof str !== 'string') return fail('must be a phone number');
      const r = normalizePhone(str, opts.defaultCountry);
      return r.ok ? { ok: true, value: r.normalized } : fail(r.message);
    }
    case 'url': {
      if (typeof str !== 'string' || str.length > 2000) return fail('must be a web address');
      try {
        const u = new URL(str);
        return u.protocol === 'http:' || u.protocol === 'https:' ? { ok: true, value: u.toString() } : fail('must start with http:// or https://');
      } catch {
        return fail('must be a web address');
      }
    }
    case 'single_select': {
      const key = typeof str === 'string' ? matchOption(def, str) : null;
      return key ? { ok: true, value: key } : fail(`choose one of: ${activeLabels(def)}`);
    }
    case 'multi_select': {
      const items = Array.isArray(raw) ? raw : typeof str === 'string' ? str.split(/[;|]/) : null;
      if (!items) return fail('must be a list of options');
      const keys: string[] = [];
      for (const item of items) {
        if (typeof item !== 'string' || item.trim() === '') continue;
        const key = matchOption(def, cleanText(item));
        if (!key) return fail(`"${item}" is not one of: ${activeLabels(def)}`);
        if (!keys.includes(key)) keys.push(key);
      }
      return { ok: true, value: keys };
    }
  }
}

/** Accepts an option key or (case-insensitively) its label — imports usually carry labels. */
function matchOption(def: FieldDefinition, s: string): string | null {
  const lower = s.toLowerCase();
  const opt = def.options.find((o) => !o.archived && (o.key === s || o.label.toLowerCase() === lower));
  return opt?.key ?? null;
}

const activeLabels = (def: FieldDefinition) =>
  def.options
    .filter((o) => !o.archived)
    .map((o) => o.label)
    .join(', ');

export const isEmptyValue = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);

/** Rules for definitions themselves (on create/update). */
export function definitionProblems(def: Pick<FieldDefinition, 'key' | 'type' | 'options' | 'required' | 'status'>): string[] {
  const problems: string[] = [];
  if (RESERVED_FIELD_KEYS.has(def.key)) problems.push(`"${def.key}" is reserved`);
  const isSelect = def.type === 'single_select' || def.type === 'multi_select';
  if (isSelect && def.options.filter((o) => !o.archived).length === 0) problems.push('Add at least one option');
  if (!isSelect && def.options.length > 0) problems.push('Only select fields have options');
  const keys = def.options.map((o) => o.key);
  if (new Set(keys).size !== keys.length) problems.push('Option keys must be unique');
  if (def.required && def.status === 'archived') problems.push('An archived field cannot be required');
  return problems;
}
