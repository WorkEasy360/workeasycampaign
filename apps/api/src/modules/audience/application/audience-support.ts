import type { Prisma, Tx } from '@workeasy/db';
import type { Channel, ContactFilter, SuppressionView } from '@workeasy/shared';
import { Errors } from '../../../common/errors.js';
import { definitionProblems, type FieldDefinition, isEmptyValue, validateFieldValue } from '../domain/custom-fields.js';
import { buildSearchText } from '../domain/normalization.js';

/** Loads a live (not deleted, not erased) contact or answers 404 — ids from other workspaces are invisible (RLS). */
export async function requireLiveContact(tx: Tx, contactId: string, opts: { allowDeleted?: boolean } = {}) {
  const c = await tx.contact.findUnique({ where: { id: contactId } });
  if (!c || c.erasedAt || (c.deletedAt && !opts.allowDeleted)) throw Errors.notFound('Contact');
  return c;
}

export async function refreshSearchText(tx: Tx, contactId: string): Promise<void> {
  const c = await tx.contact.findUniqueOrThrow({ where: { id: contactId }, select: { firstName: true, lastName: true, company: true } });
  const ids = await tx.contactIdentity.findMany({ where: { contactId }, select: { valueNormalized: true } });
  await tx.contact.update({ where: { id: contactId }, data: { searchText: buildSearchText(c, ids) } });
}

export async function loadFieldDefinitions(tx: Tx): Promise<Map<string, FieldDefinition & { id: string; keyLocked: boolean }>> {
  const defs = await tx.customFieldDefinition.findMany();
  return new Map(
    defs.map((d) => [
      d.key,
      {
        id: d.id,
        key: d.key,
        label: d.label,
        type: d.type as FieldDefinition['type'],
        required: d.required,
        status: d.status,
        options: d.options as FieldDefinition['options'],
        validation: d.validation as FieldDefinition['validation'],
        keyLocked: d.keyLocked,
      },
    ]),
  );
}

/**
 * Applies a partial custom-field patch to existing values. Unknown keys and archived fields are rejected; a null or
 * empty value removes the key (unless the field is required). With `checkRequired`, every active required field must
 * end up with a value. Returns the new value object and the keys that now hold data (to lock their definitions).
 */
export function applyCustomFields(
  defs: Map<string, FieldDefinition>,
  existing: Record<string, unknown>,
  patch: Record<string, unknown>,
  opts: { checkRequired: boolean; defaultCountry?: string },
): { values: Record<string, unknown>; errors: Record<string, string[]>; usedKeys: string[] } {
  const values = { ...existing };
  const errors: Record<string, string[]> = {};
  const usedKeys: string[] = [];
  for (const [key, raw] of Object.entries(patch)) {
    const def = defs.get(key);
    const at = `customFields.${key}`;
    if (!def) {
      errors[at] = ['Unknown custom field'];
      continue;
    }
    if (def.status === 'archived') {
      errors[at] = [`${def.label} is archived and cannot be changed`];
      continue;
    }
    if (isEmptyValue(raw)) {
      delete values[key];
      continue;
    }
    const r = validateFieldValue(def, raw, { defaultCountry: opts.defaultCountry });
    if (!r.ok) errors[at] = [r.message];
    else {
      values[key] = r.value;
      usedKeys.push(key);
    }
  }
  if (opts.checkRequired) {
    for (const def of defs.values()) {
      if (def.status === 'active' && def.required && isEmptyValue(values[def.key])) {
        errors[`customFields.${def.key}`] ??= [`${def.label} is required`];
      }
    }
  }
  return { values, errors, usedKeys };
}

/** Marks definitions whose key is now in use as locked (key and type become immutable). */
export async function lockFieldKeys(tx: Tx, defs: Map<string, { id: string; keyLocked: boolean }>, keys: string[]): Promise<void> {
  const ids = [...new Set(keys)].map((k) => defs.get(k)).filter((d) => d && !d.keyLocked).map((d) => d!.id);
  if (ids.length) await tx.customFieldDefinition.updateMany({ where: { id: { in: ids } }, data: { keyLocked: true } });
}

export { definitionProblems };

