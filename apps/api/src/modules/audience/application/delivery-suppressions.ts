import { Inject, Injectable } from '@nestjs/common';
import type { DeliverySuppressions } from '@workeasy/audience-core';
import type { Database } from '@workeasy/db';
import { DATABASE } from '../../../infrastructure/providers.js';
import { inTenantAsSystem } from '../../tenancy/application/tenant-tx.js';
import { addSuppression } from './suppression-eligibility.service.js';

/**
 * Audience's implementation of the DeliverySuppressions port (Phase 7.9): a hard bounce or complaint reported by the
 * email provider suppresses the ADDRESS (kind + normalized value) for email, through Audience's own suppression rules
 * (one active suppression per target and channel, events). Source `system`; no user.
 */
@Injectable()
export class AudienceDeliverySuppressions implements DeliverySuppressions {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async suppressAddress(tenant: { orgId: string; workspaceId: string }, input: Parameters<DeliverySuppressions['suppressAddress']>[1]) {
    return inTenantAsSystem(this.db, tenant, { source: 'delivery_feedback', correlationId: input.correlationId }, async (uow) => {
      const identity = await uow.tx.contactIdentity.findUnique({ where: { id: input.addressIdentityId }, select: { kind: true, valueNormalized: true } });
      if (!identity) return { created: false, addressGone: true };
      const r = await addSuppression(uow, tenant.orgId, tenant.workspaceId, {
        channel: input.channel,
        reason: input.reason,
        source: 'system',
        note: input.note.slice(0, 200),
        userId: null,
        target: { kind: identity.kind, value: identity.valueNormalized },
      });
      return { created: r.created };
    });
  }
}
