import { AUDIENCE_PROFILES_BATCH_LIMIT, AUDIENCE_PROFILES_CUSTOM_KEYS_LIMIT, type AudienceProfiles, type PersonalizationField, type TenantScope } from '@workeasy/audience-core';
import type { Tx } from '@workeasy/db';
import { CUSTOM_FIELD_KEY_PATTERN, type MergeData } from '@workeasy/shared';
import { assertTenantScope } from './tenant-scope.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Audience Profiles v1 adapter. Two queries per call at most (contacts, then primary email identities only when merge
 * data is requested), inside the caller's RLS-scoped transaction: another workspace's contact is invisible, never an
 * error. Only the allowlisted fields leave this adapter.
 */
export class PrismaAudienceProfiles implements AudienceProfiles<Tx> {
  async mergeData(scope: TenantScope<Tx>, contactIds: string[]): Promise<Map<string, MergeData>> {
    const ids = await this.ids(scope, contactIds);
    const out = new Map<string, MergeData>();
    if (!ids.length) return out;
    const contacts = await scope.tx.contact.findMany({
      where: { id: { in: ids }, deletedAt: null, erasedAt: null },
      select: { id: true, firstName: true, lastName: true, company: true },
    });
    if (!contacts.length) return out;
    const emails = await scope.tx.contactIdentity.findMany({
      where: { contactId: { in: contacts.map((c) => c.id) }, kind: 'email' },
      select: { contactId: true, value: true, isPrimary: true, createdAt: true },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    });
    const email = new Map<string, string>();
    for (const e of emails) if (!email.has(e.contactId)) email.set(e.contactId, e.value);
    for (const c of contacts) {
      out.set(c.id, {
        'contact.first_name': blankToNull(c.firstName),
        'contact.last_name': blankToNull(c.lastName),
        'contact.company': blankToNull(c.company),
        'contact.email': email.get(c.id) ?? null,
      });
    }
    return out;
  }

  async displayNames(scope: TenantScope<Tx>, contactIds: string[]): Promise<Map<string, string>> {
    const ids = await this.ids(scope, contactIds);
    const out = new Map<string, string>();
    if (!ids.length) return out;
    const contacts = await scope.tx.contact.findMany({
      where: { id: { in: ids } },
      select: { id: true, firstName: true, lastName: true, company: true, deletedAt: true, erasedAt: true },
    });
    for (const c of contacts) {
      const name = [c.firstName, c.lastName].map((x) => x?.trim()).filter(Boolean).join(' ');
      out.set(c.id, c.erasedAt ? 'Erased contact' : c.deletedAt ? 'Deleted contact' : name || c.company?.trim() || 'Unnamed contact');
    }
    return out;
  }

  async mergeDataV2(scope: TenantScope<Tx>, contactIds: string[], customKeys: string[]): Promise<Map<string, Record<string, string | null>>> {
    const keys = [...new Set(customKeys)].filter((k) => CUSTOM_FIELD_KEY_PATTERN.test(k));
    if (keys.length > AUDIENCE_PROFILES_CUSTOM_KEYS_LIMIT) throw new RangeError(`At most ${AUDIENCE_PROFILES_CUSTOM_KEYS_LIMIT} custom fields per call`);
    const base = await this.mergeData(scope, contactIds);
    const out = new Map<string, Record<string, string | null>>();
    for (const [id, d] of base) out.set(id, { ...d });
    if (!keys.length || !base.size) {
      for (const r of out.values()) for (const k of keys) r[`contact.custom.${k}`] = null;
      return out;
    }
    const [defs, rows] = await Promise.all([
      scope.tx.customFieldDefinition.findMany({ where: { key: { in: keys } }, select: { key: true, type: true, options: true } }),
      scope.tx.contact.findMany({ where: { id: { in: [...base.keys()] } }, select: { id: true, customFields: true } }),
    ]);
    const byKey = new Map(defs.map((d) => [d.key, d]));
    const values = new Map(rows.map((r) => [r.id, (r.customFields ?? {}) as Record<string, unknown>]));
    for (const [id, record] of out) {
      const cf = values.get(id) ?? {};
      for (const k of keys) {
        const def = byKey.get(k);
        record[`contact.custom.${k}`] = def ? formatCustomValue(def.type, def.options as { key: string; label: string }[], cf[k]) : null;
      }
    }
    return out;
  }

  async personalizationFields(scope: TenantScope<Tx>): Promise<PersonalizationField[]> {
    await assertTenantScope(scope);
    const defs = await scope.tx.customFieldDefinition.findMany({ orderBy: [{ position: 'asc' }, { key: 'asc' }], select: { key: true, label: true, type: true, status: true } });
    return defs.map((d) => ({ key: d.key, label: d.label, type: d.type, archived: d.status === 'archived' }));
  }

  private async ids(scope: TenantScope<Tx>, contactIds: string[]): Promise<string[]> {
    await assertTenantScope(scope);
    const ids = [...new Set(contactIds.map((x) => x.toLowerCase()))];
    if (ids.length > AUDIENCE_PROFILES_BATCH_LIMIT) throw new RangeError(`At most ${AUDIENCE_PROFILES_BATCH_LIMIT} contact ids per call`);
    return ids.filter((x) => UUID.test(x));
  }
}

const blankToNull = (v: string | null) => (v && v.trim() ? v : null);

const MAX_VALUE = 1_000;

/**
 * A stored custom-field value as personalization text (C14). Stored values are already normalized by Audience on
 * write (dates `YYYY-MM-DD`, datetimes ISO, selects option keys, multi-selects arrays of keys).
 */
export function formatCustomValue(type: string, options: { key: string; label: string }[], raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const label = (k: unknown) => options.find((o) => o.key === k)?.label ?? String(k);
  let text: string;
  switch (type) {
    case 'boolean':
      text = raw === true ? 'Yes' : raw === false ? 'No' : String(raw);
      break;
    case 'single_select':
      text = label(raw);
      break;
    case 'multi_select':
      text = Array.isArray(raw) ? raw.map(label).join(', ') : label(raw);
      break;
    default:
      text = typeof raw === 'object' ? JSON.stringify(raw) : String(raw);
  }
  const t = text.trim();
  return t ? t.slice(0, MAX_VALUE) : null;
}
