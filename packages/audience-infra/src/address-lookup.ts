import type { AddressLookup, TenantScope } from '@workeasy/audience-core';
import type { Tx } from '@workeasy/db';
import { assertTenantScope } from './tenant-scope.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Address Lookup v1 adapter (port E-4; Phase 7.7 delivery). The send-to value of identity ids returned by Eligibility,
 * inside the caller's RLS-scoped transaction: another workspace's identity is invisible, and identities of deleted or
 * erased contacts are absent. One query; the result is used immediately for the hand-off and never stored.
 */
export class PrismaAddressLookup implements AddressLookup<Tx> {
  async lookup(scope: TenantScope<Tx>, identityIds: string[]) {
    await assertTenantScope(scope);
    const ids = [...new Set(identityIds.map((x) => x.toLowerCase()))].filter((x) => UUID.test(x));
    if (!ids.length) return [];
    if (ids.length > 1_000) throw new RangeError('At most 1000 identity ids per call');
    const rows = await scope.tx.contactIdentity.findMany({
      where: { id: { in: ids }, contact: { deletedAt: null, erasedAt: null } },
      select: { id: true, kind: true, value: true, valueNormalized: true },
    });
    // Email: the address as entered (its local part may be case-sensitive). Phone / WhatsApp: the normalized E.164 number
    // (what providers require; the entered form may lack the country code).
    return rows.map((r) => ({ identityId: r.id, kind: r.kind as 'email' | 'phone' | 'whatsapp', value: r.kind === 'email' ? r.value : r.valueNormalized }));
  }
}