/** Active suppressions affecting each contact: by contact, or by any of its addresses. */
export async function activeSuppressionsFor(tx: Tx, contactIds: string[]): Promise<Map<string, { id: string; channel: string; reason: string }[]>> {
  const out = new Map<string, { id: string; channel: string; reason: string }[]>(contactIds.map((id) => [id, []]));
  if (!contactIds.length) return out;
  const identities = await tx.contactIdentity.findMany({
    where: { contactId: { in: contactIds }, kind: { in: ['email', 'phone', 'whatsapp'] } },
    select: { contactId: true, kind: true, valueNormalized: true },
  });
  const rows = await tx.suppression.findMany({
    where: {
      liftedAt: null,
      OR: [
        { contactId: { in: contactIds } },
        ...(identities.length ? [{ OR: identities.map((i) => ({ identityKind: i.kind, valueNormalized: i.valueNormalized })) }] : []),
      ],
    },
    select: { id: true, channel: true, reason: true, contactId: true, identityKind: true, valueNormalized: true },
  });
  for (const s of rows) {
    if (s.contactId) out.get(s.contactId)?.push(s);
    else {
      for (const i of identities) {
        if (i.kind === s.identityKind && i.valueNormalized === s.valueNormalized) out.get(i.contactId)?.push(s);
      }
    }
  }
  return out;
}

/** Translates contact filters into a Prisma where clause (search candidates are resolved separately). */
export function contactWhere(f: ContactFilter, searchIds: string[] | null, suppressedIds: string[] | null): Prisma.ContactWhereInput {
  return {
    erasedAt: null,
    deletedAt: f.deleted === 'only' ? { not: null } : null,
    ...(searchIds ? { id: { in: searchIds } } : {}),
    ...(f.subscriptionType ? { subscriptionType: f.subscriptionType } : {}),
    ...(f.listId ? { listMemberships: { some: { listId: f.listId } } } : {}),
    ...(f.tagId ? { tags: { some: { tagId: f.tagId } } } : {}),
    ...(f.topicId ? { topicPreferences: { some: { topicId: f.topicId, status: 'subscribed' } } } : {}),
    ...(f.consentChannel && f.consentState
      ? f.consentState === 'none'
        ? { consentStates: { none: { channel: f.consentChannel } } }
        : { consentStates: { some: { channel: f.consentChannel, state: f.consentState } } }
      : {}),
    ...(suppressedIds
      ? f.suppressed === 'true'
        ? { AND: [{ id: { in: suppressedIds } }] }
        : { AND: [{ id: { notIn: suppressedIds } }] }
      : {}),
  };
}

/** Contact ids (in this workspace) currently suppressed by contact or by one of their addresses. */
export async function suppressedContactIds(tx: Tx): Promise<string[]> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT s.contact_id AS id FROM suppressions s WHERE s.lifted_at IS NULL AND s.contact_id IS NOT NULL
    UNION
    SELECT i.contact_id FROM suppressions s
    JOIN contact_identities i ON i.kind = s.identity_kind AND i.value_normalized = s.value_normalized AND i.provider = ''
    WHERE s.lifted_at IS NULL AND s.value_normalized IS NOT NULL`;
  return rows.map((r) => r.id);
}

export const SEARCH_CAP = 1000;

export async function searchContactIds(tx: Tx, q: string): Promise<string[]> {
  const rows = await tx.$queryRaw<{ contact_id: string }[]>`SELECT contact_id FROM app.search_contact_ids(${q}, ${SEARCH_CAP})`;
  return rows.map((r) => r.contact_id);
}

export function suppressionView(
  s: {
    id: string;
    channel: string;
    contactId: string | null;
    identityKind: string | null;
    valueNormalized: string | null;
    reason: string;
    source: string;
    note: string;
    createdAt: Date;
    createdByUserId: string | null;
    liftedAt: Date | null;
    liftReason: string | null;
  },
  contactName: string | null = null,
): SuppressionView {
  return {
    id: s.id,
    channel: s.channel as SuppressionView['channel'],
    target: s.contactId
      ? { type: 'contact', contactId: s.contactId, displayName: contactName }
      : { type: 'address', kind: s.identityKind!, value: s.valueNormalized! },
    reason: s.reason as SuppressionView['reason'],
    source: s.source,
    note: s.note,
    createdAt: s.createdAt.toISOString(),
    createdBy: s.createdByUserId,
    liftedAt: s.liftedAt?.toISOString() ?? null,
    liftReason: s.liftReason,
  };
}

export const CHANNEL_IDENTITY_KIND: Record<Channel, 'email' | 'phone' | 'whatsapp'> = { email: 'email', sms: 'phone', whatsapp: 'whatsapp' };

export function throwIfErrors(errors: Record<string, string[]>): void {
  if (Object.keys(errors).length) throw Errors.validation(errors);
}
